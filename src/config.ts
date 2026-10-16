import { homedir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const env = process.env;
const here = dirname(fileURLToPath(import.meta.url));

function num(name: string, fallback: number): number {
  const v = env[name];
  if (v === undefined || v === "") return fallback;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`${name} must be a number, got "${v}"`);
  return n;
}

function bool(name: string): boolean | undefined {
  const v = env[name]?.toLowerCase();
  if (v === undefined || v === "") return undefined;
  return ["1", "true", "yes", "on"].includes(v);
}

export type TeacherMode = "auto" | "off" | "always";

export const config = {
  /** HTTP server host (bound to 0.0.0.0 by default so containers are reachable). */
  host: env.ADDITA_HOST ?? "0.0.0.0",
  /** HTTP server port (11345 by default). */
  port: num("ADDITA_PORT", 11345),
  /** Optional path to Bearer token file for HTTP endpoints. */
  tokenFile: env.ADDITA_TOKEN_FILE || undefined,
  /** Path to serve.json discovery file. */
  serveJson: resolve(env.ADDITA_SERVE_JSON ?? join(env.ADDITA_DATA_DIR ?? join(homedir(), ".addita"), "serve.json")),

  /** Ollaya daemon (the student / decision model). */
  ollayaUrl: (env.OLLAYA_URL ?? "http://127.0.0.1:11435").replace(/\/+$/, ""),
  ollayaApiKey: env.OLLAYA_API_KEY || undefined,
  ollayaModel: env.OLLAYA_MODEL ?? "laya",
  ollayaTimeoutMs: num("OLLAYA_TIMEOUT_MS", 30_000),

  /** Ollama daemon (the teacher LLM, also proxied). */
  ollamaUrl: (env.OLLAMA_URL ?? "http://127.0.0.1:11434").replace(/\/+$/, ""),
  /** Primary (cloud by default) teacher model. */
  ollamaModel: env.OLLAMA_MODEL ?? "deepseek-v4.1-flash:cloud",
  /** Local fallback teacher model used when cloud fails or ADDITA_NO_CLOUD=true. */
  ollamaLocalModel: env.OLLAMA_LOCAL_MODEL !== undefined ? env.OLLAMA_LOCAL_MODEL : "qwen3.5:4b",
  ollamaTimeoutMs: num("OLLAMA_TIMEOUT_MS", 120_000),
  /** Pass `think` to Ollama only when set; teacher calls default to think:false so reasoning models don't stall or break JSON schema. */
  ollamaThink: bool("OLLAMA_THINK"),
  /** How long an online/offline probe result is trusted. */
  ollamaProbeTtlMs: num("OLLAMA_PROBE_TTL_MS", 10_000),

  /**
   * auto:   teacher answers when Ollama is reachable, student otherwise.
   * off:    never call the teacher (pure Ollaya).
   * always: same as auto, but a teacher failure is reported as an error
   *         instead of silently falling back.
   */
  teacherMode: (env.ADDITA_TEACHER ?? "auto") as TeacherMode,
  /** When true the teacher is shown the student's answers (biases labels; off by default). */
  teacherSeesStudent: bool("ADDITA_TEACHER_SEES_STUDENT") ?? false,
  /** When true (ADDITA_NO_CLOUD), never send anything to a cloud teacher, including backfill (default false). */
  noCloud: bool("ADDITA_NO_CLOUD") ?? false,

  dataDir: resolve(env.ADDITA_DATA_DIR ?? join(homedir(), ".addita")),
  presetsDir: resolve(env.ADDITA_PRESETS_DIR ?? join(here, "..", "presets")),
  defaultPreset: env.ADDITA_PRESET ?? "comms",

  /** Lume: log every decision as a document, search it, feed it back as context. */
  lume: {
    /** auto: use Lume when the binary runs; off: never. */
    mode: (env.ADDITA_LUME ?? "auto") as "auto" | "off",
    bin: env.LUME_BIN ?? "lume",
    /** Markdown log the index is built from (one file per decision). */
    docsDir: resolve(env.LUME_DOCS_DIR ?? join(env.ADDITA_DATA_DIR ?? join(homedir(), ".addita"), "lume-docs")),
    /** A dedicated index, so the radio log never mixes with other corpora. */
    db: resolve(env.LUME_DB ?? join(env.ADDITA_DATA_DIR ?? join(homedir(), ".addita"), "lume-db")),
    /** FST dictionary of callsigns/vessels: graph entities with no model. */
    tagDict: env.LUME_TAG_DICT ?? join(here, "..", "presets", "callsigns.csv"),
    /** Extra `lume index` flags, e.g. "-s" when Shivvr runs. Never put -o here (that needs Ollama). */
    indexArgs: (env.LUME_INDEX_ARGS ?? "").split(/\s+/).filter(Boolean),
    reindexDebounceMs: num("LUME_REINDEX_DEBOUNCE_MS", 3000),
    /** Past transmissions added to each decision's state as context (0 = off). */
    contextHits: num("LUME_CONTEXT_HITS", 3),
    contextHours: num("LUME_CONTEXT_HOURS", 24),
    timeoutMs: num("LUME_TIMEOUT_MS", 60_000),
    /** Path to ~/.lume/serve.json for OTLP discovery. */
    serveJson: resolve(env.LUME_SERVE_JSON ?? join(homedir(), ".lume", "serve.json")),
  },
};

if (!["auto", "off"].includes(config.lume.mode)) {
  throw new Error(`ADDITA_LUME must be auto or off, got "${config.lume.mode}"`);
}

if (!["auto", "off", "always"].includes(config.teacherMode)) {
  throw new Error(`ADDITA_TEACHER must be auto, off or always, got "${config.teacherMode}"`);
}
