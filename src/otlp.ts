/**
 * Fire-and-forget OTLP/HTTP JSON emitter to Lume (`POST /v1/logs` and `/v1/metrics`).
 *
 * Discovers Lume via `~/.lume/serve.json` (or `LUME_SERVE_JSON`), checks that
 * `otlp === true` and `GET {url}/health` reports `service === "lume"`, and attaches
 * `Authorization: Bearer <token>` when `token_file` is set.
 * Never throws or blocks `decide`.
 */
import { existsSync, readFileSync } from "node:fs";
import { hostname } from "node:os";
import { config } from "./config.js";

const INSTANCE_ID = `addita-${hostname()}`;

interface LumeTarget {
  url: string;
  token?: string;
  checkedAt: number;
  servePath: string;
}

let cachedTarget: LumeTarget | null | undefined;
let lastCheckAt = 0;
const CHECK_TTL_MS = 5_000;

function toOtlpAnyValue(v: unknown): Record<string, unknown> {
  if (typeof v === "string") return { stringValue: v };
  if (typeof v === "boolean") return { boolValue: v };
  if (typeof v === "number") {
    if (Number.isInteger(v)) return { intValue: String(v) };
    return { doubleValue: v };
  }
  if (Array.isArray(v)) {
    return { arrayValue: { values: v.map((item) => toOtlpAnyValue(item)) } };
  }
  if (v && typeof v === "object") {
    return {
      kvlistValue: {
        values: Object.entries(v as Record<string, unknown>)
          .filter(([, val]) => val !== undefined)
          .map(([k, val]) => ({ key: k, value: toOtlpAnyValue(val) })),
      },
    };
  }
  return { stringValue: String(v ?? "") };
}

function toAttributes(attrs: Record<string, unknown>) {
  const out: { key: string; value: Record<string, unknown> }[] = [];
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null) continue;
    out.push({ key: k, value: toOtlpAnyValue(v) });
  }
  return out;
}

function resourceAttributes() {
  return [
    { key: "service.name", value: { stringValue: "addita" } },
    { key: "service.version", value: { stringValue: "0.1.0" } },
    { key: "service.instance.id", value: { stringValue: INSTANCE_ID } },
  ];
}

async function resolveLumeOtlp(): Promise<LumeTarget | null> {
  const servePath = config.lume.serveJson;
  const now = Date.now();
  if (cachedTarget !== undefined && cachedTarget?.servePath === servePath && now - lastCheckAt < CHECK_TTL_MS) {
    return cachedTarget;
  }
  lastCheckAt = now;
  if (!existsSync(servePath)) {
    cachedTarget = null;
    return null;
  }
  try {
    const raw = JSON.parse(readFileSync(servePath, "utf8"));
    if (!raw || typeof raw.url !== "string" || raw.otlp !== true) {
      cachedTarget = null;
      return null;
    }
    const baseUrl = raw.url.replace(/\/+$/, "");
    let token: string | undefined;
    if (typeof raw.token_file === "string" && raw.token_file && existsSync(raw.token_file)) {
      token = readFileSync(raw.token_file, "utf8").trim() || undefined;
    }
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 1500);
    try {
      const res = await fetch(`${baseUrl}/health`, {
        headers: token ? { authorization: `Bearer ${token}` } : {},
        signal: ctrl.signal,
      });
      if (!res.ok) {
        cachedTarget = null;
        return null;
      }
      const health: any = await res.json();
      if (health?.service !== "lume") {
        cachedTarget = null;
        return null;
      }
    } finally {
      clearTimeout(timer);
    }
    cachedTarget = { url: baseUrl, token, checkedAt: now, servePath };
    return cachedTarget;
  } catch {
    cachedTarget = null;
    return null;
  }
}

