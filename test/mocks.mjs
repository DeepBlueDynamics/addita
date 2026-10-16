// Tiny stand-ins for the Ollaya and Ollama HTTP APIs, for the smoke test.
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
    const body = req.method === "POST" ? await readBody(req) : {};
    if (req.url === "/api/version") return json(res, 200, { version: "0.13.0-mock" });
    if (req.url === "/api/tags") return json(res, 200, { models: [{ name: "laya:latest", details: { format: "router" } }] });
    if (req.url === "/api/ps") return json(res, 200, { models: [] });
    if (req.url === "/api/create") {
      created.push(body);
      return json(res, 200, { status: "success" });
    }
    if (req.url === "/api/decide") {
      decides.push(body);
      const text = JSON.stringify(body.state).toLowerCase();
      const answers = {};
      for (const [id, q] of Object.entries(body.questions)) {
        if (q.type === "noul") answers[id] = { type: "noul", noul: text.includes("charlie bravo") ? 0.81 : 0.22 };
        else {
          const labels = q.type === "choice" ? (Array.isArray(q.criteria) ? q.criteria : Object.keys(q.criteria)) : q.criteria.map((_, i) => String(i));
          const p = softmax(labels.map((_, i) => (i === 0 ? 1.5 : 0)));
          const probabilities = Object.fromEntries(labels.map((l, i) => [l, p[i]]));
          if (q.type === "choice") answers[id] = { type: "choice", choice: labels[0], confidence: 0.4, probabilities };
          else answers[id] = { type: "score", score: p.reduce((a, v, i) => a + v * i, 0), confidence: 0.3, legend: {}, probabilities };
        }
      }
      return json(res, 200, { model: "laya:en", answers, usage: { input_tokens: 50, output_tokens: 0 }, routing: null });
    }
    json(res, 404, { error: "not found", code: "NOT_FOUND" });
  });
  return new Promise((ok) => server.listen(port, "127.0.0.1", () => ok({ server, created, decides })));
}

/** Ollama mock: answers the `format` schema; picks the last enum value, true, top level. */
export function mockOllama(port) {
  const calls = [];
  const server = createServer(async (req, res) => {
    const body = req.method === "POST" ? await readBody(req) : {};
    if (req.url === "/api/version") return json(res, 200, { version: "0.35.0-mock" });
    if (req.url === "/api/tags") return json(res, 200, { models: [{ name: "qwen3:8b" }] });
    if (req.url === "/api/ps") return json(res, 200, { models: [] });
    if (req.url === "/api/chat") {
      calls.push(body);
      let content = "Alpha Tango, Charlie Bravo, go ahead, over.";
      if (body.format && typeof body.format === "object") {
        const out = {};
        for (const [id, s] of Object.entries(body.format.properties)) {
          const a = s.properties.answer;
          const answer = a.enum ? a.enum[a.enum.length - 1] : a.type === "integer" ? a.maximum : true;
          out[id] = { answer, reason: `mock reason for ${id}` };
        }
        content = JSON.stringify(out);
      }
      return json(res, 200, { model: body.model, message: { role: "assistant", content }, done: true, total_duration: 1000 });
    }
    json(res, 404, { error: "not found" });
  });
  return new Promise((ok) => server.listen(port, "127.0.0.1", () => ok({ server, calls })));
}
