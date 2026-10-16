import { randomUUID, timingSafeEqual } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { dirname, join } from "node:path";
import { Readable } from "node:stream";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { config } from "./config.js";
import { decideHttp, getDecision, label, listPresets, tryLoadLocalPreset } from "./addita.js";
import * as ollaya from "./ollaya.js";
import {
  ApiError,
  MAX_BODY_BYTES,
  parseJsonObject,
  validateCopyRequest,
  validateCreateRequest,
  validateDecideRequest,
  validateDeleteRequest,
  validatePresetCreateRequest,
  validatePresetNameRequest,
  validatePullRequest,
  validateShowRequest,
  validateV1Request,
} from "./validate.js";

const REQ_ID_RE = /^[A-Za-z0-9._-]{1,128}$/;

function resolveRequestId(req: IncomingMessage): string {
  const raw = req.headers["x-request-id"];
  const val = Array.isArray(raw) ? raw[0] : raw;
  if (val && REQ_ID_RE.test(val)) return val;
  return randomUUID();
}

function setCommonHeaders(res: ServerResponse, reqId: string, isV1: boolean, extra?: Record<string, string>) {
  res.setHeader("x-request-id", reqId);
  if (isV1) res.setHeader("x-typesafe-request-id", reqId);
  res.setHeader("access-control-allow-origin", "*");
  if (extra) {
    for (const [k, v] of Object.entries(extra)) res.setHeader(k, v);
  }
}

function sendJson(
  res: ServerResponse,
  status: number,
  body: unknown,
  reqId: string,
  isV1: boolean,
  extraHeaders?: Record<string, string>,
) {
  const payload = Buffer.from(JSON.stringify(body), "utf8");
  setCommonHeaders(res, reqId, isV1, {
    "content-type": "application/json",
    "content-length": String(payload.byteLength),
    ...extraHeaders,
  });
  res.writeHead(status);
  res.end(payload);
}

function sendText(
  res: ServerResponse,
  status: number,
  text: string,
  reqId: string,
  headOnly = false,
) {
  const payload = Buffer.from(text, "utf8");
  setCommonHeaders(res, reqId, false, {
    "content-type": "text/plain; charset=utf-8",
    "content-length": String(payload.byteLength),
  });
  res.writeHead(status);
  res.end(headOnly ? undefined : payload);
}

function loadExpectedToken(): string | undefined {
  if (!config.tokenFile) return undefined;
  if (!existsSync(config.tokenFile)) return undefined;
  const t = readFileSync(config.tokenFile, "utf8").trim();
  return t || undefined;
}

function checkBearerAuth(req: IncomingMessage, pathname: string): void {
  const method = req.method ?? "GET";
  if (
    method === "OPTIONS" ||
    ((method === "GET" || method === "HEAD") && (pathname === "/" || pathname === "/health"))
  ) {
    return;
  }
  const expected = loadExpectedToken();
  if (!expected) return;
  const auth = req.headers.authorization;
  if (!auth || typeof auth !== "string") {
    throw ApiError.unauthorized();
  }
  const m = auth.match(/^Bearer\s+(.+)$/i);
  if (!m) {
    throw ApiError.unauthorized();
  }
  const provided = m[1].trim();
  const a = Buffer.from(provided, "utf8");
  const b = Buffer.from(expected, "utf8");
  if (a.byteLength !== b.byteLength || !timingSafeEqual(a, b)) {
    throw ApiError.unauthorized();
  }
}

async function readRawBody(req: IncomingMessage, limit = MAX_BODY_BYTES): Promise<Buffer> {
  const cl = req.headers["content-length"];
  if (cl !== undefined) {
    const n = Number(Array.isArray(cl) ? cl[0] : cl);
    if (Number.isFinite(n) && n > limit) {
      req.resume();
      throw ApiError.requestTooLarge(limit);
    }
  }
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buf.byteLength;
    if (total > limit) {
      throw ApiError.requestTooLarge(limit);
    }
    chunks.push(buf);
  }
  return Buffer.concat(chunks, total);
}