async function postOtlp(path: "/v1/logs" | "/v1/metrics", payload: unknown): Promise<void> {
  try {
    const target = await resolveLumeOtlp();
    if (!target) return;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 2000);
    try {
      await fetch(`${target.url}${path}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(target.token ? { authorization: `Bearer ${target.token}` } : {}),
        },
        body: JSON.stringify(payload),
        signal: ctrl.signal,
      });
    } finally {
      clearTimeout(timer);
    }
  } catch {
    // Fire-and-forget: never fail the caller on OTLP error.
  }
}

export function resetOtlpCache() {
  cachedTarget = undefined;
  lastCheckAt = 0;
}

export interface DecisionTelemetry {
  id: string;
  ref?: string | null;
  preset?: string;
  model: string;
  teacher_model: string;
  teacher_host: string;
  source: "student" | "teacher" | "guard" | "none";
  teacher: "answered" | "pending" | "skipped" | "failed";
  guards: string[];
  agreement: Record<string, boolean>;
  final: Record<string, unknown>;
  noul: Record<string, number>;
  student_ms: number;
  teacher_ms?: number;
  total_ms: number;
  state_truncated: boolean;
  status: "ok" | "error";
  error_code?: string;
}

export async function emitDecision(t: DecisionTelemetry): Promise<void> {
  const nowNano = String(BigInt(Date.now()) * 1_000_000n);
  const summary = `addita.decision id=${t.id}${t.ref ? ` ref=${t.ref}` : ""} source=${t.source} teacher=${t.teacher} final=${JSON.stringify(t.final)}`;
  const logPayload = {
    resourceLogs: [
      {
        resource: { attributes: resourceAttributes() },
        scopeLogs: [
          {
            scope: { name: "addita" },
            logRecords: [
              {
                timeUnixNano: nowNano,
                severityNumber: t.status === "error" ? 17 : 9,
                severityText: t.status === "error" ? "ERROR" : "INFO",
                body: { stringValue: summary },
                attributes: toAttributes({
                  "event.name": "addita.decision",
                  id: t.id,
                  ref: t.ref ?? undefined,
                  preset: t.preset,
                  model: t.model,
                  teacher_model: t.teacher_model,
                  teacher_host: t.teacher_host,
                  source: t.source,
                  teacher: t.teacher,
                  guards: t.guards,
                  agreement: t.agreement,
                  final: t.final,
                  noul: t.noul,
                  student_ms: t.student_ms,
                  teacher_ms: t.teacher_ms,
                  total_ms: t.total_ms,
                  state_truncated: t.state_truncated,
                  status: t.status,
                  error_code: t.error_code,
                }),
              },
            ],
          },
        ],
      },
    ],
  };

  const metrics: unknown[] = [
    {
      name: "addita.decide.ms",
      unit: "ms",
      gauge: {
        dataPoints: [
          {
            timeUnixNano: nowNano,
            asDouble: t.total_ms,
            attributes: toAttributes({ source: t.source }),
          },
        ],
      },
    },
    {
      name: "addita.decide.count",
      unit: "1",
      sum: {
        isMonotonic: true,
        aggregationTemporality: 1,
        dataPoints: [
          {
            timeUnixNano: nowNano,
            asInt: "1",
            attributes: toAttributes({ source: t.source, status: t.status }),
          },
        ],
      },
    },
  ];

  if (t.teacher_ms !== undefined) {
    metrics.push({
      name: "addita.teacher.ms",
      unit: "ms",
      gauge: {
        dataPoints: [
          {
            timeUnixNano: nowNano,
            asDouble: t.teacher_ms,
            attributes: toAttributes({ teacher_model: t.teacher_model }),
          },
        ],
      },
    });
  }

  const agreeVals = Object.values(t.agreement);
  if (agreeVals.length > 0) {
    const rate = agreeVals.filter(Boolean).length / agreeVals.length;
    metrics.push({
      name: "addita.agreement",
      unit: "1",
      gauge: {
        dataPoints: [
          {
            timeUnixNano: nowNano,
            asDouble: rate,
            attributes: toAttributes({ preset: t.preset ?? "inline" }),
          },
        ],
      },
    });
  }

  const metricsPayload = {
    resourceMetrics: [
      {
        resource: { attributes: resourceAttributes() },
        scopeMetrics: [
          {
            scope: { name: "addita" },
            metrics,
          },
        ],
      },
    ],
  };

  await Promise.all([postOtlp("/v1/logs", logPayload), postOtlp("/v1/metrics", metricsPayload)]);
}

export async function emitDecisionFinal(t: {
  id: string;
  ref?: string | null;
  final: Record<string, unknown>;
  source: string;
  teacher_model: string;
  teacher_host: string;
  teacher_ms: number;
}): Promise<void> {
  const nowNano = String(BigInt(Date.now()) * 1_000_000n);
  const summary = `addita.decision.final id=${t.id}${t.ref ? ` ref=${t.ref}` : ""} source=${t.source} final=${JSON.stringify(t.final)}`;
  await postOtlp("/v1/logs", {
    resourceLogs: [
      {
        resource: { attributes: resourceAttributes() },
        scopeLogs: [
          {
            scope: { name: "addita" },
            logRecords: [
              {
                timeUnixNano: nowNano,
                severityNumber: 9,
                severityText: "INFO",
                body: { stringValue: summary },
                attributes: toAttributes({
                  "event.name": "addita.decision.final",
                  id: t.id,
                  ref: t.ref ?? undefined,
                  final: t.final,
                  source: t.source,
                  teacher_model: t.teacher_model,
                  teacher_host: t.teacher_host,
                  teacher_ms: t.teacher_ms,
                }),
              },
            ],
          },
        ],
      },
    ],
  });
}

export async function emitLabel(t: {
  id: string;
  ref?: string | null;
  labels: Record<string, unknown>;
  by?: string;
}): Promise<void> {
  const nowNano = String(BigInt(Date.now()) * 1_000_000n);
  const summary = `addita.label id=${t.id}${t.ref ? ` ref=${t.ref}` : ""} by=${t.by ?? "operator"} labels=${JSON.stringify(t.labels)}`;
  await postOtlp("/v1/logs", {
    resourceLogs: [
      {
        resource: { attributes: resourceAttributes() },
        scopeLogs: [
          {
            scope: { name: "addita" },
            logRecords: [
              {
                timeUnixNano: nowNano,
                severityNumber: 9,
                severityText: "INFO",
                body: { stringValue: summary },
                attributes: toAttributes({
                  "event.name": "addita.label",
                  id: t.id,
                  ref: t.ref ?? undefined,
                  labels: t.labels,
                  by: t.by ?? "operator",
                }),
              },
            ],
          },
        ],
      },
    ],
  });
}
