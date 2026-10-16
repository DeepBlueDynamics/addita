import { config } from "./config.js";
import { requestJson } from "./http.js";

const url = (p: string) => `${config.ollamaUrl}${p}`;

let probe: {
  at: number;
  online: boolean;
  version?: string;
  error?: string;
  remoteHosts?: Map<string, string>;
} | undefined;

export function isLocalHost(rawUrlOrHost: string): boolean {
  let hostname = rawUrlOrHost;
  try {
    const u = new URL(rawUrlOrHost.includes("://") ? rawUrlOrHost : `http://${rawUrlOrHost}`);
    hostname = u.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  } catch {
    hostname = rawUrlOrHost.split(":")[0].toLowerCase();
  }
  if (
    hostname === "localhost" ||
    hostname === "127.0.0.1" ||
    hostname === "::1" ||
    hostname === "0.0.0.0" ||
    hostname.startsWith("127.") ||
    hostname.endsWith(".local") ||
    hostname === "host.docker.internal"
  ) {
    return true;
  }
  if (hostname.startsWith("10.") || hostname.startsWith("192.168.")) return true;
  const m172 = hostname.match(/^172\.(\d+)\./);
  if (m172) {
    const second = Number(m172[1]);
    if (second >= 16 && second <= 31) return true;
  }
  return false;
}

export function isCloudModelTag(model: string): boolean {
  const m = model.toLowerCase();
  return m.endsWith(":cloud") || m.endsWith("-cloud") || /:.*cloud$/i.test(m);
}

function extractHost(rawUrl: string): string {
  try {
    return new URL(rawUrl.includes("://") ? rawUrl : `http://${rawUrl}`).host;
  } catch {
    return rawUrl;
  }
}

export interface TeacherCandidate {
  model: string;
  host: string;
  isCloud: boolean;
}

export function syncTeacherInfo(model = config.ollamaModel): TeacherCandidate {
  const configuredHost = extractHost(config.ollamaUrl);
  const urlIsCloud = !isLocalHost(config.ollamaUrl);
  const tagIsCloud = isCloudModelTag(model);
  const remote =
    probe?.remoteHosts?.get(model) ??
    probe?.remoteHosts?.get(`${model}:latest`);
  if (remote) {
    return { model, host: extractHost(remote), isCloud: true };
  }
  if (urlIsCloud) {
    return { model, host: configuredHost, isCloud: true };
  }
  if (tagIsCloud) {
    return { model, host: "ollama.com", isCloud: true };
  }
  return { model, host: configuredHost, isCloud: false };
}

/** Cheap, cached reachability check (GET /api/version + /api/tags for remote_host metadata). */
export async function isOnline(force = false): Promise<boolean> {
  const now = Date.now();
  if (!force && probe && now - probe.at < config.ollamaProbeTtlMs) return probe.online;
  try {
    const v = await requestJson<{ version: string }>(url("/api/version"), { timeoutMs: 1500 });
    const remoteHosts = new Map<string, string>();
    try {
      const tags = await requestJson<any>(url("/api/tags"), { timeoutMs: 1500 });
      for (const m of tags?.models ?? []) {
        const rh = m?.remote_host ?? m?.details?.remote_host;
        if (typeof m?.name === "string" && typeof rh === "string" && rh) {
          remoteHosts.set(m.name, rh);
        }
      }
    } catch {
      /* /api/tags is optional during reachability probe */
    }
    probe = { at: now, online: true, version: v?.version, remoteHosts };
  } catch (e: any) {
    probe = { at: now, online: false, error: e.message };
  }
  return probe.online;
}

export async function teacherInfo(model = config.ollamaModel): Promise<TeacherCandidate> {
  if (!isLocalHost(config.ollamaUrl)) {
    return { model, host: extractHost(config.ollamaUrl), isCloud: true };
  }
  if (isCloudModelTag(model)) {
    return { model, host: "ollama.com", isCloud: true };
  }
  if (!probe || Date.now() - probe.at >= config.ollamaProbeTtlMs) {
    await isOnline();
  }
  return syncTeacherInfo(model);
}

/**
 * Ordered list of usable teacher candidates for a request:
 *   1. Primary teacher (`config.ollamaModel`, default `deepseek-v4.1-flash:cloud`) if allowed.
 *   2. Local fallback teacher (`config.ollamaLocalModel`, default `qwen3.5:4b`) if distinct and allowed.
 */
export async function resolveTeacherCandidates(allowCloud: boolean): Promise<{
  candidates: TeacherCandidate[];
  defaultInfo: TeacherCandidate;
}> {
  const primary = await teacherInfo(config.ollamaModel);
  const localModel = config.ollamaLocalModel?.trim();
  const local = localModel && localModel !== config.ollamaModel ? await teacherInfo(localModel) : undefined;

  const candidates: TeacherCandidate[] = [];
  if (!primary.isCloud || allowCloud) {
    candidates.push(primary);
  }
  if (local && (!local.isCloud || allowCloud)) {
    candidates.push(local);
  }
  const defaultInfo = candidates[0] ?? local ?? primary;
  return { candidates, defaultInfo };
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
  think?: boolean;
  timeoutMs?: number;
}

/** POST /api/chat, non-streaming. Marks Ollama offline on connection failure. */
export async function chat(messages: ChatMessage[], o: ChatOptions = {}) {
  const requestedModel = o.model ?? config.ollamaModel;
  const think = o.think !== undefined ? o.think : config.ollamaThink;
  const buildBody = (includeThink: boolean) => ({
    model: requestedModel,
    messages,
    stream: false,
    ...(o.format ? { format: o.format } : {}),
    ...(o.options ? { options: o.options } : {}),
    ...(o.keepAlive !== undefined ? { keep_alive: o.keepAlive } : {}),
    ...(includeThink && think !== undefined ? { think } : {}),
  });

  try {
    let res: any;
    try {
      res = await requestJson<any>(url("/api/chat"), {
        body: buildBody(true),
        timeoutMs: o.timeoutMs ?? config.ollamaTimeoutMs,
      });
    } catch (err: any) {
      if (think !== undefined && err?.status === 400 && /think/i.test(err?.message ?? "")) {
        res = await requestJson<any>(url("/api/chat"), {
          body: buildBody(false),
          timeoutMs: o.timeoutMs ?? config.ollamaTimeoutMs,
        });
      } else {
        throw err;
      }
    }
    const returnedModel = isCloudModelTag(requestedModel)
      ? requestedModel
      : ((res.model as string) || requestedModel);
    return {
      model: returnedModel,
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
  const tInfo = syncTeacherInfo(config.ollamaModel);
  const localModel = config.ollamaLocalModel?.trim() || null;
  if (!online) {
    return {
      url: config.ollamaUrl,
      online,
      error: probe?.error,
      teacher_model: config.ollamaModel,
      teacher_host: tInfo.host,
      teacher_cloud: tInfo.isCloud,
      local_teacher_model: localModel,
    };
  }
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
    teacher_host: tInfo.host,
    teacher_cloud: tInfo.isCloud,
    local_teacher_model: localModel,
    teacher_installed: names.some((n) => n === config.ollamaModel || n === `${config.ollamaModel}:latest`),
    local_teacher_installed: localModel
      ? names.some((n) => n === localModel || n === `${localModel}:latest`)
      : false,
    models: names,
    loaded: (ps?.models ?? []).map((m: any) => m.name),
  };
}