async function forwardToOllaya(
  res: ServerResponse,
  reqId: string,
  isV1: boolean,
  method: string,
  path: string,
  body?: unknown,
  timeoutMs = config.ollayaTimeoutMs,
) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const upstream = await fetch(ollaya.url(path), {
      method,
      headers: {
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
        ...ollaya.headers(),
        "x-request-id": reqId,
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: ctrl.signal,
    });
    const ct = upstream.headers.get("content-type") ?? "application/json";
    if (ct.includes("application/x-ndjson") && upstream.body) {
      setCommonHeaders(res, reqId, isV1, { "content-type": ct });
      res.writeHead(upstream.status);
      const nodeStream = Readable.fromWeb(upstream.body as any);
      for await (const chunk of nodeStream) {
        res.write(chunk);
      }
      res.end();
      return;
    }
    const raw = await upstream.text();
    let parsed: unknown;
    try {
      parsed = raw ? JSON.parse(raw) : {};
    } catch {
      parsed = { error: raw || `upstream status ${upstream.status}`, code: "INTERNAL_ERROR" };
    }
    sendJson(res, upstream.status, parsed, reqId, isV1);
  } catch (e: any) {
    throw ApiError.backendUnavailable(`cannot reach Ollaya at ${config.ollayaUrl}: ${e?.cause?.code ?? e?.message ?? e}`);
  } finally {
    clearTimeout(timer);
  }
}

export function writeServeJson(port: number) {
  const servePath = config.serveJson;
  mkdirSync(dirname(servePath), { recursive: true });
  const tmpPath = `${servePath}.tmp.${process.pid}`;
  const payload = {
    service: "addita",
    url: `http://127.0.0.1:${port}`,
    port,
    pid: process.pid,
    version: "0.1.0",
    token_file: config.tokenFile ?? null,
    started: new Date().toISOString(),
  };
  writeFileSync(tmpPath, JSON.stringify(payload, null, 2) + "\n", { mode: 0o600 });
  try {
    chmodSync(tmpPath, 0o600);
  } catch {
    /* ignore chmod on filesystems that don't support POSIX modes */
  }
  renameSync(tmpPath, servePath);
}

