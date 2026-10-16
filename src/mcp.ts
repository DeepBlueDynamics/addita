import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createInterface } from "node:readline";
import { config } from "./config.js";
import { backfill, decide, label, listPresets, loadPreset } from "./addita.js";
import * as lume from "./lume.js";
import * as ollama from "./ollama.js";
import { store } from "./store.js";
import * as ollaya from "./ollaya.js";
import { disagreements, exportDataset, fitCalibration, stats } from "./training.js";
import { ApiError, parseJsonObject } from "./validate.js";

type ToolResult = { content: { type: "text"; text: string }[]; isError?: boolean };

const wrap =
  <A = any>(fn: (a: A) => Promise<unknown> | unknown) =>
  async (a: A): Promise<ToolResult> => {
    try {
      return { content: [{ type: "text", text: JSON.stringify(await fn(a), null, 2) }] };
    } catch (e: any) {
      return { content: [{ type: "text", text: `Error: ${e?.message ?? e}` }], isError: true };
    }
  };

interface ToolDef {
  name: string;
  title: string;
  description: string;
  inputSchema: Record<string, unknown>;
  handler: (args: any) => Promise<ToolResult>;
}

function buildTools(): ToolDef[] {
  return [
    {
      name: "comms_decide",
      title: "Decide on a transmission",
      description:
        "Answer typed questions about a state (a radio transcript, message or JSON). Ollaya answers first; " +
        "when Ollama is online it answers the same questions as a teacher, the pair is saved as training data, " +
        "and the teacher's answer is returned. Deterministic guards (e.g. MAYDAY) override both. " +
        "Returns an id you can pass to comms_label to correct the answer.",
      inputSchema: {
        type: "object",
        properties: {
          state: {
            description:
              'The thing to decide about. For comms, e.g. {"own_callsign":"Charlie Bravo","channel":16,"duration_s":3.2,"transcript":"Charlie Bravo, this is Alpha Tango..."}',
          },
          context: {
            description: "Extra context, e.g. recent traffic from Lume; merged into the state as `context`",
          },
          preset: {
            type: "string",
            description: `Question set from the presets folder (default "${config.defaultPreset}")`,
          },
          questions: {
            type: "object",
            description: "Ad-hoc TypeSafe question set; overrides the preset's",
          },
          model: {
            type: "string",
            description: "Ollaya model (default from the preset, else OLLAYA_MODEL)",
          },
          teacher: {
            type: "string",
            enum: ["auto", "skip", "require"],
            description: "auto: use Ollama if online; skip: Ollaya only; require: fail without Ollama",
          },
          lume_context: {
            type: "boolean",
            description: "Add related recent traffic from the Lume log as context (default true; works offline)",
          },
          ref: {
            type: "string",
            description: "Optional caller correlation id",
          },
          group: {
            type: "string",
            description: "Optional group id for grouped train/eval split (defaults to ref, then decision id)",
          },
          addita: {
            type: "object",
            properties: {
              ref: { type: "string" },
              group: { type: "string" },
            },
            description: "Optional metadata block (ref, group)",
          },
        },
        required: ["state"],
      },
      handler: wrap(decide as any),
    },
    {
      name: "comms_label",
      title: "Correct a decision",
      description:
        "Record the right answer for a past decision (human gold label). Only some questions need to be given. " +
        "These labels outrank the teacher's in training data and are the only labels used for evaluation.",
      inputSchema: {
        type: "object",
        properties: {
          id: { type: "string" },
          labels: {
            type: "object",
            description: 'e.g. {"addressed_to_us": true, "action": "draft_reply"}',
          },
          note: { type: "string" },
          by: { type: "string" },
        },
        required: ["id", "labels"],
      },
      handler: wrap(({ id, labels, by, note }: any) => label(id, labels, by, note)),
    },
    {
      name: "training_stats",
      title: "Training data stats",
      description: "Counts and per-question agreement: student vs teacher, and both vs human labels.",
      inputSchema: { type: "object", properties: {} },
      handler: wrap(() => stats()),
    },
    {
      name: "training_disagreements",
      title: "Rows to review",
      description:
        "Recent unlabelled decisions where Ollaya and Ollama disagree, with the teacher's reasons. Best candidates for comms_label.",
      inputSchema: {
        type: "object",
        properties: {
          limit: { type: "integer", minimum: 1, maximum: 100 },
        },
      },
      handler: wrap(({ limit }: any) => disagreements(limit)),
    },
    {
      name: "training_backfill",
      title: "Teacher-label the backlog",
      description:
        "When Ollama is back online, ask it to answer stored decisions it missed while offline, " +
        "and re-ask the cloud teacher for rows marked cloud-pending.",
      inputSchema: {
        type: "object",
        properties: {
          limit: { type: "integer", minimum: 1, maximum: 500 },
        },
      },
      handler: wrap(({ limit }: any) => backfill(limit)),
    },
    {
      name: "training_export",
      title: "Export dataset",
      description:
        "Write train.jsonl, eval.jsonl, calibration.jsonl, and manifest.json for fine-tuning the decision model. " +
        "Split is decided by sha256(group)[0]/256: [0, eval_fraction) is eval (human labels only; unlabelled rows dropped as held_out_unlabelled), " +
        "[eval_fraction, eval_fraction + calibration_fraction) is calibration, and the rest is train (human > guard > teacher).",
      inputSchema: {
        type: "object",
        properties: {
          eval_fraction: {
            type: "number",
            minimum: 0,
            maximum: 1,
            description: "Share of groups held out for eval (default 0.3; eval_fraction + calibration_fraction must be < 1)",
          },
          calibration_fraction: {
            type: "number",
            minimum: 0,
            maximum: 1,
            description: "Share of groups held out for calibration (default 0; eval_fraction + calibration_fraction must be < 1)",
          },
          include_teacher: {
            type: "boolean",
            description: "Include teacher-labelled rows in train/calibration (default true)",
          },
        },
      },
      handler: wrap(({ eval_fraction, calibration_fraction, include_teacher }: any) =>
        exportDataset({
          evalFraction: eval_fraction,
          calibrationFraction: calibration_fraction,
          includeTeacher: include_teacher,
        }),
      ),
    },
    {
      name: "training_calibrate",
      title: "Fit calibration",
      description:
        "Temperature-scale the student's stored probabilities against labels, per question-type bucket " +
        "(choice:3-5, noul:2, ...). Returns a multiplier per bucket. Give base_temperatures (the model's current " +
        "temperature_by_options) to get absolute values, and create_model to bake them into a new Ollaya model.",
      inputSchema: {
        type: "object",
        properties: {
          include_teacher: {
            type: "boolean",
            description: "Also fit on teacher labels (default false: human only)",
          },
          min_samples: { type: "integer", minimum: 1 },
          base_temperatures: { type: "object" },
          create_model: {
            type: "object",
            properties: {
              name: { type: "string" },
              from: { type: "string" },
              preset: { type: "string" },
            },
            required: ["name", "from"],
            description: "Create an Ollaya model with the fitted calibration (and the preset's questions baked in)",
          },
        },
      },
      handler: wrap(async ({ include_teacher, min_samples, base_temperatures, create_model }: any) => {
        const fit = fitCalibration({
          includeTeacher: include_teacher,
          minSamples: min_samples,
          baseTemperatures: base_temperatures,
        });
        if (!create_model) return fit;
        if (!fit.calibration) throw new Error("nothing to apply: pass base_temperatures for buckets with enough samples");
        const questions = create_model.preset ? loadPreset(create_model.preset).questions : undefined;
        await ollaya.create({
          model: create_model.name,
          from: create_model.from,
          calibration: fit.calibration,
          ...(questions ? { questions } : {}),
          description: "Calibrated by addita",
        });
        return { ...fit, created: create_model.name };
      }),
    },
    {
      name: "comms_search",
      title: "Search the radio log",
      description:
        "Search every logged transmission and decision in Lume (keyword + callsign graph; works with Ollama offline). " +
        "Lume query syntax works: -term, NOT term, and frontmatter filters such as channel:16, priority:distress, " +
        'action:draft_reply, teacher:pending, labelled:false, own_callsign:"Charlie Bravo". ' +
        'A query can be filters alone (e.g. "priority:distress").',
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string" },
          limit: { type: "integer", minimum: 1, maximum: 100 },
          since_hours: { type: "number", description: "Only traffic from the last N hours" },
        },
        required: ["query"],
      },
      handler: wrap(async ({ query, limit, since_hours }: any) => {
        const hits = await lume.search(query, { limit, sinceHours: since_hours });
        const byId = new Map(store.joined().map((r) => [r.id, r]));
        return hits.map((h) => {
          const r = h.id ? byId.get(h.id) : undefined;
          if (!r) return { score: h.score, title: h.title, file: h.file, snippet: h.snippet };
          return {
            score: h.score,
            id: r.id,
            when: r.ts,
            ...(r.meta ?? {}),
            transcript: r.transcript ?? lume.transcriptOf(r.state),
            decision: { ...r.final, ...(r.label?.labels ?? {}) },
            source: r.label ? "human" : r.final_source,
            teacher: r.teacher ? "answered" : "pending",
            guards: r.guards,
          };
        });
      }),
    },
    {
      name: "lume_sync",
      title: "Rebuild the Lume log",
      description:
        "Re-render every stored decision as a Lume document and reindex now. Use after installing Lume on a box " +
        "that already has data, or after changing LUME_TAG_DICT. Otherwise logging and reindexing are automatic.",
      inputSchema: { type: "object", properties: {} },
      handler: wrap(async () => {
        if (!(await lume.version())) throw new Error("Lume is not available");
        let n = 0;
        for (const r of store.joined()) {
          await lume.log(r, r.teacher, r.label);
          n++;
        }
        const idx = await lume.reindex();
        return { documents: n, index: idx };
      }),
    },
    {
      name: "ollama_chat",
      title: "Ollama chat (proxy)",
      description: "Pass-through to Ollama /api/chat, e.g. to draft a radio reply. Not logged as training data.",
      inputSchema: {
        type: "object",
        properties: {
          messages: {
            type: "array",
            items: {
              type: "object",
              properties: {
                role: { type: "string", enum: ["system", "user", "assistant"] },
                content: { type: "string" },
              },
              required: ["role", "content"],
            },
          },
          model: { type: "string", description: `Default OLLAMA_MODEL (${config.ollamaModel})` },
          format: {},
          options: { type: "object" },
        },
        required: ["messages"],
      },
      handler: wrap(async ({ messages, model, format, options }: any) => {
        if (!(await ollama.isOnline())) throw new Error(`Ollama is offline at ${config.ollamaUrl}`);
        return ollama.chat(messages, { model, format, options });
      }),
    },
    {
      name: "backends_status",
      title: "Backend status",
      description: "Whether Ollaya and Ollama are reachable, their models, and the teacher mode.",
      inputSchema: { type: "object", properties: {} },
      handler: wrap(async () => {
        const [a, b] = await Promise.allSettled([ollaya.status(), ollama.status()]);
        return {
          teacher_mode: config.teacherMode,
          teacher_sees_student: config.teacherSeesStudent,
          no_cloud: config.noCloud,
          presets: listPresets(),
          lume: (await lume.version())
            ? { version: await lume.version(), docs: config.lume.docsDir, db: config.lume.db, index: lume.indexState() }
            : { available: false, mode: config.lume.mode, bin: config.lume.bin },
          ollaya: a.status === "fulfilled" ? a.value : { url: config.ollayaUrl, error: (a.reason as Error).message },
          ollama: b.status === "fulfilled" ? b.value : { url: config.ollamaUrl, error: (b.reason as Error).message },
        };
      }),
    },
    {
      name: "ollaya_pull",
      title: "Pull an Ollaya model",
      description: "Download a decision model into Ollaya (e.g. laya, nli, decima:small).",
      inputSchema: {
        type: "object",
        properties: { model: { type: "string" } },
        required: ["model"],
      },
      handler: wrap(({ model }: any) => ollaya.pull(model)),
    },
    {
      name: "presets_show",
      title: "Show a preset",
      description: "List presets, or show one preset's questions and guards.",
      inputSchema: {
        type: "object",
        properties: { name: { type: "string" } },
      },
      handler: wrap(({ name }: any) => (name ? loadPreset(name) : { presets: listPresets(), dir: config.presetsDir })),
    },
  ];
}

