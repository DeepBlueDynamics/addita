import { config } from "./config.js";
import { requestJson } from "./http.js";

const url = (p: string) => `${config.ollamaUrl}${p}`;

let probe: { at: number; online: boolean; version?: string; error?: string } | undefined;

/** Cheap, cached reachability check (GET /api/version). */
export async function isOnline(force = false): Promise<boolean> {
  const now = Date.now();
  if (!force && probe && now - probe.at < config.ollamaProbeTtlMs) return probe.online;
  try {
    const v = await requestJson<{ version: string }>(url("/api/version"), { timeoutMs: 1500 });
    probe = { at: now, online: true, version: v?.version };
  } catch (e: any) {
    probe = { at: now, online: false, error: e.message };
  }
  return probe.online;
}

export function lastProbe() {
  return probe;
}

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  images?: string[];
}

export interface ChatOptions {
  model?: string;
  format?: "json" | Record<string, unknown>;
  options?: Record<string, unknown>;
  keepAlive?: string | number;
  timeoutMs?: number;
}

/** POST /api/chat, non-streaming. Marks Ollama offline on connection failure. */
export async function chat(messages: ChatMessage[], o: ChatOptions = {}) {
  try {
    const res = await requestJson<any>(url("/api/chat"), {
      body: {
        model: o.model ?? config.ollamaModel,
        messages,
        stream: false,
        ...(o.format ? { format: o.format } : {}),
        ...(o.options ? { options: o.options } : {}),
        ...(o.keepAlive !== undefined ? { keep_alive: o.keepAlive } : {}),
        ...(config.ollamaThink !== undefined ? { think: config.ollamaThink } : {}),
      },
      timeoutMs: o.timeoutMs ?? config.ollamaTimeoutMs,
    });
    return {
      model: res.model as string,
      content: (res.message?.content ?? "") as string,
      thinking: res.message?.thinking as string | undefined,
      total_duration: res.total_duration as number | undefined,
      eval_count: res.eval_count as number | undefined,
    };
  } catch (e: any) {
    if (e.status === undefined) probe = { at: Date.now(), online: false, error: e.message };
    throw e;
  }
}

export async function status() {
  const online = await isOnline(true);
  if (!online) return { url: config.ollamaUrl, online, error: probe?.error, teacher_model: config.ollamaModel };
  const [tags, ps] = await Promise.all([
    requestJson(url("/api/tags"), { timeoutMs: 3000 }),
    requestJson(url("/api/ps"), { timeoutMs: 3000 }),
  ]);
  const names: string[] = (tags?.models ?? []).map((m: any) => m.name);
  return {
    url: config.ollamaUrl,
    online,
    version: probe?.version,
    teacher_model: config.ollamaModel,
    teacher_installed: names.some((n) => n === config.ollamaModel || n === `${config.ollamaModel}:latest`),
    models: names,
    loaded: (ps?.models ?? []).map((m: any) => m.name),
  };
}
