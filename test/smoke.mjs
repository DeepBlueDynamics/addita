// End-to-end: spawn Addita (MCP over stdio + HTTP on ADDITA_PORT + MCP over /mcp) against mock backends and walk the loop.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mockLumeOtlp, mockOllama, mockOllaya } from "./mocks.mjs";

const OLLAYA_PORT = 21435;
const OLLAMA_PORT = 21434;
const LUME_OTLP_PORT = 21436;
const ADDITA_HTTP_PORT = 21345;
const dataDir = mkdtempSync(join(tmpdir(), "addita-test-"));
const lumeServeJson = join(dataDir, "lume-serve.json");
writeFileSync(
  lumeServeJson,
  JSON.stringify({
    service: "lume",
    url: `http://127.0.0.1:${LUME_OTLP_PORT}`,
    port: LUME_OTLP_PORT,
    otlp: true,
    token_file: null,
  }),
);

let ollaya = await mockOllaya(OLLAYA_PORT);
let ollama = await mockOllama(OLLAMA_PORT);
const lumeOtlp = await mockLumeOtlp(LUME_OTLP_PORT);

const client = new Client({ name: "smoke", version: "0" });
await client.connect(
  new StdioClientTransport({
    command: process.execPath,
    args: ["dist/index.js"],
    env: {
      ...process.env,
      ADDITA_HOST: "127.0.0.1",
      ADDITA_PORT: String(ADDITA_HTTP_PORT),
      OLLAYA_URL: `http://127.0.0.1:${OLLAYA_PORT}`,
      OLLAMA_URL: `http://127.0.0.1:${OLLAMA_PORT}`,
      OLLAMA_PROBE_TTL_MS: "0",
      ADDITA_DATA_DIR: dataDir,
      LUME_SERVE_JSON: lumeServeJson,
      LUME_REINDEX_DEBOUNCE_MS: "100",
    },
    stderr: "inherit",
  }),
);

async function call(name, args = {}) {
  const r = await client.callTool({ name, arguments: args });
  const text = r.content[0].text;
  if (r.isError) throw new Error(`${name}: ${text}`);
  return JSON.parse(text);
}

const HTTP_BASE = `http://127.0.0.1:${ADDITA_HTTP_PORT}`;

async function httpJson(path, init = {}) {
  const res = await fetch(`${HTTP_BASE}${path}`, {
    method: init.method ?? (init.body !== undefined ? "POST" : "GET"),
    headers: {
      ...(init.body !== undefined ? { "content-type": "application/json" } : {}),
      ...(init.headers ?? {}),
    },
    body: init.body === undefined ? undefined : typeof init.body === "string" ? init.body : JSON.stringify(init.body),
  });
  const text = await res.text();
  let data;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  return { status: res.status, headers: res.headers, data };
}

