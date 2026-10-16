#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { config } from "./config.js";
import { backfill, decide, label, listPresets, loadPreset } from "./addita.js";
import * as lume from "./lume.js";
import * as ollama from "./ollama.js";
import { store } from "./store.js";
import * as ollaya from "./ollaya.js";
import { startHttpServer } from "./server.js";
import { disagreements, exportDataset, fitCalibration, stats } from "./training.js";

type Result = { content: { type: "text"; text: string }[]; isError?: boolean };
const wrap =
  <A>(fn: (a: A) => Promise<unknown> | unknown) =>
  async (a: A): Promise<Result> => {
    try {
      return { content: [{ type: "text", text: JSON.stringify(await fn(a), null, 2) }] };
    } catch (e: any) {
      return { content: [{ type: "text", text: `Error: ${e?.message ?? e}` }], isError: true };
    }
  };

const answerValue = z.union([z.string(), z.number(), z.boolean()]);
const stateSchema = z.union([z.string(), z.record(z.string(), z.any()), z.array(z.any())]);

export function createMcpServer(): McpServer {
  const server = new McpServer({ name: "addita", version: "0.1.0" });

  // ------------------------------------------------------------ decisions

  server.registerTool(
    "comms_decide",
    {
      title: "Decide on a transmission",
      description:
        "Answer typed questions about a state (a radio transcript, message or JSON). Ollaya answers first; " +
        "when Ollama is online it answers the same questions as a teacher, the pair is saved as training data, " +
        "and the teacher's answer is returned. Deterministic guards (e.g. MAYDAY) override both. " +
        "Returns an id you can pass to comms_label to correct the answer.",
      inputSchema: {
        state: stateSchema.describe(
          'The thing to decide about. For comms, e.g. {"own_callsign":"Charlie Bravo","channel":16,"duration_s":3.2,"transcript":"Charlie Bravo, this is Alpha Tango..."}',
        ),
        context: z.any().optional().describe("Extra context, e.g. recent traffic from Lume; merged into the state as `context`"),
        preset: z.string().optional().describe(`Question set from the presets folder (default "${config.defaultPreset}")`),
        questions: z.record(z.string(), z.any()).optional().describe("Ad-hoc TypeSafe question set; overrides the preset's"),
        model: z.string().optional().describe("Ollaya model (default from the preset, else OLLAYA_MODEL)"),
        teacher: z.enum(["auto", "skip", "require"]).optional().describe("auto: use Ollama if online; skip: Ollaya only; require: fail without Ollama"),
        lume_context: z.boolean().optional().describe("Add related recent traffic from the Lume log as context (default true; works offline)"),
        ref: z.string().optional().describe("Optional caller correlation id"),
        allow_cloud_teacher: z.boolean().optional().describe("Allow a cloud or non-local Ollama teacher for this call (default false)"),
      },
    },
    wrap(decide as any),
  );

  server.registerTool(
    "comms_label",
    {
      title: "Correct a decision",
      description:
        "Record the right answer for a past decision (human gold label). Only some questions need to be given. " +
        "These labels outrank the teacher's in training data and are the only labels used for evaluation.",
      inputSchema: {
        id: z.string(),
        labels: z.record(z.string(), answerValue).describe('e.g. {"addressed_to_us": true, "action": "draft_reply"}'),
        note: z.string().optional(),
        by: z.string().optional(),
      },
    },
    wrap(({ id, labels, by, note }: any) => label(id, labels, by, note)),
  );

  // ------------------------------------------------------------ training

  server.registerTool(
    "training_stats",
    {
      title: "Training data stats",
      description: "Counts and per-question agreement: student vs teacher, and both vs human labels.",
      inputSchema: {},
    },
    wrap(() => stats()),
  );

  server.registerTool(
    "training_disagreements",
    {
      title: "Rows to review",
      description: "Recent unlabelled decisions where Ollaya and Ollama disagree, with the teacher's reasons. Best candidates for comms_label.",
      inputSchema: { limit: z.number().int().min(1).max(100).optional() },
    },
    wrap(({ limit }: any) => disagreements(limit)),
  );

  server.registerTool(
    "training_backfill",
    {
      title: "Teacher-label the backlog",
      description: "When Ollama is back online, ask it to answer stored decisions it missed while offline.",
      inputSchema: { limit: z.number().int().min(1).max(500).optional() },
    },
    wrap(({ limit }: any) => backfill(limit)),
  );

  server.registerTool(
    "training_export",
    {
      title: "Export dataset",
      description:
        "Write train.jsonl and eval.jsonl for fine-tuning the decision model. Labels: human first, then teacher; " +
        "the student never labels itself. eval.jsonl holds only human-labelled rows.",
      inputSchema: {
        eval_fraction: z.number().min(0).max(1).optional().describe("Share of human-labelled rows held out (default 0.3)"),
        include_teacher: z.boolean().optional().describe("Include teacher-labelled rows in train (default true)"),
      },
    },
    wrap(({ eval_fraction, include_teacher }: any) => exportDataset({ evalFraction: eval_fraction, includeTeacher: include_teacher })),
  );

  server.registerTool(
    "training_calibrate",
    {
      title: "Fit calibration",
      description:
        "Temperature-scale the student's stored probabilities against labels, per question-type bucket " +
        "(choice:3-5, noul:2, ...). Returns a multiplier per bucket. Give base_temperatures (the model's current " +
        "temperature_by_options) to get absolute values, and create_model to bake them into a new Ollaya model.",
      inputSchema: {
        include_teacher: z.boolean().optional().describe("Also fit on teacher labels (default false: human only)"),
        min_samples: z.number().int().min(1).optional(),
        base_temperatures: z.record(z.string(), z.number()).optional(),
        create_model: z
          .object({ name: z.string(), from: z.string(), preset: z.string().optional() })
          .optional()
          .describe("Create an Ollaya model with the fitted calibration (and the preset's questions baked in)"),
      },
    },
    wrap(async ({ include_teacher, min_samples, base_temperatures, create_model }: any) => {
      const fit = fitCalibration({ includeTeacher: include_teacher, minSamples: min_samples, baseTemperatures: base_temperatures });
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
  );

  // ------------------------------------------------------------ lume

  server.registerTool(
    "comms_search",
    {
      title: "Search the radio log",
      description:
        "Search every logged transmission and decision in Lume (keyword + callsign graph; works with Ollama offline). " +
        "Lume query syntax works: -term, NOT term, and frontmatter filters such as channel:16, priority:distress, " +
        "action:draft_reply, teacher:pending, labelled:false, own_callsign:\"Charlie Bravo\". " +
        "A query can be filters alone (e.g. \"priority:distress\").",
      inputSchema: {
        query: z.string(),
        limit: z.number().int().min(1).max(100).optional(),
        since_hours: z.number().positive().optional().describe("Only traffic from the last N hours"),
      },
    },
    wrap(async ({ query, limit, since_hours }: any) => {
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
  );

  server.registerTool(
    "lume_sync",
    {
      title: "Rebuild the Lume log",
      description:
        "Re-render every stored decision as a Lume document and reindex now. Use after installing Lume on a box " +
        "that already has data, or after changing LUME_TAG_DICT. Otherwise logging and reindexing are automatic.",
      inputSchema: {},
    },
    wrap(async () => {
      if (!(await lume.version())) throw new Error("Lume is not available");
      let n = 0;
      for (const r of store.joined()) {
        await lume.log(r, r.teacher, r.label);
        n++;
      }
      const idx = await lume.reindex();
      return { documents: n, index: idx };
    }),
  );

  // ------------------------------------------------------------ backends

  server.registerTool(
    "ollama_chat",
    {
      title: "Ollama chat (proxy)",
      description: "Pass-through to Ollama /api/chat, e.g. to draft a radio reply. Not logged as training data.",
      inputSchema: {
        messages: z.array(z.object({ role: z.enum(["system", "user", "assistant"]), content: z.string() })),
        model: z.string().optional().describe(`Default OLLAMA_MODEL (${config.ollamaModel})`),
        format: z.union([z.literal("json"), z.record(z.string(), z.any())]).optional(),
        options: z.record(z.string(), z.any()).optional(),
      },
    },
    wrap(async ({ messages, model, format, options }: any) => {
      if (!(await ollama.isOnline())) throw new Error(`Ollama is offline at ${config.ollamaUrl}`);
      return ollama.chat(messages, { model, format, options });
    }),
  );

  server.registerTool(
    "backends_status",
    {
      title: "Backend status",
      description: "Whether Ollaya and Ollama are reachable, their models, and the teacher mode.",
      inputSchema: {},
    },
    wrap(async () => {
      const [a, b] = await Promise.allSettled([ollaya.status(), ollama.status()]);
      return {
        teacher_mode: config.teacherMode,
        teacher_sees_student: config.teacherSeesStudent,
        allow_cloud_teacher: config.allowCloudTeacher,
        presets: listPresets(),
        lume: (await lume.version())
          ? { version: await lume.version(), docs: config.lume.docsDir, db: config.lume.db, index: lume.indexState() }
          : { available: false, mode: config.lume.mode, bin: config.lume.bin },
        ollaya: a.status === "fulfilled" ? a.value : { url: config.ollayaUrl, error: (a.reason as Error).message },
        ollama: b.status === "fulfilled" ? b.value : { url: config.ollamaUrl, error: (b.reason as Error).message },
      };
    }),
  );

  server.registerTool(
    "ollaya_pull",
    {
      title: "Pull an Ollaya model",
      description: "Download a decision model into Ollaya (e.g. laya, nli, decima:small).",
      inputSchema: { model: z.string() },
    },
    wrap(({ model }: any) => ollaya.pull(model)),
  );

  server.registerTool(
    "presets_show",
    {
      title: "Show a preset",
      description: "List presets, or show one preset's questions and guards.",
      inputSchema: { name: z.string().optional() },
    },
    wrap(({ name }: any) => (name ? loadPreset(name) : { presets: listPresets(), dir: config.presetsDir })),
  );

  return server;
}

let httpServer: import("node:http").Server | undefined;
let httpPort = config.port;

if (config.port >= 0) {
  try {
    const started = await startHttpServer(createMcpServer, { host: config.host, port: config.port });
    httpServer = started.server;
    httpPort = started.port;
  } catch (e: any) {
    if (e?.code === "EADDRINUSE" && process.env.ADDITA_PORT === undefined) {
      const started = await startHttpServer(createMcpServer, { host: config.host, port: 0 });
      httpServer = started.server;
      httpPort = started.port;
    } else {
      throw e;
    }
  }
}

let sawStdinData = false;
process.stdin.on("data", () => {
  sawStdinData = true;
});
process.stdin.on("end", () => {
  if (sawStdinData) {
    httpServer?.close();
    process.exit(0);
  }
});

const stdioServer = createMcpServer();
await stdioServer.connect(new StdioServerTransport());

// Catch the index up with anything logged while the server was down.
if (await lume.version()) lume.scheduleReindex();
console.error(
  `addita: http ${config.host}:${httpPort}, ollaya ${config.ollayaUrl}, ollama ${config.ollamaUrl} (${config.ollamaModel}), data ${config.dataDir}`,
);
