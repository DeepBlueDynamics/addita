/**
 * Lume as Addita's log and memory.
 *
 * Every decision becomes one Markdown file (frontmatter = filterable fields,
 * body = the transcript and the decision). A debounced `lume index` keeps a
 * dedicated index current, and `lume search` finds past traffic, both for the
 * comms_search tool and as automatic context for new decisions.
 *
 * None of this touches Ollama: BM25, frontmatter filters and the callsign
 * dictionary graph run without a model. Optional dense vectors come from
 * Shivvr (LUME_INDEX_ARGS="-s"), not from Ollama.
 */
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { config } from "./config.js";
import type { SimpleAnswers } from "./questions.js";
import type { DecisionRow, LabelRow, TeacherRow } from "./store.js";

const L = config.lume;

function run(args: string[]): Promise<{ stdout: string; stderr: string }> {
  return new Promise((ok, fail) => {
    execFile(L.bin, args, { timeout: L.timeoutMs, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) fail(new Error(`${L.bin} ${args[0]} failed: ${(stderr || err.message).toString().trim().slice(-400)}`));
      else ok({ stdout: stdout.toString(), stderr: stderr.toString() });
    });
  });
}

// ------------------------------------------------------------ availability

let available: Promise<string | null> | undefined;

/** Lume version string, or null when it is off or not installed. */
export function version(): Promise<string | null> {
  if (L.mode === "off") return Promise.resolve(null);
  available ??= run(["--version"]).then(
    (r) => r.stdout.trim().split("\n")[0] || "lume",
    () => null,
  );
  return available;
}

// ------------------------------------------------------------ documents

type Scalar = string | number | boolean;

const yaml = (v: Scalar) => (typeof v === "string" ? JSON.stringify(v) : String(v));
const fmKey = (k: string) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(k);

export function docPath(id: string, ts: string) {
  return join(L.docsDir, ts.slice(0, 10), `${id}.md`);
}

/** The transmission text: the preset's text field, a bare string, or the JSON. */
export function transcriptOf(state: unknown, field?: string): string {
  if (typeof state === "string") return state;
  if (state && typeof state === "object" && !Array.isArray(state)) {
    const s = state as Record<string, unknown>;
    for (const k of [field, "transcript", "text", "message"]) {
      if (k && typeof s[k] === "string") return s[k] as string;
    }
  }
  return JSON.stringify(state ?? "");
}

/** Scalar, frontmatter-safe fields of the original state (not the text, not context). */
export function metaOf(state: unknown, field?: string): Record<string, Scalar> {
  const out: Record<string, Scalar> = {};
  if (!state || typeof state !== "object" || Array.isArray(state)) return out;
  for (const [k, v] of Object.entries(state as Record<string, unknown>)) {
    if (k === field || k === "context" || !fmKey(k)) continue;
    if (typeof v === "string" ? v.length <= 200 && !v.includes("\n") : typeof v === "number" || typeof v === "boolean") {
      out[k] = v as Scalar;
    }
  }
  return out;
}

function words(a: SimpleAnswers) {
  return Object.entries(a)
    .map(([k, v]) => `${k} ${typeof v === "boolean" ? (v ? "yes" : "no") : v}`)
    .join(", ");
}

/**
 * Render one decision. Re-rendered whenever the teacher or a human adds to it,
 * so the log always shows the best answer known and what is still pending.
 */
export function render(d: DecisionRow, teacher?: TeacherRow, label?: LabelRow): string {
  const best: SimpleAnswers = { ...d.final, ...(label?.labels ?? {}) };
  const reserved = new Set(["id", "ts", "epoch", "day", "preset", "source", "teacher", "labelled", "guards", ...Object.keys(d.questions)]);

  const fm: Record<string, Scalar> = {};
  fm.id = d.id;
  fm.ts = d.ts;
  fm.epoch = Math.floor(Date.parse(d.ts) / 1000);
  fm.day = d.ts.slice(0, 10);
  for (const [k, v] of Object.entries(d.meta ?? {})) if (!reserved.has(k)) fm[k] = v;
  if (d.preset) fm.preset = d.preset;
  fm.source = label ? "human" : d.final_source;
  fm.teacher = teacher ? "answered" : "pending";
  fm.labelled = !!label;
  if (d.guards.length) fm.guards = d.guards.join(",");
  for (const [k, v] of Object.entries(best)) if (fmKey(k)) fm[k] = v;

  const text = d.transcript ?? transcriptOf(d.state);
  const time = d.ts.slice(11, 19);
  const channel = d.meta?.channel !== undefined ? `ch${d.meta.channel} ` : "";
  const lines = [
    "---",
    ...Object.entries(fm).map(([k, v]) => `${k}: ${yaml(v)}`),
    "---",
    `# ${channel}${time}Z ${String(best.priority ?? best.intent ?? "")}`.trimEnd(),
    "",
    ...text.split("\n").map((l) => `> ${l}`),
    "",
    `Decision: ${words(best)}. Source: ${fm.source}${d.guards.length ? ` (guards: ${d.guards.join(", ")})` : ""}.`,
  ];
  if (d.student) {
    const differs = Object.keys(d.student.simple).some((k) => d.student!.simple[k] !== best[k]);
    if (differs) lines.push(`Ollaya (${d.student.model}) said: ${words(d.student.simple)}.`);
  }
  if (teacher) {
    lines.push(`Ollama (${teacher.model}) said: ${words(teacher.answers)}.`);
    const reasons = Object.entries(teacher.reasons).map(([k, r]) => `${k}: ${r}`);
    if (reasons.length) lines.push("", "Teacher reasons:", ...reasons.map((r) => `- ${r}`));
  } else {
    lines.push("Ollama teacher: pending (offline or skipped at the time).");
  }
  if (label) lines.push(`Corrected by ${label.by ?? "operator"}: ${words(label.labels)}.${label.note ? ` ${label.note}` : ""}`);
  // Lume skips markdown sections under 100 characters; this line guarantees the length.
  lines.push("", `Logged by Addita, decision ${d.id}.`, "");
  return lines.join("\n");
}

