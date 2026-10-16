import { config } from "./config.js";
import { requestJson } from "./http.js";
import type { Questions } from "./questions.js";

const headers = (): Record<string, string> =>
  config.ollayaApiKey ? { authorization: `Bearer ${config.ollayaApiKey}` } : {};

const url = (p: string) => `${config.ollayaUrl}${p}`;

export interface DecideResponse {
  model: string;
  answers: Record<string, any>;
  usage?: { input_tokens: number; output_tokens: number };
  routing?: unknown;
  state_truncated?: boolean;
  total_duration?: number;
}

/** POST /api/decide (native endpoint: adds routing, timings, state_truncated). */
export function decide(model: string, state: unknown, questions: Questions, keepAlive?: string | number) {
  return requestJson<DecideResponse>(url("/api/decide"), {
    body: { model, state, questions, ...(keepAlive !== undefined ? { keep_alive: keepAlive } : {}) },
    headers: headers(),
    timeoutMs: config.ollayaTimeoutMs,
  });
}

export async function status() {
  const [version, tags, ps] = await Promise.all([
    requestJson(url("/api/version"), { headers: headers(), timeoutMs: 3000 }),
    requestJson(url("/api/tags"), { headers: headers(), timeoutMs: 3000 }),
    requestJson(url("/api/ps"), { headers: headers(), timeoutMs: 3000 }),
  ]);
  return {
    url: config.ollayaUrl,
    version: version?.version,
    models: (tags?.models ?? []).map((m: any) => ({
      name: m.name,
      format: m.details?.format,
      size: m.details?.parameter_size,
    })),
    loaded: (ps?.models ?? []).map((m: any) => ({ name: m.name, device: m.device, expires_at: m.expires_at })),
  };
}

export function pull(model: string) {
  return requestJson(url("/api/pull"), {
    body: { model, stream: false },
    headers: headers(),
    timeoutMs: 60 * 60 * 1000,
  });
}

/** POST /api/create: bake questions and/or calibration into a named model. */
export function create(body: {
  model: string;
  from: string;
  questions?: Questions;
  calibration?: Record<string, unknown>;
  description?: string;
}) {
  return requestJson(url("/api/create"), {
    body: { ...body, stream: false },
    headers: headers(),
    timeoutMs: 5 * 60 * 1000,
  });
}