const toolsList = buildTools();
const toolsByName = new Map(toolsList.map((t) => [t.name, t]));

async function dispatchRpcMessage(msg: any): Promise<any | null> {
  if (!msg || typeof msg !== "object") {
    return { jsonrpc: "2.0", id: null, error: { code: -32600, message: "Invalid Request" } };
  }
  // Notification or response (no `id`)
  if (!("id" in msg) || msg.id === undefined) {
    return null;
  }
  const id = msg.id;
  const method = msg.method;

  if (method === "initialize") {
    const protocolVersion =
      typeof msg.params?.protocolVersion === "string" ? msg.params.protocolVersion : "2024-11-05";
    return {
      jsonrpc: "2.0",
      id,
      result: {
        protocolVersion,
        capabilities: {
          tools: { listChanged: true },
        },
        serverInfo: {
          name: "addita",
          version: "0.1.0",
        },
      },
    };
  }

  if (method === "ping") {
    return { jsonrpc: "2.0", id, result: {} };
  }

  if (method === "tools/list") {
    return {
      jsonrpc: "2.0",
      id,
      result: {
        tools: toolsList.map(({ name, title, description, inputSchema }) => ({
          name,
          title,
          description,
          inputSchema,
        })),
      },
    };
  }

  if (method === "tools/call") {
    const toolName = msg.params?.name;
    const tool = typeof toolName === "string" ? toolsByName.get(toolName) : undefined;
    if (!tool) {
      return {
        jsonrpc: "2.0",
        id,
        error: { code: -32602, message: `Unknown tool: ${String(toolName)}` },
      };
    }
    const res = await tool.handler(msg.params?.arguments ?? {});
    return {
      jsonrpc: "2.0",
      id,
      result: res,
    };
  }

  return {
    jsonrpc: "2.0",
    id,
    error: { code: -32601, message: `Method not found: ${String(method)}` },
  };
}

