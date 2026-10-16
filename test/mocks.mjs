// Tiny stand-ins for the Ollaya, Ollama, and Lume OTLP HTTP APIs, for the smoke test.
import { createServer } from "node:http";

function json(res, code, body) {
  res.writeHead(code, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

function readBody(req) {
  return new Promise((ok) => {
    let b = "";
    req.on("data", (c) => (b += c));
    req.on("end", () => ok(b ? JSON.parse(b) : {}));
  });
}

const softmax = (xs) => {
  const m = Math.max(...xs);
  const e = xs.map((x) => Math.exp(x - m));
  const s = e.reduce((a, b) => a + b, 0);
  return e.map((v) => Math.round((v / s) * 10000) / 10000);
};

/** Ollaya mock: favours the first option a bit, noul by keyword. */
export function mockOllaya(port) {
  const created = [];
  const decides = [];
  const server = createServer(async (req, res) => {
    const body = req.method === "POST" || req.method === "DELETE" ? await readBody(req) : {};
    if (req.url === "/api/version") return json(res, 200, { version: "0.13.0-mock" });
    if (req.url === "/api/tags") return json(res, 200, { models: [{ name: "laya:latest", details: { format: "router" } }] });
    if (req.url === "/api/ps") return json(res, 200, { models: [] });
    if (req.url === "/v1/models") return json(res, 200, { object: "list", data: [{ id: "laya:latest", object: "model" }] });
    if (req.url === "/api/show") return json(res, 200, { model: body.model, details: { format: "router" }, questions: null });
    if (req.url === "/api/presets") return json(res, 200, { presets: [] });
    if (req.url === "/api/presets/show") return json(res, 404, { error: `preset '${body.name}' not found`, code: "NOT_FOUND" });
    if (req.url === "/api/pull") {
      if (body.stream !== false) {
        res.writeHead(200, { "content-type": "application/x-ndjson" });
        res.write(JSON.stringify({ status: `pulling ${body.model}` }) + "\n");
        res.end(JSON.stringify({ status: "success" }) + "\n");
        return;
      }
      return json(res, 200, { status: "success" });
    }
    if (req.url === "/api/create") {
      created.push(body);
      return json(res, 200, { status: "success" });
    }
    if (req.url === "/api/decide") {
      decides.push(body);
      if (body.state === undefined || body.state === null) {
        return json(res, 200, {
          model: body.model,
          answers: {},
          usage: { input_tokens: 0, output_tokens: 0 },
          routing: null,
          state_truncated: false,
          done_reason: body.keep_alive === 0 ? "unload" : "load",
          created_at: new Date().toISOString(),
          total_duration: 100,
          load_duration: 100,
          eval_duration: 0,
        });
      }
      const text = JSON.stringify(body.state).toLowerCase();
      const wantLaya = Array.isArray(body.extras) && body.extras.includes("laya");
      const answers = {};
      for (const [id, q] of Object.entries(body.questions ?? {})) {
        const layaExtra = wantLaya ? { laya: { entropy: 0.12, margin: 0.65 } } : {};
        if (q.type === "noul") {
          answers[id] = { type: "noul", noul: text.includes("charlie bravo") || text.includes("42") ? 0.81 : 0.22, ...layaExtra };
        } else {
          const labels = q.type === "choice" ? (Array.isArray(q.criteria) ? q.criteria : Object.keys(q.criteria)) : q.criteria.map((_, i) => String(i));
          const p = softmax(labels.map((_, i) => (i === 0 ? 1.5 : 0)));
          const probabilities = Object.fromEntries(labels.map((l, i) => [l, p[i]]));
          if (q.type === "choice") answers[id] = { type: "choice", choice: labels[0], confidence: 0.4, probabilities, ...layaExtra };
          else answers[id] = { type: "score", score: p.reduce((a, v, i) => a + v * i, 0), confidence: 0.3, legend: {}, probabilities, ...layaExtra };
        }
      }
      const stateTruncated = text.includes("__truncate__");
      return json(res, 200, {
        model: "laya:en",
        answers,
        usage: { input_tokens: 50, output_tokens: 0 },
        routing: null,
        state_truncated: stateTruncated,
        done_reason: "complete",
        created_at: new Date().toISOString(),
        total_duration: 1200000,
        load_duration: 100000,
        eval_duration: 1100000,
      });
    }
    json(res, 404, { error: "not found", code: "NOT_FOUND" });
  });
  return new Promise((ok) => server.listen(port, "127.0.0.1", () => ok({ server, created, decides })));
}

/** Ollama mock: answers the `format` schema; picks the last enum value, true, top level. */
export function mockOllama(port, opts = {}) {
  const calls = [];
  const state = { failCloud: opts.failCloud ?? false };
  const server = createServer(async (req, res) => {
    const body = req.method === "POST" ? await readBody(req) : {};
    if (req.url === "/api/version") return json(res, 200, { version: "0.35.0-mock" });
    if (req.url === "/api/tags") {
      return json(res, 200, {
        models: [
          { name: "deepseek-v4.1-flash:cloud", remote_host: "https://ollama.com" },
          { name: "qwen3.5:4b" },
        ],
      });
    }
    if (req.url === "/api/ps") return json(res, 200, { models: [] });
    if (req.url === "/api/chat") {
      calls.push(body);
      if (state.failCloud && String(body.model).endsWith(":cloud")) {
        return json(res, 502, { error: "cloud upstream unavailable" });
      }
      let content = "Alpha Tango, Charlie Bravo, go ahead, over.";
      if (body.format && typeof body.format === "object") {
        const out = {};
        for (const [id, s] of Object.entries(body.format.properties)) {
          const a = s.properties.answer;
          const answer = a.enum ? a.enum[a.enum.length - 1] : a.type === "integer" ? a.maximum : true;
          out[id] = { answer, reason: `mock reason for ${id} (${body.model})` };
        }
        content = JSON.stringify(out);
      }
      // Mimic Ollama stripping :cloud on returned model field for cloud models
      const returnedModel = String(body.model).replace(/:cloud$/, "");
      return json(res, 200, { model: returnedModel, message: { role: "assistant", content }, done: true, total_duration: 1000 });
    }
    json(res, 404, { error: "not found" });
  });
  return new Promise((ok) => server.listen(port, "127.0.0.1", () => ok({ server, calls, state })));
}

/** Lume OTLP mock receiver for /health, /v1/logs, and /v1/metrics. */
export function mockLumeOtlp(port) {
  const logs = [];
  const metrics = [];
  const server = createServer(async (req, res) => {
    const body = req.method === "POST" ? await readBody(req) : {};
    if (req.url === "/health") return json(res, 200, { status: "ok", service: "lume", version: "0.9.5" });
    if (req.url === "/v1/logs") {
      logs.push(body);
      return json(res, 200, {});
    }
    if (req.url === "/v1/metrics") {
      metrics.push(body);
      return json(res, 200, {});
    }
    json(res, 404, { error: "not found" });
  });
  return new Promise((ok) => server.listen(port, "127.0.0.1", () => ok({ server, logs, metrics })));
}
