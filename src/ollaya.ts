import { config } from "./config.js";
import { requestJson } from "./http.js";
import type { Questions } from "./questions.js";

export interface CalibrationSpec {
  temperature_by_options?: Record<string, number>;
  noul_threshold?: number;
}

export const headers = (): Record<string, string> =>
  config.ollayaApiKey ? { authorization: `Bearer ${config.ollayaApiKey}` } : {};

export const url = (p: string) => `${config.ollayaUrl}${p}`;

export interface DecideResponse {
  model: string;
  answers: Record<string, any>;
  usage?: { input_tokens: number; output_tokens: number };
  routing?: unknown;
  state_truncated?: boolean;
  done_reason?: string;
  created_at?: string;
  total_duration?: number;
  load_duration?: number;
  eval_duration?: number;
}

export interface DecideExtraOpts {
  keepAlive?: string | number;
  images?: string[];
  extras?: string[];
}

/** POST /api/decide (native endpoint: adds routing, timings, state_truncated). */
export function decide(
  model: string,
  state: unknown,
  questions?: Questions,
  keepAliveOrOpts?: string | number | DecideExtraOpts,
) {
  const opts: DecideExtraOpts =
    typeof keepAliveOrOpts === "object" && keepAliveOrOpts !== null
      ? keepAliveOrOpts
      : { keepAlive: keepAliveOrOpts };
  return requestJson<DecideResponse>(url("/api/decide"), {
    body: {
      model,
      ...(state !== undefined ? { state } : {}),
      ...(questions !== undefined ? { questions } : {}),
      ...(opts.images?.length ? { images: opts.images } : {}),
      ...(opts.keepAlive !== undefined ? { keep_alive: opts.keepAlive } : {}),
      ...(opts.extras?.length ? { extras: opts.extras } : {}),
    },
    headers: headers(),
    timeoutMs: config.ollayaTimeoutMs,
  });
}

export function show(model: string, verbose = false) {
  return requestJson<any>(url("/api/show"), {
    body: { model, verbose },
    headers: headers(),
    timeoutMs: config.ollayaTimeoutMs,
  });
}

export function presetShow(name: string) {
  return requestJson<any>(url("/api/presets/show"), {
    body: { name },
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