export async function startStdioMcpServer(onStdinEnd: () => void): Promise<void> {
  let sawStdinData = false;
  const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
  rl.on("line", (line) => {
    sawStdinData = true;
    const trimmed = line.trim();
    if (!trimmed) return;
    let parsed: any;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      process.stdout.write(
        JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }) + "\n",
      );
      return;
    }
    void (async () => {
      if (Array.isArray(parsed)) {
        const replies = (await Promise.all(parsed.map((m) => dispatchRpcMessage(m)))).filter((r) => r !== null);
        if (replies.length > 0) {
          process.stdout.write(JSON.stringify(replies) + "\n");
        }
      } else {
        const reply = await dispatchRpcMessage(parsed);
        if (reply !== null) {
          process.stdout.write(JSON.stringify(reply) + "\n");
        }
      }
    })();
  });
  rl.on("close", () => {
    if (sawStdinData) {
      onStdinEnd();
    }
  });
}

export function createMcpHttpHandler(helpers: {
  setCommonHeaders: (res: ServerResponse, reqId: string, isV1: boolean, extra?: Record<string, string>) => void;
  readRawBody: (req: IncomingMessage, limit?: number) => Promise<Buffer>;
}) {
  const mcpSessions = new Set<string>();

  return async function handleMcpRequest(req: IncomingMessage, res: ServerResponse, reqId: string) {
    helpers.setCommonHeaders(res, reqId, false);
    const method = (req.method ?? "GET").toUpperCase();
    if (method !== "POST" && method !== "GET" && method !== "DELETE") {
      throw ApiError.methodNotAllowed(method, "/mcp", "GET, POST, DELETE");
    }

    const rawSid = req.headers["mcp-session-id"];
    const sid = Array.isArray(rawSid) ? rawSid[0] : rawSid;

    if (method === "DELETE") {
      if (sid && mcpSessions.has(sid)) {
        mcpSessions.delete(sid);
        res.writeHead(200);
        res.end();
        return;
      }
      throw ApiError.notFound("MCP session not found");
    }

    if (method === "GET") {
      // Streamable HTTP spec allows 405 on GET when server uses direct JSON responses on POST
      throw ApiError.methodNotAllowed("GET", "/mcp", "POST, DELETE");
    }

    const raw = await helpers.readRawBody(req);
    const parsed = parseJsonObject(raw);
    const isInit =
      parsed.method === "initialize" ||
      (Array.isArray(parsed) && parsed.some((m: any) => m?.method === "initialize"));

    let activeSid = sid;
    if (isInit) {
      activeSid = randomUUID();
      mcpSessions.add(activeSid);
    } else if (sid && !mcpSessions.has(sid)) {
      throw ApiError.notFound("MCP session not found");
    }

    const extraHeaders: Record<string, string> = {};
    if (activeSid) {
      extraHeaders["mcp-session-id"] = activeSid;
    }

    if (Array.isArray(parsed)) {
      const replies = (await Promise.all(parsed.map((m) => dispatchRpcMessage(m)))).filter((r) => r !== null);
      if (replies.length === 0) {
        helpers.setCommonHeaders(res, reqId, false, extraHeaders);
        res.writeHead(202);
        res.end();
        return;
      }
      const payload = Buffer.from(JSON.stringify(replies), "utf8");
      helpers.setCommonHeaders(res, reqId, false, {
        ...extraHeaders,
        "content-type": "application/json",
        "content-length": String(payload.byteLength),
      });
      res.writeHead(200);
      res.end(payload);
      return;
    }

    const reply = await dispatchRpcMessage(parsed);
    if (reply === null) {
      helpers.setCommonHeaders(res, reqId, false, extraHeaders);
      res.writeHead(202);
      res.end();
      return;
    }

    const payload = Buffer.from(JSON.stringify(reply), "utf8");
    helpers.setCommonHeaders(res, reqId, false, {
      ...extraHeaders,
      "content-type": "application/json",
      "content-length": String(payload.byteLength),
    });
    res.writeHead(200);
    res.end(payload);
  };
}
