import { config } from "./config.js";
import { requestJson } from "./http.js";
import type { Questions } from "./questions.js";

export interface CalibrationSpec {
  temperature?: number[];
  temperature_by_options?: Record<string, number>;
  noul_threshold?: number;
}

export const headers = (): Record<string, string> =>
  config.ollayaApiKey ? { authorization: `Bearer ${config.ollayaApiKey}` } : {};

export const url = (p: string) => `${config.ollayaUrl}${p}`;

let lastOnline: boolean | undefined;

export function isKnownOnline(): boolean | undefined {
  return lastOnline;
}

export function setKnownOnline(online: boolean): void {
  lastOnline = online;
}

async function trackedRequest<T = any>(path: string, opts: Parameters<typeof requestJson>[1]): Promise<T> {
  try {
    const res = await requestJson<T>(url(path), opts);
    lastOnline = true;
    return res;
  } catch (e: any) {
    if (e?.status !== undefined) {
      lastOnline = true;
    } else {
      lastOnline = false;
    }
    throw e;
  }
}

export interface DecideResponse {
  model: string;
  answers: Record<string, any>;
  usage?: { input_tokens: number; output_tokens: number };
  routing?: unknown;
  state_truncated?: boolean;
  done_reason?: "decide" | "load" | "unload";
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
  return trackedRequest<DecideResponse>("/api/decide", {
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
  return trackedRequest<any>("/api/show", {
    body: { model, verbose },
    headers: headers(),
    timeoutMs: config.ollayaTimeoutMs,
  });
}

export function presetShow(name: string) {
  return trackedRequest<any>("/api/presets/show", {
    body: { name },
    headers: headers(),
    timeoutMs: config.ollayaTimeoutMs,
  });
}

export async function status() {
  const [version, tags, ps] = await Promise.all([
    trackedRequest("/api/version", { headers: headers(), timeoutMs: 3000 }),
    trackedRequest("/api/tags", { headers: headers(), timeoutMs: 3000 }),
    trackedRequest("/api/ps", { headers: headers(), timeoutMs: 3000 }),
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
  parameters?: { precision?: "fp16" | "fp32" };
  description?: string;
  license?: string | string[];
}) {
  return requestJson(url("/api/create"), {
    body: { ...body, stream: false },
    headers: headers(),
    timeoutMs: 5 * 60 * 1000,
  });
}
