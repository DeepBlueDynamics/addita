// End-to-end: spawn the MCP server over stdio against mock backends and walk the loop.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mockOllama, mockOllaya } from "./mocks.mjs";

const OLLAYA_PORT = 21435;
const OLLAMA_PORT = 21434;
const dataDir = mkdtempSync(join(tmpdir(), "addita-test-"));

const ollaya = await mockOllaya(OLLAYA_PORT);
let ollama = await mockOllama(OLLAMA_PORT);

const client = new Client({ name: "smoke", version: "0" });
await client.connect(
  new StdioClientTransport({
    command: process.execPath,
    args: ["dist/index.js"],
    env: {
      ...process.env,
      OLLAYA_URL: `http://127.0.0.1:${OLLAYA_PORT}`,
      OLLAMA_URL: `http://127.0.0.1:${OLLAMA_PORT}`,
      OLLAMA_PROBE_TTL_MS: "0",
      ADDITA_DATA_DIR: dataDir,
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
  const tools = (await client.listTools()).tools.map((t) => t.name);
  assert.ok(tools.includes("comms_decide") && tools.includes("training_export"));
  ok(`${tools.length} tools listed`);

  const st = await call("backends_status");
  assert.equal(st.ollaya.version, "0.13.0-mock");
  assert.equal(st.ollama.online, true);
  ok("both backends online");

  // 1. online: student first, teacher answers, teacher wins
  const d1 = await call("comms_decide", { state: { ...base, transcript: "Charlie Bravo, this is Alpha Tango, come in, over." } });
  assert.equal(d1.source, "teacher");
  assert.equal(d1.student.answers.priority, "distress"); // mock student picks the first label
  assert.equal(d1.teacher.answers.priority, "noise"); // mock teacher picks the last
  assert.equal(d1.answers.priority, "noise");
  assert.equal(d1.agreement.priority, false);
  assert.equal(d1.agreement.addressed_to_us, true);
  ok("online: student ran, teacher answered and was returned, agreement recorded");

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
  await assert.rejects(call("comms_label", { id: d3.id, labels: { intent: "pancakes" } }), /not a valid answer/);
  ok("labels recorded and validated");

  // 5. back online: backfill
  ollama = await mockOllama(OLLAMA_PORT);
  const bf = await call("training_backfill", {});
  assert.ok(bf.labelled >= 1, JSON.stringify(bf)); // d3 plus the failed "require" call never logged
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

  console.log("\nall smoke tests passed");
} finally {
  await client.close();
  ollaya.server.close();
  ollama.server.close();
  rmSync(dataDir, { recursive: true, force: true });
}