export function startHttpServer(
  createMcpServer: () => McpServer,
  opts: { host?: string; port?: number } = {},
): Promise<{ server: Server; port: number }> {
  const host = opts.host ?? config.host;
  const port = opts.port ?? config.port;

  // Active stateful MCP sessions keyed by session ID
  const mcpSessions = new Map<string, StreamableHTTPServerTransport>();

  async function handleMcpRequest(req: IncomingMessage, res: ServerResponse, reqId: string) {
    setCommonHeaders(res, reqId, false);
    const method = req.method ?? "GET";
    if (method !== "POST" && method !== "GET" && method !== "DELETE") {
      throw ApiError.methodNotAllowed(method, "/mcp", "GET, POST, DELETE");
    }

    const rawSid = req.headers["mcp-session-id"];
    const sid = Array.isArray(rawSid) ? rawSid[0] : rawSid;

    if (sid && mcpSessions.has(sid)) {
      const transport = mcpSessions.get(sid)!;
      if (method === "POST") {
        const raw = await readRawBody(req);
        const parsed = parseJsonObject(raw);
        await transport.handleRequest(req, res, parsed);
      } else {
        await transport.handleRequest(req, res);
      }
      return;
    }

    if (method === "POST") {
      const raw = await readRawBody(req);
      const parsed = parseJsonObject(raw);
      const isInit =
        parsed.method === "initialize" ||
        (Array.isArray(parsed) && parsed.some((m: any) => m?.method === "initialize"));

      if (isInit) {
        const mcp = createMcpServer();
        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          enableJsonResponse: true,
          onsessioninitialized: (newSid) => {
            mcpSessions.set(newSid, transport);
          },
          onsessionclosed: (closedSid) => {
            mcpSessions.delete(closedSid);
          },
        });
        transport.onclose = () => {
          if (transport.sessionId) mcpSessions.delete(transport.sessionId);
        };
        await mcp.connect(transport);
        await transport.handleRequest(req, res, parsed);
        return;
      }

      // Stateless one-shot request if no session ID was negotiated
      if (!sid) {
        const mcp = createMcpServer();
        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: undefined,
          enableJsonResponse: true,
        });
        await mcp.connect(transport);
        await transport.handleRequest(req, res, parsed);
        return;
      }
    }

    throw ApiError.notFound("MCP session not found");
  }

  const server = createServer(async (req, res) => {
    const reqId = resolveRequestId(req);
    const rawUrl = req.url ?? "/";
    const pathname = rawUrl.split("?")[0];
    const method = (req.method ?? "GET").toUpperCase();
    const isV1 = pathname === "/v1" || pathname.startsWith("/v1/");

    try {
      checkBearerAuth(req, pathname);

      if (method === "OPTIONS") {
        setCommonHeaders(res, reqId, isV1, {
          "access-control-allow-methods": "GET, HEAD, POST, DELETE, OPTIONS",
          "access-control-allow-headers":
            "authorization, content-type, x-request-id, mcp-session-id, mcp-protocol-version",
        });
        res.writeHead(204);
        res.end();
        return;
      }

      // /mcp Streamable HTTP MCP transport
      if (pathname === "/mcp") {
        await handleMcpRequest(req, res, reqId);
        return;
      }

      // GET / and HEAD /
      if (pathname === "/") {
        if (method !== "GET" && method !== "HEAD") {
          throw ApiError.methodNotAllowed(method, pathname, "GET, HEAD");
        }
        sendText(res, 200, "Ollaya is running", reqId, method === "HEAD");
        return;
      }

      // GET /health and HEAD /health
      if (pathname === "/health") {
        if (method !== "GET" && method !== "HEAD") {
          throw ApiError.methodNotAllowed(method, pathname, "GET, HEAD");
        }
        const body = { service: "addita", version: "0.1.0" };
        if (method === "HEAD") {
          const payload = Buffer.from(JSON.stringify(body), "utf8");
          setCommonHeaders(res, reqId, false, {
            "content-type": "application/json",
            "content-length": String(payload.byteLength),
          });
          res.writeHead(200);
          res.end();
        } else {
          sendJson(res, 200, body, reqId, false);
        }
        return;
      }

      // GET /api/version
      if (pathname === "/api/version") {
        if (method !== "GET" && method !== "HEAD") {
          throw ApiError.methodNotAllowed(method, pathname, "GET, HEAD");
        }
        sendJson(res, 200, { service: "addita", version: "0.1.0" }, reqId, false);
        return;
      }

      // POST /api/decide
      if (pathname === "/api/decide") {
        if (method !== "POST") {
          throw ApiError.methodNotAllowed(method, pathname, "POST");
        }
        const raw = await readRawBody(req);
        const body = parseJsonObject(raw);
        const validated = validateDecideRequest(body);
        const out = await decideHttp(validated, false);
        sendJson(res, 200, out, reqId, false);
        return;
      }

      // POST /v1/systemone and POST /v1/decisions
      if (pathname === "/v1/systemone" || pathname === "/v1/decisions") {
        if (method !== "POST") {
          throw ApiError.methodNotAllowed(method, pathname, "POST");
        }
        const raw = await readRawBody(req);
        const body = parseJsonObject(raw);
        const validated = validateV1Request(body);
        const out = await decideHttp(validated, true);
        sendJson(res, 200, out, reqId, true);
        return;
      }

      // GET /api/addita/decision/:id
      if (pathname.startsWith("/api/addita/decision/")) {
        if (method !== "GET") {
          throw ApiError.methodNotAllowed(method, pathname, "GET");
        }
        const id = decodeURIComponent(pathname.slice("/api/addita/decision/".length));
        if (!id) throw ApiError.notFound("decision id is required");
        const d = getDecision(id);
        if (!d) throw ApiError.notFound(`decision '${id}' not found`);
        sendJson(res, 200, d, reqId, false);
        return;
      }

      // POST /api/addita/label
      if (pathname === "/api/addita/label") {
        if (method !== "POST") {
          throw ApiError.methodNotAllowed(method, pathname, "POST");
        }
        const raw = await readRawBody(req);
        const body = parseJsonObject(raw);
        if (typeof body.id !== "string" || !body.id.trim()) {
          throw ApiError.validation([{ type: "missing", loc: ["body", "id"], msg: "Field required" }]);
        }
        if (!body.labels || typeof body.labels !== "object" || Array.isArray(body.labels) || Object.keys(body.labels).length === 0) {
          throw ApiError.validation([{ type: "missing", loc: ["body", "labels"], msg: "Field required" }]);
        }
        try {
          const out = await label(
            body.id,
            body.labels as any,
            typeof body.by === "string" ? body.by : undefined,
            typeof body.note === "string" ? body.note : undefined,
          );
          sendJson(res, 200, out, reqId, false);
        } catch (e: any) {
          const msg = e?.message ?? String(e);
          if (msg.startsWith("no decision with id")) {
            throw ApiError.notFound(msg);
          }
          throw ApiError.validation([{ type: "value_error", loc: ["body", "labels"], msg }]);
        }
        return;
      }

      // GET /api/tags
      if (pathname === "/api/tags") {
        if (method !== "GET") throw ApiError.methodNotAllowed(method, pathname, "GET");
        await forwardToOllaya(res, reqId, false, "GET", "/api/tags");
        return;
      }

      // POST /api/show
      if (pathname === "/api/show") {
        if (method !== "POST") throw ApiError.methodNotAllowed(method, pathname, "POST");
        const raw = await readRawBody(req);
        const body = parseJsonObject(raw);
        const validated = validateShowRequest(body);
        await forwardToOllaya(res, reqId, false, "POST", "/api/show", validated);
        return;
      }

      // GET /api/ps
      if (pathname === "/api/ps") {
        if (method !== "GET") throw ApiError.methodNotAllowed(method, pathname, "GET");
        await forwardToOllaya(res, reqId, false, "GET", "/api/ps");
        return;
      }

      // POST /api/pull
      if (pathname === "/api/pull") {
        if (method !== "POST") throw ApiError.methodNotAllowed(method, pathname, "POST");
        const raw = await readRawBody(req);
        const body = parseJsonObject(raw);
        const validated = validatePullRequest(body);
        await forwardToOllaya(res, reqId, false, "POST", "/api/pull", validated, 60 * 60 * 1000);
        return;
      }

      // DELETE /api/delete
      if (pathname === "/api/delete") {
        if (method !== "DELETE") throw ApiError.methodNotAllowed(method, pathname, "DELETE");
        const raw = await readRawBody(req);
        const body = parseJsonObject(raw);
        const validated = validateDeleteRequest(body);
        await forwardToOllaya(res, reqId, false, "DELETE", "/api/delete", validated);
        return;
      }

      // POST /api/copy
      if (pathname === "/api/copy") {
        if (method !== "POST") throw ApiError.methodNotAllowed(method, pathname, "POST");
        const raw = await readRawBody(req);
        const body = parseJsonObject(raw);
        const validated = validateCopyRequest(body);
        await forwardToOllaya(res, reqId, false, "POST", "/api/copy", validated);
        return;
      }

      // POST /api/create
      if (pathname === "/api/create") {
        if (method !== "POST") throw ApiError.methodNotAllowed(method, pathname, "POST");
        const raw = await readRawBody(req);
        const body = parseJsonObject(raw);
        const validated = validateCreateRequest(body);
        await forwardToOllaya(res, reqId, false, "POST", "/api/create", validated, 5 * 60 * 1000);
        return;
      }

      // GET /api/presets
      if (pathname === "/api/presets") {
        if (method !== "GET") throw ApiError.methodNotAllowed(method, pathname, "GET");
        const byName = new Map<string, any>();
        for (const name of listPresets()) {
          const p = tryLoadLocalPreset(name);
          if (!p) continue;
          let mtime = new Date().toISOString();
          try {
            mtime = statSync(join(config.presetsDir, `${name}.json`)).mtime.toISOString();
          } catch {
            /* ignore */
          }
          byName.set(name, {
            name: p.name,
            ...(p.description ? { description: p.description } : {}),
            questions: p.questions,
            updated_at: mtime,
          });
        }
        try {
          const ctrl = new AbortController();
          const timer = setTimeout(() => ctrl.abort(), 2000);
          try {
            const up = await fetch(ollaya.url("/api/presets"), {
              headers: ollaya.headers(),
              signal: ctrl.signal,
            });
            if (up.ok) {
              const data: any = await up.json();
              for (const pr of data?.presets ?? []) {
                if (pr?.name && !byName.has(pr.name)) byName.set(pr.name, pr);
              }
            }
          } finally {
            clearTimeout(timer);
          }
        } catch {
          /* local presets still returned when Ollaya is offline */
        }
        const presets = [...byName.values()].sort((a, b) => String(a.name).localeCompare(String(b.name)));
        sendJson(res, 200, { presets }, reqId, false);
        return;
      }

      // POST /api/presets/create
      if (pathname === "/api/presets/create") {
        if (method !== "POST") throw ApiError.methodNotAllowed(method, pathname, "POST");
        const raw = await readRawBody(req);
        const body = parseJsonObject(raw);
        const validated = validatePresetCreateRequest(body);
        await forwardToOllaya(res, reqId, false, "POST", "/api/presets/create", validated);
        return;
      }

      // POST /api/presets/show
      if (pathname === "/api/presets/show") {
        if (method !== "POST") throw ApiError.methodNotAllowed(method, pathname, "POST");
        const raw = await readRawBody(req);
        const body = parseJsonObject(raw);
        const { name } = validatePresetNameRequest(body);
        const local = tryLoadLocalPreset(name);
        if (local) {
          let mtime = new Date().toISOString();
          try {
            mtime = statSync(join(config.presetsDir, `${name}.json`)).mtime.toISOString();
          } catch {
            /* ignore */
          }
          sendJson(
            res,
            200,
            {
              name: local.name,
              ...(local.description ? { description: local.description } : {}),
              questions: local.questions,
              ...(local.guards ? { guards: local.guards } : {}),
              updated_at: mtime,
            },
            reqId,
            false,
          );
          return;
        }
        await forwardToOllaya(res, reqId, false, "POST", "/api/presets/show", { name });
        return;
      }

      // DELETE /api/presets/delete
      if (pathname === "/api/presets/delete") {
        if (method !== "DELETE") throw ApiError.methodNotAllowed(method, pathname, "DELETE");
        const raw = await readRawBody(req);
        const body = parseJsonObject(raw);
        const { name } = validatePresetNameRequest(body);
        await forwardToOllaya(res, reqId, false, "DELETE", "/api/presets/delete", { name });
        return;
      }

      // GET /v1/models
      if (pathname === "/v1/models") {
        if (method !== "GET") throw ApiError.methodNotAllowed(method, pathname, "GET");
        await forwardToOllaya(res, reqId, true, "GET", "/v1/models");
        return;
      }

      // Reserved endpoints -> 501 NOT_IMPLEMENTED
      if (pathname === "/api/push") {
        if (method !== "POST") throw ApiError.methodNotAllowed(method, pathname, "POST");
        await readRawBody(req);
        throw ApiError.notImplemented("POST /api/push is reserved and not yet implemented");
      }

      if (pathname.startsWith("/api/blobs/")) {
        if (method !== "HEAD" && method !== "POST") {
          throw ApiError.methodNotAllowed(method, pathname, "HEAD, POST");
        }
        if (method === "POST") await readRawBody(req);
        throw ApiError.notImplemented("/api/blobs/:digest is reserved and not yet implemented");
      }

      // Unknown endpoints
      if (
        pathname === "/api/generate" ||
        pathname === "/api/chat" ||
        pathname === "/api/embed" ||
        pathname === "/api/embeddings"
      ) {
        throw ApiError.notFound(
          `${pathname} is not supported; Ollaya is a decision-model runtime — use POST /api/decide`,
        );
      }

      throw ApiError.notFound(`unknown endpoint ${method} ${pathname}`);
    } catch (e: any) {
      if (res.headersSent) {
        res.end();
        return;
      }
      if (e instanceof ApiError) {
        sendJson(res, e.status, e.body, reqId, isV1, e.headers);
        return;
      }
      sendJson(
        res,
        500,
        { error: e?.message ?? "internal server error", code: "INTERNAL_ERROR" },
        reqId,
        isV1,
      );
    }
  });

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      const addr = server.address();
      const actualPort = typeof addr === "object" && addr ? addr.port : port;
      try {
        writeServeJson(actualPort);
      } catch (e: any) {
        console.error(`addita: could not write serve.json: ${e?.message ?? e}`);
      }
      resolve({ server, port: actualPort });
    });
  });
}