/** Write (or rewrite) a decision's document and schedule a reindex. No-op when Lume is off. */
export async function log(d: DecisionRow, teacher?: TeacherRow, label?: LabelRow) {
  if (!(await version())) return;
  const p = docPath(d.id, d.ts);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, render(d, teacher, label));
  scheduleReindex();
}

// ------------------------------------------------------------ indexing

let timer: NodeJS.Timeout | undefined;
let running: Promise<void> | undefined;
let dirty = false;
let lastIndex: { at: string; ok: boolean; message: string } | undefined;

function hasDocs(): boolean {
  if (!existsSync(L.docsDir)) return false;
  return readdirSync(L.docsDir).some((d) => {
    const p = join(L.docsDir, d);
    return statSync(p).isDirectory() && readdirSync(p).some((f) => f.endsWith(".md"));
  });
}

export function scheduleReindex() {
  dirty = true;
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => void reindex(), L.reindexDebounceMs);
  timer.unref?.();
}

/** Incremental `lume index`; serialized, and re-run if writes landed meanwhile. */
export async function reindex(): Promise<typeof lastIndex> {
  if (timer) clearTimeout(timer);
  timer = undefined;
  if (running) {
    await running;
    if (!dirty) return lastIndex;
  }
  if (!(await version()) || !hasDocs()) return lastIndex;
  dirty = false;
  const args = ["index", L.docsDir, "--db", L.db];
  if (L.tagDict && existsSync(L.tagDict)) args.push("--tag-dict", L.tagDict);
  args.push(...L.indexArgs.filter((a) => a !== "-o" && a !== "--ollama-entities"));
  running = run(args)
    .then((r) => {
      const m = (r.stdout + r.stderr).match(/Indexing (\d+) sections total \((\d+) files indexed this run/);
      lastIndex = { at: new Date().toISOString(), ok: true, message: m ? `${m[1]} sections, ${m[2]} files updated` : "ok" };
    })
    .catch((e) => {
      dirty = true;
      lastIndex = { at: new Date().toISOString(), ok: false, message: e.message };
    })
    .finally(() => {
      running = undefined;
    });
  await running;
  if (dirty) scheduleReindex();
  return lastIndex;
}

export function indexState() {
  return { pending: dirty || !!running || !!timer, last: lastIndex };
}

// ------------------------------------------------------------ search

export interface Hit {
  rank: number;
  score: number;
  title: string;
  file: string;
  id?: string;
  snippet: string;
}

const ANSI = /\x1b\[[0-9;]*m/g;
const HIT = /^\[(\d+)\] Score: ([\d.]+)(?: \[[^\]]*\])* \| (.*) \(File: (.*), Line: \d+\)\s*$/;

export function parseHits(stdout: string): Hit[] {
  const hits: Hit[] = [];
  let cur: Hit | undefined;
  for (const raw of stdout.replace(ANSI, "").split("\n")) {
    const m = raw.match(HIT);
    if (m) {
      cur = { rank: +m[1], score: +m[2], title: m[3], file: m[4], snippet: "" };
      const b = basename(m[4]);
      if (b.endsWith(".md")) cur.id = b.slice(0, -3);
      hits.push(cur);
    } else if (cur) {
      if (/^Facets:/.test(raw)) cur = undefined;
      else cur.snippet += (cur.snippet ? "\n" : "") + raw;
    }
  }
  for (const h of hits) h.snippet = h.snippet.trim();
  return hits;
}

/** Strip characters Lume would read as operators (-term, NOT, field:value). */
export function plainQuery(text: string, maxWords = 24): string {
  return text
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/)
    .filter((w) => w && w !== "NOT")
    .slice(0, maxWords)
    .join(" ");
}

/** Run a search. `query` may use Lume's syntax (-term, field:value). */
export async function search(query: string, opts: { limit?: number; sinceHours?: number } = {}): Promise<Hit[]> {
  if (!(await version())) throw new Error(`Lume is not available (${config.lume.mode === "off" ? "ADDITA_LUME=off" : `"${L.bin}" did not run`})`);
  if (!existsSync(L.db)) return [];
  let q = query.trim();
  if (opts.sinceHours !== undefined) q += ` epoch:>=${Math.floor(Date.now() / 1000 - opts.sinceHours * 3600)}`;
  const { stdout } = await run(["search", "--db", L.db, "-l", String(opts.limit ?? 10), q]);
  return parseHits(stdout);
}
