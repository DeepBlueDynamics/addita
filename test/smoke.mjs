// End-to-end: spawn Addita (MCP over stdio + HTTP on ADDITA_PORT + MCP over /mcp) against mock backends and walk the loop.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
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
  assert.equal(st.allow_cloud_teacher, true);
  assert.ok(st.presets.includes("comms") && st.presets.includes("lume.sql_judge"));
  ok("both backends online, default teachers deepseek-v4.1-flash:cloud + qwen3.5:4b, presets discovered");

  // 1. online: student first, cloud teacher answers by default, teacher wins
  const d1 = await call("comms_decide", { state: { ...base, transcript: "Charlie Bravo, this is Alpha Tango, come in, over." } });
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
  const d2 = await call("comms_decide", { state: { ...base, transcript: "Mayday mayday mayday, Charlie Bravo this is Blue Heron, taking on water" } });
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
  const d3 = await call("comms_decide", { state: { ...base, transcript: "Charlie Bravo, I need a wind check." } });
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
  assert.equal(s.by_teacher["deepseek-v4.1-flash:cloud"].decisions, 3);
  ok(`stats: ${JSON.stringify(s.questions.priority)}`);

  const dis = await call("training_disagreements", { limit: 5 });
  assert.ok(dis.length >= 1 && dis[0].diff.priority.reason);
  ok(`${dis.length} disagreement(s) to review`);

  const ex = await call("training_export", { eval_fraction: 1 });
  assert.equal(ex.eval, 1);
  assert.equal(ex.train, 2);
  const evalRow = JSON.parse(readFileSync(join(ex.dir, "eval.jsonl"), "utf8").trim());
  assert.equal(evalRow.label_source.intent, "human");
  assert.equal(evalRow.label_source.priority, "teacher");
  ok("export: eval is human-labelled only, human labels outrank teacher");

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
  assert.deepEqual(healthRes.data, { service: "addita", version: "0.1.0" });

  const verRes = await httpJson("/api/version");
  assert.equal(verRes.status, 200);
  assert.equal(verRes.data.service, "addita");
  assert.equal(verRes.data.version, "0.1.0");
  ok("GET /, /health, /api/version and X-Request-Id header echoing");

  // 10. POST /api/decide with lume.sql_judge preset + verbatim student answers + addita block (cloud ok -> cloud answers)
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
      addita: { ref: "ti:q_9f3a" },
    },
  });
  assert.equal(sqlJudgeRes.status, 200);
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
  ok("POST /api/decide (lume.sql_judge): verbatim student answers + addita block (cloud ok -> cloud answers)");

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

  // 12. POST /v1/systemone and POST /v1/decisions (pure TypeSafe shape, no addita block, no laya extra)
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

  // STATE_TRUNCATED on /v1/systemone returns 422 STATE_TRUNCATED
  const truncV1 = await httpJson("/v1/systemone", {
    body: {
      model: "laya",
      state: "please __truncate__ this state",
      questions: { q1: { type: "noul" } },
    },
  });
  assert.equal(truncV1.status, 422);
  assert.equal(truncV1.data.code, "STATE_TRUNCATED");
  ok("/v1/systemone and /v1/decisions return pure {model, answers, usage} and 422 STATE_TRUNCATED");

  // 13. Dual-teacher policy (cloud disallowed -> local answers; cloud fails -> local answers; per-teacher stats)
  const callsBeforeDisallowed = ollama.calls.length;
  const cloudDisallowed = await httpJson("/api/decide", {
    body: {
      model: "laya",
      preset: "lume.sql_judge",
      state: { question: "q", sql: "SELECT 42", rows: [42], answer: "42" },
      addita: { allow_cloud_teacher: false },
    },
  });
  assert.equal(cloudDisallowed.status, 200);
  assert.equal(cloudDisallowed.data.addita.teacher, "answered");
  assert.equal(cloudDisallowed.data.addita.teacher_model, "qwen3.5:4b");
  assert.equal(cloudDisallowed.data.addita.teacher_host, `127.0.0.1:${OLLAMA_PORT}`);
  assert.equal(cloudDisallowed.data.addita.source, "teacher");
  assert.equal(ollama.calls.length, callsBeforeDisallowed + 1);
  assert.equal(ollama.calls.at(-1).model, "qwen3.5:4b", "cloud must not be called when allow_cloud_teacher=false");

  // Cloud fails -> falls back to local teacher on the same call
  ollama.state.failCloud = true;
  const callsBeforeFail = ollama.calls.length;
  const cloudFailedFallback = await httpJson("/api/decide", {
    body: {
      model: "laya",
      preset: "lume.sql_judge",
      state: { question: "q", sql: "SELECT 42", rows: [42], answer: "42" },
    },
  });
  assert.equal(cloudFailedFallback.status, 200);
  assert.equal(cloudFailedFallback.data.addita.teacher, "answered");
  assert.equal(cloudFailedFallback.data.addita.teacher_model, "qwen3.5:4b");
  assert.equal(cloudFailedFallback.data.addita.teacher_host, `127.0.0.1:${OLLAMA_PORT}`);
  assert.equal(cloudFailedFallback.data.addita.source, "teacher");
  assert.equal(ollama.calls.length, callsBeforeFail + 2, "must try cloud first then fall back to local on the same call");
  assert.equal(ollama.calls.at(-2).model, "deepseek-v4.1-flash:cloud");
  assert.equal(ollama.calls.at(-1).model, "qwen3.5:4b");
  ollama.state.failCloud = false;

  // Verify stats splits agreement by teacher
  const sAfterDual = await call("training_stats");
  assert.ok(sAfterDual.by_teacher["deepseek-v4.1-flash:cloud"].decisions >= 4);
  assert.ok(sAfterDual.by_teacher["qwen3.5:4b"].decisions >= 2);
  ok("dual-teacher policy: cloud disallowed -> local answers; cloud fails -> local answers; stats split by teacher");

  // 14. Outage resilience: Ollaya down, and both Ollaya + Ollama down (neither -> pending)
  await new Promise((r) => ollaya.server.close(r));
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
  ok("outage resilience: works with Ollaya down, Ollama down (pending), and both down (guards + no fake probs)");

  // 15. Upstream boundary validation & error codes (400, 404, 405, 422, 501)
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
  assert.equal(err422Stream.data.code, "UNPROCESSABLE_REQUEST");
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
  assert.deepEqual(err422Mutual.data.detail[0].loc, ["body", "preset"]);

  const err422Tag = await httpJson("/api/decide", {
    body: {
      model: "laya",
      state: "hi",
      questions: { q: { type: "bogus" } },
    },
  });
  assert.equal(err422Tag.status, 422);
  assert.equal(err422Tag.data.detail[0].type, "union_tag_invalid");
  assert.deepEqual(err422Tag.data.detail[0].loc, ["body", "questions", "q"]);

  const err501Push = await httpJson("/api/push", { body: { model: "laya" } });
  assert.equal(err501Push.status, 501);
  assert.equal(err501Push.data.code, "NOT_IMPLEMENTED");

  const err501Blob = await httpJson("/api/blobs/sha256:deadbeef", { method: "HEAD" });
  assert.equal(err501Blob.status, 501);
  ok("boundary validation & error codes (400, 404, 405, 422, 501) match upstream contract");

  // 16. Forwarded endpoints & NDJSON streaming passthrough
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

  // 17. OTLP /v1/logs and /v1/metrics verification
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

  // 18. Streamable HTTP MCP transport on /mcp
  const httpMcpClient = new Client({ name: "smoke-http", version: "0" });
  await httpMcpClient.connect(new StreamableHTTPClientTransport(new URL(`${HTTP_BASE}/mcp`)));
  const httpTools = (await httpMcpClient.listTools()).tools.map((t) => t.name);
  assert.ok(httpTools.includes("comms_decide") && httpTools.includes("presets_show"));
  const judgePresetViaMcp = await httpMcpClient.callTool({ name: "presets_show", arguments: { name: "lume.sql_judge" } });
  const judgePresetParsed = JSON.parse(judgePresetViaMcp.content[0].text);
  assert.ok(judgePresetParsed.questions.rows_answer_question);
  await httpMcpClient.close();
  ok("MCP over Streamable HTTP (/mcp) connected and executed tools");

  console.log("\nall smoke tests passed");
} finally {
  await client.close();
  ollaya.server.close();
  ollama.server.close();
  lumeOtlp.server.close();
  rmSync(dataDir, { recursive: true, force: true });
}