function readDecisionsJsonl() {
  const p = join(dataDir, "decisions.jsonl");
  if (!existsSync(p)) return [];
  return readFileSync(p, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}

const ok = (msg) => console.log(`  ✓ ${msg}`);
const hasLume = spawnSync("lume", ["--version"]).status === 0;

/** Wait for the debounced reindex to finish. */
async function indexed() {
  for (let i = 0; i < 100; i++) {
    await new Promise((r) => setTimeout(r, 100));
    const st = await call("backends_status");
    if (st.lume?.index && !st.lume.index.pending && st.lume.index.last?.ok) return st.lume.index.last;
  }
  throw new Error("reindex did not finish");
}
const base = { own_callsign: "Charlie Bravo", channel: 16, duration_s: 3.2 };

try {
  // ------------------------------------------------------------------ Phase 0: MCP over stdio
  const tools = (await client.listTools()).tools.map((t) => t.name);
  assert.ok(tools.includes("comms_decide") && tools.includes("training_export"));
  ok(`${tools.length} tools listed`);

  const st = await call("backends_status");
  assert.equal(st.ollaya.version, "0.13.0-mock");
  assert.equal(st.ollama.online, true);
  assert.equal(st.ollama.teacher_model, "deepseek-v4.1-flash:cloud");
  assert.equal(st.ollama.local_teacher_model, "qwen3.5:4b");
  assert.equal(st.no_cloud, false);
  assert.ok(st.presets.includes("comms") && st.presets.includes("lume.sql_judge"));
  ok("both backends online, default teachers deepseek-v4.1-flash:cloud + qwen3.5:4b, presets discovered");

  // 1. online: student first, cloud teacher answers by default, teacher wins
  const d1 = await call("comms_decide", {
    state: { ...base, transcript: "Charlie Bravo, this is Alpha Tango, come in, over." },
    group: "train-grp-2",
  });
  assert.equal(d1.source, "teacher");
  assert.equal(d1.teacher.model, "deepseek-v4.1-flash:cloud");
  assert.equal(d1.student.answers.priority, "distress"); // mock student picks the first label
  assert.equal(d1.teacher.answers.priority, "noise"); // mock teacher picks the last
  assert.equal(d1.answers.priority, "noise");
  assert.equal(d1.agreement.priority, false);
  assert.equal(d1.agreement.addressed_to_us, true);
  assert.equal(ollama.calls.at(-1).think, false, "teacher call must pass think:false by default");
  ok("online: student ran, cloud teacher answered (think:false) and was returned, agreement recorded");

  // teacher must not see the student by default
  const prompt = ollama.calls.at(-1).messages[1].content;
  assert.ok(!prompt.includes("smaller model"));
  ok("teacher answered blind");

  // 2. guard overrides both
  const d2 = await call("comms_decide", {
    state: { ...base, transcript: "Mayday mayday mayday, Charlie Bravo this is Blue Heron, taking on water" },
    group: "train-grp-3",
  });
  assert.equal(d2.source, "guard");
  assert.deepEqual(d2.guards, ["distress_keyword"]);
  assert.equal(d2.answers.priority, "distress");
  assert.equal(d2.answers.action, "alert_operator");
  ok("MAYDAY guard overrides the models");

  if (hasLume) {
    const idx = await indexed();
    assert.ok(existsSync(join(dataDir, "lume-docs", d1.id.length ? new Date().toISOString().slice(0, 10) : "", `${d1.id}.md`)));
    ok(`Lume: decisions written as docs and indexed (${idx.message})`);
  }

  // 3. offline: student only, row kept for backfill; Lume still logs and supplies context
  await new Promise((r) => ollama.server.close(r));
  const d3 = await call("comms_decide", {
    state: { ...base, transcript: "Charlie Bravo, I need a wind check." },
    group: "eval-grp-9",
  });
  assert.equal(d3.source, "student");
  assert.equal(d3.teacher.status, "offline");
  ok("offline: falls back to Ollaya");

  if (hasLume) {
    assert.ok(d3.lume.context_items >= 1, JSON.stringify(d3.lume));
    const seen = ollaya.decides.at(-1).state;
    assert.ok(seen.context.recent_traffic.some((t) => t.transcript.includes("Alpha Tango")));
    assert.deepEqual(d3.guards, [], "a MAYDAY in context must not trip the guard");
    ok(`offline: Lume gave Ollaya ${d3.lume.context_items} related past transmission(s); guards ignore context`);

    await indexed();
    const pend = await call("comms_search", { query: "wind check teacher:pending" });
    assert.equal(pend[0].id, d3.id);
    assert.equal(pend[0].teacher, "pending");
    assert.equal(pend[0].channel, 16);
    const mayday = await call("comms_search", { query: "priority:distress", since_hours: 1 });
    assert.ok(mayday.some((h) => h.id === d2.id && h.guards.includes("distress_keyword")));
    ok("offline: comms_search finds traffic, filters on frontmatter (teacher:pending, priority:distress)");
  }

  await assert.rejects(call("comms_decide", { state: "x", teacher: "require" }), /teacher required/);
  ok("teacher=require fails cleanly when offline");

  // 4. human label
  const l = await call("comms_label", { id: d3.id, labels: { intent: "info_request", action: "draft_reply", addressed_to_us: true } });
  assert.equal(l.labels.intent, "info_request");
  assert.equal(l.source, "human");
  await assert.rejects(call("comms_label", { id: d3.id, labels: { intent: "pancakes" } }), /not a valid answer/);
  ok("labels recorded and validated");

  // 5. back online: backfill
  ollama = await mockOllama(OLLAMA_PORT);
  const bf = await call("training_backfill", {});
  assert.ok(bf.labelled >= 1, JSON.stringify(bf));
  assert.equal(bf.remaining, 0);
  ok(`backfill labelled ${bf.labelled} row(s) once Ollama returned`);

  if (hasLume) {
    await indexed();
    const after = await call("comms_search", { query: "wind check" });
    const hit = after.find((h) => h.id === d3.id);
    assert.equal(hit.teacher, "answered");
    assert.equal(hit.source, "human");
    assert.equal(hit.decision.intent, "info_request");
    const doc = readFileSync(join(dataDir, "lume-docs", d3.when?.slice(0, 10) ?? new Date().toISOString().slice(0, 10), `${d3.id}.md`), "utf8");
    assert.match(doc, /Corrected by operator/);
    assert.match(doc, /Teacher reasons/);
    ok("Lume doc rewritten after backfill and label: teacher answered, human correction searchable");
  }

  // 6. stats / review / export / calibration
  const s = await call("training_stats");
  assert.equal(s.decisions, 3);
  assert.equal(s.with_teacher, 3);
  assert.equal(s.human_labelled, 1);
  assert.equal(s.guard_hits.distress_keyword, 1);
  assert.deepEqual(s.final_source, { human: 1, teacher: 1, guard: 1 });
  assert.deepEqual(s.label_source, { human: 3, teacher: 10, guard: 2 });
  assert.equal(s.by_teacher["deepseek-v4.1-flash:cloud"].decisions, 3);
  ok(`stats: ${JSON.stringify(s.questions.priority)}, sources: ${JSON.stringify(s.label_source)}`);

  const dis = await call("training_disagreements", { limit: 5 });
  assert.ok(dis.length >= 1 && dis[0].diff.priority.reason);
  ok(`${dis.length} disagreement(s) to review`);

  const ex = await call("training_export", { eval_fraction: 0.3 });
  assert.equal(ex.eval, 1);
  assert.equal(ex.train, 2);
  assert.equal(ex.calibration, 0);
  assert.equal(ex.eval_groups, 1);
  assert.equal(ex.train_groups, 2);
  assert.equal(ex.calibration_groups, 0);
  assert.equal(ex.held_out_unlabelled, 0);
  assert.deepEqual(ex.groups, { train: 2, eval: 1, calibration: 0 });
  const evalRow = JSON.parse(readFileSync(join(ex.dir, "eval.jsonl"), "utf8").trim());
  assert.equal(evalRow.label_source.intent, "human");
  assert.equal(evalRow.labels.priority, undefined);
  assert.ok(Object.values(evalRow.label_source).every((v) => v === "human"));
  assert.equal(evalRow.teacher_labels, undefined);
  assert.equal(evalRow.group, "eval-grp-9");
  assert.equal(evalRow.preset, "comms");
  assert.equal(evalRow.teacher_model, "deepseek-v4.1-flash:cloud");
  assert.equal(typeof evalRow.created_at, "string");

  const trainRows = readFileSync(join(ex.dir, "train.jsonl"), "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  const guardTrainRow = trainRows.find((r) => r.id === d2.id);
  assert.ok(guardTrainRow, "guard row d2 must be exported in train.jsonl");
  assert.equal(guardTrainRow.labels.priority, "distress");
  assert.equal(guardTrainRow.labels.action, "alert_operator");
  assert.equal(guardTrainRow.label_source.priority, "guard");
  assert.equal(guardTrainRow.label_source.action, "guard");
  assert.equal(guardTrainRow.label_source.addressed_to_us, "teacher");
  assert.deepEqual(guardTrainRow.guard_overrides, {
    priority: "distress_keyword",
    action: "distress_keyword",
  });
  assert.equal(guardTrainRow.teacher_labels.priority, "noise");
  assert.equal(guardTrainRow.teacher_labels.action, "alert_operator");
  assert.equal(guardTrainRow.group, "train-grp-3");
  assert.equal(guardTrainRow.preset, "comms");
  assert.equal(guardTrainRow.teacher_model, "deepseek-v4.1-flash:cloud");
  ok("export: eval carries human-only labels (no teacher keys), guard row exported as 'guard' with teacher_labels kept");

  const cal = await call("training_calibrate", {
    include_teacher: true,
    min_samples: 1,
    base_temperatures: { "choice:3-5": 1.5, "choice:6-10": 1.2, "noul:2": 1.0, "score:3-5": 1.3 },
    create_model: { name: "comms-cal", from: "laya", preset: "comms" },
  });
  assert.equal(cal.created, "comms-cal");
  assert.ok(ollaya.created[0].calibration.temperature_by_options);
  assert.ok(ollaya.created[0].questions.priority);
  ok(`calibration fitted and baked into comms-cal: ${JSON.stringify(cal.calibration.temperature_by_options)}`);

  // 7. proxy
  const chat = await call("ollama_chat", { messages: [{ role: "user", content: "Draft a reply to Alpha Tango" }] });
  assert.match(chat.content, /Alpha Tango/);
  ok("ollama_chat proxy");

  // ------------------------------------------------------------------ Phase 1: HTTP API, Validation, Cloud/Local Teachers, OTLP, /mcp

  // 8. serve.json discovery file + permissions
  const servePath = join(dataDir, "serve.json");
  assert.ok(existsSync(servePath), "serve.json must exist");
  const serveData = JSON.parse(readFileSync(servePath, "utf8"));
  assert.equal(serveData.service, "addita");
  assert.equal(serveData.port, ADDITA_HTTP_PORT);
  assert.equal(serveData.url, `http://127.0.0.1:${ADDITA_HTTP_PORT}`);
  assert.equal(serveData.version, "0.1.0");
  assert.equal(serveData.token_file, null);
  const mode = statSync(servePath).mode & 0o777;
  assert.equal(mode, 0o600, `serve.json mode should be 0600, got ${mode.toString(8)}`);
  ok("serve.json written atomically with mode 0600");

  // 9. GET /, HEAD /, GET /health, GET /api/version, X-Request-Id echoing
  const rootRes = await httpJson("/", { headers: { "x-request-id": "req-test-123" } });
  assert.equal(rootRes.status, 200);
  assert.equal(rootRes.data, "Ollaya is running");
  assert.equal(rootRes.headers.get("x-request-id"), "req-test-123");

  const healthRes = await httpJson("/health");
  assert.equal(healthRes.status, 200);
  assert.equal(healthRes.data.service, "addita");
  assert.equal(healthRes.data.version, "0.1.0");
  assert.equal(healthRes.data.ready, true);
  assert.equal(healthRes.data.ollaya, true);
  assert.equal(healthRes.data.ollama, true);

  const verRes = await httpJson("/api/version");
  assert.equal(verRes.status, 200);
  assert.equal(verRes.data.service, "addita");
  assert.equal(verRes.data.version, "0.1.0");
  ok("GET /, /health (with readiness), /api/version and X-Request-Id header echoing");

  // 10. POST /api/decide with lume.sql_judge preset + verbatim student answers + addita block + done_reason: "decide" + timings
  const sqlJudgeRes = await httpJson("/api/decide", {
    body: {
      model: "laya",
      preset: "lume.sql_judge",
      state: {
        question: "How many rows are in telemetry?",
        sql: "SELECT count(*) AS n FROM telemetry",
        rows: [{ n: 42 }],
        answer: "There are 42 rows.",
      },
      extras: ["laya"],
      addita: { ref: "ti:q_9f3a", allow_cloud_teacher: false }, // unknown addita field is harmlessly ignored
    },
  });
  assert.equal(sqlJudgeRes.status, 200);
  assert.equal(sqlJudgeRes.data.done_reason, "decide");
  assert.equal(sqlJudgeRes.data.eval_duration, 1_100_000, "eval_duration must preserve student's eval_duration");
  assert.ok(
    sqlJudgeRes.data.total_duration >= sqlJudgeRes.data.eval_duration &&
      sqlJudgeRes.data.total_duration !== 1_200_000,
    `total_duration (${sqlJudgeRes.data.total_duration}) must be Addita's actual wall time, not copied from student (1_200_000)`,
  );
  assert.equal(sqlJudgeRes.data.answers.rows_answer_question.type, "noul");
  assert.equal(typeof sqlJudgeRes.data.answers.rows_answer_question.noul, "number");
  assert.ok(sqlJudgeRes.data.answers.rows_answer_question.laya);
  assert.equal(sqlJudgeRes.data.addita.ref, "ti:q_9f3a");
  assert.equal(sqlJudgeRes.data.addita.source, "teacher");
  assert.equal(sqlJudgeRes.data.addita.teacher, "answered");
  assert.equal(sqlJudgeRes.data.addita.teacher_model, "deepseek-v4.1-flash:cloud");
  assert.equal(sqlJudgeRes.data.addita.teacher_host, "ollama.com");
  assert.equal(sqlJudgeRes.data.addita.final.rows_answer_question, true);
  assert.equal(sqlJudgeRes.data.addita.final.answer_supported, true);
  assert.ok(sqlJudgeRes.data.addita.teacher_answers);
  assert.equal(typeof sqlJudgeRes.data.addita.student_ms, "number");
  assert.equal(typeof sqlJudgeRes.data.addita.teacher_ms, "number");
  ok("POST /api/decide (lume.sql_judge): verbatim student answers + done_reason='decide' + wall total_duration + student_ms/teacher_ms + addita block");

  // 11. GET /api/addita/decision/:id and POST /api/addita/label
  const decId = sqlJudgeRes.data.addita.id;
  const poll1 = await httpJson(`/api/addita/decision/${decId}`);
  assert.equal(poll1.status, 200);
  assert.equal(poll1.data.id, decId);
  assert.equal(poll1.data.ref, "ti:q_9f3a");
  assert.equal(poll1.data.source, "teacher");

  const labelHttp = await httpJson("/api/addita/label", {
    body: {
      id: decId,
      labels: { answer_supported: false },
      by: "vole",
      note: "hallucinated unit",
    },
  });
  assert.equal(labelHttp.status, 200);
  assert.equal(labelHttp.data.source, "human");
  assert.equal(labelHttp.data.final.answer_supported, false);

  const poll2 = await httpJson(`/api/addita/decision/${decId}`);
  assert.equal(poll2.status, 200);
  assert.equal(poll2.data.source, "human");
  assert.equal(poll2.data.final.answer_supported, false);
  ok("GET /api/addita/decision/:id and POST /api/addita/label update final to human");

  // 12. POST /v1/systemone and POST /v1/decisions (pure TypeSafe shape, embedded questions, STATE_TRUNCATED durable row, MODEL_NOT_FOUND)
  const v1Res = await httpJson("/v1/systemone", {
    headers: { "x-request-id": "v1-req-42" },
    body: {
      model: "laya",
      state: "Charlie Bravo, radio check",
      questions: {
        addressed: { type: "noul", instructions: "Is it addressed to Charlie Bravo?" },
      },
      extras: ["laya"], // ignored on /v1/*
    },
  });
  assert.equal(v1Res.status, 200);
  assert.equal(v1Res.headers.get("x-typesafe-request-id"), "v1-req-42");
  assert.deepEqual(Object.keys(v1Res.data).sort(), ["answers", "model", "usage"]);
  assert.equal(v1Res.data.answers.addressed.laya, undefined);
  assert.equal(v1Res.data.addita, undefined);

  const v1DecRes = await httpJson("/v1/decisions", {
    body: {
      model: "laya",
      state: "Charlie Bravo, radio check",
      questions: {
        addressed: { type: "noul", instructions: "Is it addressed to Charlie Bravo?" },
      },
    },
  });
  assert.equal(v1DecRes.status, 200);
  assert.deepEqual(Object.keys(v1DecRes.data).sort(), ["answers", "model", "usage"]);

  // /v1/decisions with omitted `questions` falls back to model's embedded questions via /api/show
  const v1EmbeddedRes = await httpJson("/v1/decisions", {
    body: {
      model: "embedded-model",
      state: "Charlie Bravo, embedded check",
    },
  });
  assert.equal(v1EmbeddedRes.status, 200);
  assert.equal(v1EmbeddedRes.data.answers.embedded_q.type, "noul");

  // /v1/systemone with missing model -> 404 MODEL_NOT_FOUND
  const v1MissingModel = await httpJson("/v1/systemone", {
    body: {
      model: "missing-model",
      state: "hello",
      questions: { q1: { type: "noul" } },
    },
  });
  assert.equal(v1MissingModel.status, 404);
  assert.equal(v1MissingModel.data.code, "MODEL_NOT_FOUND");

  // STATE_TRUNCATED on /v1/systemone returns 422 STATE_TRUNCATED AND persists DecisionRow
  const truncV1 = await httpJson("/v1/systemone", {
    body: {
      model: "laya",
      state: "please __truncate__ this state",
      questions: { q1: { type: "noul" } },
      addita: { ref: "v1-truncated-ref" },
    },
  });
  assert.equal(truncV1.status, 422);
  assert.equal(truncV1.data.code, "STATE_TRUNCATED");
  const truncRow = readDecisionsJsonl().find((r) => r.ref === "v1-truncated-ref");
  assert.ok(truncRow, "DecisionRow must be persisted even when /v1 returns 422 STATE_TRUNCATED");
  assert.equal(truncRow.teacher_status, "answered");
  ok("/v1/systemone and /v1/decisions: pure {model, answers, usage}, embedded questions, MODEL_NOT_FOUND, and durable row on 422 STATE_TRUNCATED");

  // 13. Cloud fails -> local answers (cloud_pending: true), then backfill re-asks cloud once it's up
  ollama.state.failCloud = true;
  const callsBeforeFail = ollama.calls.length;
  const cloudFailedFallback = await httpJson("/api/decide", {
    body: {
      model: "laya",
      preset: "lume.sql_judge",
      state: { question: "q", sql: "SELECT 42", rows: [42], answer: "42" },
      addita: { ref: "cloud-pending-ref" },
    },
  });
  assert.equal(cloudFailedFallback.status, 200);
  assert.equal(cloudFailedFallback.data.addita.teacher, "answered");
  assert.equal(cloudFailedFallback.data.addita.teacher_model, "qwen3.5:4b");
  assert.equal(cloudFailedFallback.data.addita.teacher_host, `127.0.0.1:${OLLAMA_PORT}`);
  assert.equal(cloudFailedFallback.data.addita.cloud_pending, true);
  assert.equal(cloudFailedFallback.data.addita.source, "teacher");
  assert.equal(ollama.calls.length, callsBeforeFail + 2, "must try cloud first then fall back to local immediately");
  assert.equal(ollama.calls.at(-2).model, "deepseek-v4.1-flash:cloud");
  assert.equal(ollama.calls.at(-1).model, "qwen3.5:4b");

  // Now cloud is back up -> backfill re-asks cloud for the cloud-pending row
  ollama.state.failCloud = false;
  const callsBeforeCloudBackfill = ollama.calls.length;
  const bfCloud = await call("training_backfill", {});
  assert.equal(bfCloud.labelled, 1, "backfill must re-ask cloud for the cloud-pending row");
  assert.equal(bfCloud.remaining, 0);
  assert.equal(ollama.calls.length, callsBeforeCloudBackfill + 1);
  assert.equal(ollama.calls.at(-1).model, "deepseek-v4.1-flash:cloud");

  // Poll the decision: teacher_model is now the cloud teacher and cloud_pending is cleared
  const pollAfterCloudBackfill = await httpJson(`/api/addita/decision/${cloudFailedFallback.data.addita.id}`);
  assert.equal(pollAfterCloudBackfill.status, 200);
  assert.equal(pollAfterCloudBackfill.data.teacher_model, "deepseek-v4.1-flash:cloud");
  assert.equal(pollAfterCloudBackfill.data.cloud_pending, undefined);
  ok("cloud fails -> local teacher answers immediately (cloud_pending), then backfill upgrades to cloud once it's up");

  // 14. ADDITA_NO_CLOUD=true -> zero cloud calls, including backfill
  const noCloudDataDir = mkdtempSync(join(tmpdir(), "addita-nocloud-"));
  const noCloudClient = new Client({ name: "smoke-nocloud", version: "0" });
  await noCloudClient.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: ["dist/index.js"],
      env: {
        ...process.env,
        ADDITA_HOST: "127.0.0.1",
        ADDITA_PORT: "0",
        ADDITA_NO_CLOUD: "true",
        OLLAYA_URL: `http://127.0.0.1:${OLLAYA_PORT}`,
        OLLAMA_URL: `http://127.0.0.1:${OLLAMA_PORT}`,
        OLLAMA_PROBE_TTL_MS: "0",
        ADDITA_DATA_DIR: noCloudDataDir,
        LUME_SERVE_JSON: lumeServeJson,
      },
      stderr: "ignore",
    }),
  );
  try {
    const callNoCloud = async (name, args = {}) => {
      const r = await noCloudClient.callTool({ name, arguments: args });
      if (r.isError) throw new Error(r.content[0].text);
      return JSON.parse(r.content[0].text);
    };
    const callsStart = ollama.calls.length;
    const ncLive = await callNoCloud("comms_decide", {
      state: { ...base, transcript: "Charlie Bravo, local-only check." },
    });
    assert.equal(ncLive.teacher.model, "qwen3.5:4b");
    assert.equal(ollama.calls.length, callsStart + 1);
    assert.equal(ollama.calls.at(-1).model, "qwen3.5:4b", "ADDITA_NO_CLOUD=true must never call cloud on live decide");

    // Take Ollama offline, record a pending row, bring Ollama back, run backfill under ADDITA_NO_CLOUD=true
    await new Promise((r) => ollama.server.close(r));
    const ncOffline = await callNoCloud("comms_decide", {
      state: { ...base, transcript: "Charlie Bravo, offline local-only row." },
    });
    assert.equal(ncOffline.teacher.status, "offline");
    ollama = await mockOllama(OLLAMA_PORT);

    const callsBeforeNcBf = ollama.calls.length;
    const ncBf = await callNoCloud("training_backfill", {});
    assert.equal(ncBf.labelled, 1);
    assert.equal(ollama.calls.length, callsBeforeNcBf + 1);
    assert.equal(ollama.calls.at(-1).model, "qwen3.5:4b", "ADDITA_NO_CLOUD=true must never call cloud on backfill");
    const anyCloudCalls = ollama.calls.slice(callsBeforeNcBf).filter((c) => String(c.model).includes("cloud"));
    assert.equal(anyCloudCalls.length, 0);
  } finally {
    await noCloudClient.close();
    rmSync(noCloudDataDir, { recursive: true, force: true });
  }
  ok("ADDITA_NO_CLOUD=true -> zero cloud calls on both live decisions and backfill");

  // 15. Outage resilience & #5 error propagation: Ollaya down (/api/decide degrades, /v1 and lifecycle return 503), both down
  await new Promise((r) => ollaya.server.close(r));

  // #5: Lifecycle request on /api/decide when Ollaya is down must NOT fabricate a 200 load response
  const lifecycleDown = await httpJson("/api/decide", {
    body: { model: "laya", keep_alive: "5m" },
  });
  assert.equal(lifecycleDown.status, 503);
  assert.equal(lifecycleDown.data.code, "INTERNAL");

  // #5: /v1/systemone when Ollaya is down must return 503 INTERNAL (never an empty 200) while still persisting the DecisionRow
  const v1Down = await httpJson("/v1/systemone", {
    body: {
      model: "laya",
      state: "Charlie Bravo, v1 while ollaya down",
      questions: { q1: { type: "noul" } },
      addita: { ref: "v1-ollaya-down" },
    },
  });
  assert.equal(v1Down.status, 503);
  assert.equal(v1Down.data.code, "INTERNAL");
  const v1DownRow = readDecisionsJsonl().find((r) => r.ref === "v1-ollaya-down");
  assert.ok(v1DownRow, "DecisionRow must be persisted when /v1 fails due to Ollaya outage");
  assert.equal(v1DownRow.final_source, "teacher");

  const studentDown = await httpJson("/api/decide", {
    body: {
      model: "laya",
      preset: "comms",
      state: { ...base, transcript: "Charlie Bravo, position report" },
    },
  });
  assert.equal(studentDown.status, 200);
  assert.deepEqual(studentDown.data.answers, {});
  assert.equal(studentDown.data.addita.source, "teacher");
  assert.equal(studentDown.data.addita.teacher, "answered");

  await new Promise((r) => ollama.server.close(r));
  const bothDownGuard = await httpJson("/api/decide", {
    body: {
      model: "laya",
      preset: "comms",
      state: { ...base, transcript: "MAYDAY MAYDAY sinking fast" },
    },
  });
  assert.equal(bothDownGuard.status, 200);
  assert.deepEqual(bothDownGuard.data.answers, {});
  assert.equal(bothDownGuard.data.addita.source, "guard");
  assert.deepEqual(bothDownGuard.data.addita.guards, ["distress_keyword"]);
  assert.equal(bothDownGuard.data.addita.final.priority, "distress");

  const bothDownNone = await httpJson("/api/decide", {
    body: {
      model: "laya",
      preset: "lume.sql_judge",
      state: { question: "q", sql: "SELECT 1", rows: [1] },
    },
  });
  assert.equal(bothDownNone.status, 200);
  assert.deepEqual(bothDownNone.data.answers, {});
  assert.equal(bothDownNone.data.addita.source, "none");
  assert.equal(bothDownNone.data.addita.teacher, "pending");

  ollaya = await mockOllaya(OLLAYA_PORT);
  ollama = await mockOllama(OLLAMA_PORT);
  ok("outage resilience: /api/decide degrades cleanly, /v1 and lifecycle return 503 INTERNAL when Ollaya is down");

  // 16. Upstream boundary validation & error codes (INVALID_JSON, INVALID_REQUEST, NOT_FOUND, METHOD_NOT_ALLOWED, NOT_IMPLEMENTED)
  const err400Empty = await httpJson("/api/decide", { method: "POST", body: "" });
  assert.equal(err400Empty.status, 400);
  assert.equal(err400Empty.data.code, "INVALID_JSON");

  const err400Array = await httpJson("/api/decide", { method: "POST", body: "[1,2,3]" });
  assert.equal(err400Array.status, 400);
  assert.equal(err400Array.data.code, "INVALID_JSON");

  const err405 = await httpJson("/api/decide", { method: "GET" });
  assert.equal(err405.status, 405);
  assert.equal(err405.data.code, "METHOD_NOT_ALLOWED");
  assert.equal(err405.headers.get("allow"), "POST");

  const err404Gen = await httpJson("/api/generate", { body: {} });
  assert.equal(err404Gen.status, 404);
  assert.equal(err404Gen.data.code, "NOT_FOUND");
  assert.match(err404Gen.data.error, /POST \/api\/decide/);

  const err422Stream = await httpJson("/api/decide", {
    body: { model: "laya", state: "hi", preset: "comms", stream: true },
  });
  assert.equal(err422Stream.status, 422);
  assert.equal(err422Stream.data.code, "INVALID_REQUEST");
  assert.equal(err422Stream.data.detail[0].type, "stream_unsupported");

  const err422Mutual = await httpJson("/api/decide", {
    body: {
      model: "laya",
      state: "hi",
      preset: "comms",
      questions: { q: { type: "noul" } },
    },
  });
  assert.equal(err422Mutual.status, 422);
  assert.equal(err422Mutual.data.code, "INVALID_REQUEST");
  assert.deepEqual(err422Mutual.data.detail[0].loc, ["body", "preset"]);

  const err422Tag = await httpJson("/api/decide", {
    body: {
      model: "laya",
      state: "hi",
      questions: { q: { type: "bogus" } },
    },
  });
  assert.equal(err422Tag.status, 422);
  assert.equal(err422Tag.data.code, "INVALID_REQUEST");
  assert.equal(err422Tag.data.detail[0].type, "union_tag_invalid");
  assert.deepEqual(err422Tag.data.detail[0].loc, ["body", "questions", "q"]);

  const err501Push = await httpJson("/api/push", { body: { model: "laya" } });
  assert.equal(err501Push.status, 501);
  assert.equal(err501Push.data.code, "NOT_IMPLEMENTED");

  const err501Blob = await httpJson("/api/blobs/sha256:deadbeef", { method: "HEAD" });
  assert.equal(err501Blob.status, 501);
  ok("boundary validation & error codes (INVALID_JSON, INVALID_REQUEST, MODEL_NOT_FOUND, NOT_IMPLEMENTED) match upstream contract");

  // 17. Forwarded endpoints & NDJSON streaming passthrough
  const tagsRes = await httpJson("/api/tags");
  assert.equal(tagsRes.status, 200);
  assert.equal(tagsRes.data.models[0].name, "laya:latest");

  const presetsRes = await httpJson("/api/presets");
  assert.equal(presetsRes.status, 200);
  assert.ok(presetsRes.data.presets.some((p) => p.name === "lume.sql_judge"));

  const presetShowRes = await httpJson("/api/presets/show", { body: { name: "lume.sql_judge" } });
  assert.equal(presetShowRes.status, 200);
  assert.ok(presetShowRes.data.questions.rows_answer_question);

  const pullStreamRes = await fetch(`${HTTP_BASE}/api/pull`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "laya", stream: true }),
  });
  assert.equal(pullStreamRes.status, 200);
  assert.match(pullStreamRes.headers.get("content-type") ?? "", /application\/x-ndjson/);
  const pullLines = (await pullStreamRes.text()).trim().split("\n").map((l) => JSON.parse(l));
  assert.equal(pullLines.at(-1).status, "success");
  ok("forwarded Ollaya endpoints + NDJSON streaming passthrough (/api/pull)");

  // 18. OTLP /v1/logs and /v1/metrics verification
  await new Promise((r) => setTimeout(r, 100));
  assert.ok(lumeOtlp.logs.length >= 2, `expected OTLP logs, got ${lumeOtlp.logs.length}`);
  assert.ok(lumeOtlp.metrics.length >= 1, `expected OTLP metrics, got ${lumeOtlp.metrics.length}`);
  const allLogRecords = lumeOtlp.logs.flatMap((l) => l.resourceLogs?.[0]?.scopeLogs?.[0]?.logRecords ?? []);
  const attrMap = (rec) =>
    Object.fromEntries((rec.attributes ?? []).map((a) => [a.key, a.value.stringValue ?? a.value.boolValue ?? a.value.intValue ?? a.value.doubleValue ?? a.value.kvlistValue ?? a.value.arrayValue]));
  const decisionEvents = allLogRecords.map(attrMap).filter((a) => a["event.name"] === "addita.decision");
  const labelEvents = allLogRecords.map(attrMap).filter((a) => a["event.name"] === "addita.label");
  const finalEvents = allLogRecords.map(attrMap).filter((a) => a["event.name"] === "addita.decision.final");
  assert.ok(decisionEvents.some((e) => e.ref === "ti:q_9f3a" && e.preset === "lume.sql_judge"));
  assert.ok(labelEvents.some((e) => e.id === decId && e.by === "vole"));
  assert.ok(finalEvents.length >= 1, "backfill should emit addita.decision.final");
  const metricNames = new Set(
    lumeOtlp.metrics.flatMap((m) => (m.resourceMetrics?.[0]?.scopeMetrics?.[0]?.metrics ?? []).map((x) => x.name)),
  );
  assert.ok(metricNames.has("addita.decide.ms") && metricNames.has("addita.decide.count"));
  ok("OTLP /v1/logs (addita.decision, addita.decision.final, addita.label) and /v1/metrics verified");

  // 19. Streamable HTTP MCP transport on /mcp
  const httpMcpClient = new Client({ name: "smoke-http", version: "0" });
  await httpMcpClient.connect(new StreamableHTTPClientTransport(new URL(`${HTTP_BASE}/mcp`)));
  const httpTools = (await httpMcpClient.listTools()).tools.map((t) => t.name);
  assert.ok(httpTools.includes("comms_decide") && httpTools.includes("presets_show"));
  const judgePresetViaMcp = await httpMcpClient.callTool({ name: "presets_show", arguments: { name: "lume.sql_judge" } });
  const judgePresetParsed = JSON.parse(judgePresetViaMcp.content[0].text);
  assert.ok(judgePresetParsed.questions.rows_answer_question);
  await httpMcpClient.close();
  ok("MCP over Streamable HTTP (/mcp) connected and executed tools");

  // 19b. P2 grouped split (pure group hash), held_out_unlabelled, calibration_fraction, manifest.json, teacher_model null when unanswered, and human-over-guard
  // Default chain: sqlJudgeRes had ref="ti:q_9f3a" and no explicit group -> group defaults to ref
  assert.equal(sqlJudgeRes.data.addita.group, "ti:q_9f3a");
  assert.equal(poll2.data.group, "ti:q_9f3a");

  // Fix 1 test: "eval-grp-9" hashes to 0.1796875 (< 0.3 eval band) and already has 1 partially human-labelled row (d3).
  // Add 1 teacher-only row to "eval-grp-9": expect eval=1 row, train=0 rows from "eval-grp-9", and held_out_unlabelled incremented.
  const evalGrpTeacherOnly = await call("comms_decide", {
    preset: "lume.sql_judge",
    state: { question: "Eval group teacher-only?", sql: "SELECT 9", rows: [9], answer: "9" },
    group: "eval-grp-9",
  });
  assert.equal(evalGrpTeacherOnly.group, "eval-grp-9");

  // Fix 2 test: "cal-grp-10" hashes to 0.41015625 (in [0.3, 0.5) calibration band when eval=0.3, cal=0.2)
  const calGroup = "cal-grp-10";
  const calRow1 = await httpJson("/api/decide", {
    body: {
      model: "laya",
      preset: "lume.sql_judge",
      state: { question: "Cal Q1?", sql: "SELECT 10", rows: [10], answer: "10" },
      addita: { ref: "cal-ref-1", group: calGroup },
    },
  });
  const calRow2 = await call("comms_decide", {
    preset: "lume.sql_judge",
    state: { question: "Cal Q2?", sql: "SELECT 11", rows: [11], answer: "11" },
    ref: "cal-ref-2",
    group: calGroup,
  });
  assert.equal(calRow1.data.addita.group, calGroup);
  assert.equal(calRow2.group, calGroup);

  // Two rows sharing a train group "train-grp-6" (hashes to 0.93359375 >= 0.5)
  const sharedTrainGroup = "train-grp-6";
  const grpHttpRes = await httpJson("/api/decide", {
    body: {
      model: "laya",
      preset: "lume.sql_judge",
      state: { question: "Q1?", sql: "SELECT 1", rows: [1], answer: "1" },
      addita: { ref: "grp-ref-1", group: sharedTrainGroup },
    },
  });
  const grpMcpRes = await call("comms_decide", {
    preset: "lume.sql_judge",
    state: { question: "Q2?", sql: "SELECT 2", rows: [2], answer: "2" },
    ref: "grp-ref-2",
    group: sharedTrainGroup,
  });
  await call("comms_label", { id: grpHttpRes.data.addita.id, labels: { rows_answer_question: true } });

  // Fix 4 test: row where no teacher answered (teacher="skip"), partially human-labelled -> teacher_model must be null, missing label stays undefined
  const noTeacherRow = await call("comms_decide", {
    preset: "lume.sql_judge",
    state: { question: "No teacher?", sql: "SELECT 0", rows: [0], answer: "0" },
    teacher: "skip",
    group: "train-grp-7", // hashes to 0.9140625 >= 0.5
  });
  await call("comms_label", { id: noTeacherRow.id, labels: { rows_answer_question: true } });

  // Human-over-guard precedence: label `action` on the MAYDAY guard row d2 ("train-grp-3")
  await call("comms_label", { id: d2.id, labels: { action: "draft_reply" } });

  // Validate that eval_fraction + calibration_fraction >= 1 is rejected
  await assert.rejects(
    call("training_export", { eval_fraction: 0.8, calibration_fraction: 0.2 }),
    /must be less than 1/,
  );
  await assert.rejects(call("training_export", { eval_fraction: 1 }), /must be in \[0, 1\)/);

  const exGrouped = await call("training_export", { eval_fraction: 0.3, calibration_fraction: 0.2 });
  const parseJsonl = (f) => {
    const raw = readFileSync(join(exGrouped.dir, f), "utf8").trim();
    return raw ? raw.split("\n").map((l) => JSON.parse(l)) : [];
  };
  const groupedTrain = parseJsonl("train.jsonl");
  const groupedEval = parseJsonl("eval.jsonl");
  const groupedCal = parseJsonl("calibration.jsonl");

  // Fix 1 verification: "eval-grp-9" has 1 row in eval (d3), 0 rows in train or cal, and held_out_unlabelled >= 1
  assert.equal(groupedEval.filter((r) => r.group === "eval-grp-9").length, 1);
  assert.equal(groupedTrain.filter((r) => r.group === "eval-grp-9").length, 0);
  assert.equal(groupedCal.filter((r) => r.group === "eval-grp-9").length, 0);
  assert.ok(exGrouped.held_out_unlabelled >= 1, `expected held_out_unlabelled >= 1, got ${exGrouped.held_out_unlabelled}`);

  // Fix 2 verification: both rows of calGroup land in calibration.jsonl, both rows of sharedTrainGroup land in train.jsonl
  assert.equal(groupedCal.filter((r) => r.group === calGroup).length, 2);
  assert.equal(groupedTrain.filter((r) => r.group === sharedTrainGroup).length, 2);

  // No group appears in two files across train, eval, and calibration
  const trainGroupNames = new Set(groupedTrain.map((r) => r.group));
  const evalGroupNames = new Set(groupedEval.map((r) => r.group));
  const calGroupNames = new Set(groupedCal.map((r) => r.group));
  for (const g of evalGroupNames) {
    assert.ok(!trainGroupNames.has(g) && !calGroupNames.has(g), `eval group ${g} leaked into train/cal`);
  }
  for (const g of calGroupNames) {
    assert.ok(!trainGroupNames.has(g) && !evalGroupNames.has(g), `cal group ${g} leaked into train/eval`);
  }
  assert.equal(exGrouped.train_groups, trainGroupNames.size);
  assert.equal(exGrouped.eval_groups, evalGroupNames.size);
  assert.equal(exGrouped.calibration_groups, calGroupNames.size);

  // Fix 3 verification: sidecar manifest.json
  const manifest = JSON.parse(readFileSync(join(exGrouped.dir, "manifest.json"), "utf8"));
  assert.equal(manifest.schema_version, 1);
  assert.equal(typeof manifest.exported_at, "string");
  assert.equal(manifest.eval_fraction, 0.3);
  assert.equal(manifest.calibration_fraction, 0.2);
  assert.equal(manifest.split, "sha256(group)[0]/256");
  assert.equal(manifest.include_teacher, true);
  assert.equal(manifest.train, groupedTrain.length);
  assert.equal(manifest.eval, groupedEval.length);
  assert.equal(manifest.calibration, groupedCal.length);
  assert.equal(manifest.train_groups, trainGroupNames.size);
  assert.equal(manifest.eval_groups, evalGroupNames.size);
  assert.equal(manifest.calibration_groups, calGroupNames.size);
  assert.equal(manifest.held_out_unlabelled, exGrouped.held_out_unlabelled);

  // Fix 4 & human-over-guard & missing-stays-missing verification
  const exportedNoTeacher = groupedTrain.find((r) => r.id === noTeacherRow.id);
  assert.ok(exportedNoTeacher, "noTeacherRow must be in train.jsonl");
  assert.equal(exportedNoTeacher.teacher_model, null, "teacher_model must be null when no teacher answered");
  assert.equal(exportedNoTeacher.labels.rows_answer_question, true);
  assert.equal(exportedNoTeacher.labels.answer_supported, undefined, "missing label must stay undefined, never false");

  const d2AfterHuman = groupedTrain.find((r) => r.id === d2.id);
  assert.equal(d2AfterHuman.labels.action, "draft_reply", "human label must override guard");
  assert.equal(d2AfterHuman.label_source.action, "human");
  assert.equal(d2AfterHuman.labels.priority, "distress", "unlabelled guard question stays guard");
  assert.equal(d2AfterHuman.label_source.priority, "guard");
  assert.equal(d2AfterHuman.teacher_labels.action, "alert_operator", "teacher's original answer is still preserved");
  ok("P2 review fixes verified: pure group-hash split + held_out_unlabelled, calibration_fraction band, manifest.json, teacher_model=null when unanswered, and human-over-guard");

  // 20. Real Ollaya contract test mode (runs automatically when OLLAYA_URL or host.docker.internal:11435 is reachable)
  let realOllayaUrl = null;
  for (const cand of [process.env.OLLAYA_URL, "http://host.docker.internal:11435", "http://127.0.0.1:11435"].filter(Boolean)) {
    try {
      const r = await fetch(`${cand.replace(/\/+$/, "")}/api/version`, { signal: AbortSignal.timeout(1500) });
      if (r.ok) {
        const v = await r.json();
        if (v?.version && !String(v.version).includes("mock")) {
          realOllayaUrl = cand.replace(/\/+$/, "");
          break;
        }
      }
    } catch {
      /* not reachable */
    }
  }

  if (realOllayaUrl) {
    let realOllamaUrl = `http://127.0.0.1:${OLLAMA_PORT}`;
    for (const cand of [process.env.OLLAMA_URL, "http://host.docker.internal:11434"].filter(Boolean)) {
      try {
        const r = await fetch(`${cand.replace(/\/+$/, "")}/api/version`, { signal: AbortSignal.timeout(1500) });
        if (r.ok) {
          const v = await r.json();
          if (v?.version && !String(v.version).includes("mock")) {
            realOllamaUrl = cand.replace(/\/+$/, "");
            break;
          }
        }
      } catch {
        /* use mock ollama if real ollama is not reachable */
      }
    }

    const livePort = 21349;
    const liveDataDir = mkdtempSync(join(tmpdir(), "addita-live-"));
    const tLaunch = Date.now();
    const child = spawn(process.execPath, ["dist/index.js"], {
      env: {
        ...process.env,
        ADDITA_HOST: "127.0.0.1",
        ADDITA_PORT: String(livePort),
        OLLAYA_URL: realOllayaUrl,
        OLLAMA_URL: realOllamaUrl,
        ADDITA_LUME: "off",
        ADDITA_DATA_DIR: liveDataDir,
        LUME_SERVE_JSON: lumeServeJson,
      },
      stdio: ["pipe", "pipe", "pipe"],
    });

    try {
      let startupMs = -1;
      for (let i = 0; i < 200; i++) {
        try {
          const hr = await fetch(`http://127.0.0.1:${livePort}/health`, { signal: AbortSignal.timeout(200) });
          if (hr.status === 200) {
            startupMs = Date.now() - tLaunch;
            break;
          }
        } catch {
          /* wait for listener */
        }
        await new Promise((r) => setTimeout(r, 15));
      }
      assert.ok(startupMs >= 0 && startupMs < 2000, `expected HTTP listener ready in <2000ms, got ${startupMs}ms`);

      // Wait for background readiness probe to complete
      let healthBody = null;
      for (let i = 0; i < 100; i++) {
        const hr = await fetch(`http://127.0.0.1:${livePort}/health`);
        healthBody = await hr.json();
        if (healthBody?.ready) break;
        await new Promise((r) => setTimeout(r, 25));
      }
      assert.equal(healthBody?.ready, true, "expected /health ready=true after background probe");
      assert.equal(healthBody?.ollaya, true, "expected /health ollaya=true against real Ollaya");

      const judgePreset = JSON.parse(readFileSync(join(process.cwd(), "presets", "lume.sql_judge.json"), "utf8"));
      const liveState = {
        question: "How many rows are in telemetry?",
        sql: "SELECT count(*) AS n FROM telemetry",
        rows: [{ n: 42 }],
        answer: "There are 42 rows in telemetry.",
      };

      const directRes = await fetch(`${realOllayaUrl}/api/decide`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "laya",
          state: liveState,
          questions: judgePreset.questions,
        }),
      });
      assert.equal(directRes.status, 200);
      const directData = await directRes.json();

      const viaAdditaRes = await fetch(`http://127.0.0.1:${livePort}/api/decide`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "laya",
          preset: "lume.sql_judge",
          state: liveState,
          addita: { ref: "real-ollaya-contract" },
        }),
      });
      assert.equal(viaAdditaRes.status, 200);
      const viaData = await viaAdditaRes.json();

      assert.equal(JSON.stringify(viaData.answers), JSON.stringify(directData.answers), "student answers through Addita must be byte-identical to direct Ollaya");
      assert.equal(viaData.model, directData.model);
      assert.equal(viaData.done_reason, "decide");
      assert.deepEqual(viaData.routing, directData.routing);
      assert.ok(viaData.eval_duration > 0, "eval_duration must keep student's eval_duration");
      assert.ok(viaData.total_duration >= viaData.eval_duration, "total_duration must be Addita's actual wall time (>= eval_duration)");
      assert.equal(typeof viaData.addita.student_ms, "number");
      assert.equal(typeof viaData.addita.teacher_ms, "number");
      ok(
        `real Ollaya contract (${realOllayaUrl}, teacher ${realOllamaUrl}): listener up in ${startupMs}ms, byte-identical answers (${viaData.model}), student_ms=${viaData.addita.student_ms}ms, teacher_ms=${viaData.addita.teacher_ms}ms, eval_duration=${(viaData.eval_duration / 1e6).toFixed(1)}ms, total_duration=${(viaData.total_duration / 1e6).toFixed(1)}ms`,
      );
    } finally {
      await new Promise((r) => {
        if (child.exitCode !== null) return r();
        child.once("exit", r);
        child.kill("SIGTERM");
      });
      rmSync(liveDataDir, { recursive: true, force: true });
    }
  }

  console.log("\nall smoke tests passed");
} finally {
  await client.close();
  ollaya.server.close();
  ollama.server.close();
  lumeOtlp.server.close();
  rmSync(dataDir, { recursive: true, force: true });
}
