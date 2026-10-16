import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { config } from "./config.js";
import * as ollaya from "./ollaya.js";
import * as ollama from "./ollama.js";
import * as lume from "./lume.js";
import {
  coerceTeacher,
  describeQuestions,
  simplifyOllaya,
  teacherSchema,
  type Questions,
  type SimpleAnswers,
} from "./questions.js";
import { store, type DecisionRow, type TeacherRow } from "./store.js";

// ---------------------------------------------------------------- presets

export interface Guard {
  name: string;
  pattern: string;
  flags?: string;
  set: SimpleAnswers;
}

export interface Preset {
  name: string;
  description?: string;
  model?: string;
  text_field?: string;
  questions: Questions;
  guards?: Guard[];
}

export function listPresets(): string[] {
  if (!existsSync(config.presetsDir)) return [];
  return readdirSync(config.presetsDir)
    .filter((f) => f.endsWith(".json"))
    .map((f) => f.replace(/\.json$/, ""));
}

export function loadPreset(name: string): Preset {
  if (!/^[A-Za-z0-9_.-]+$/.test(name)) throw new Error(`bad preset name "${name}"`);
  const p = join(config.presetsDir, `${name}.json`);
  if (!existsSync(p)) throw new Error(`preset "${name}" not found in ${config.presetsDir} (have: ${listPresets().join(", ") || "none"})`);
  return { name, ...JSON.parse(readFileSync(p, "utf8")) };
}

/** Text the guards run against: the state itself, or one field of it. */
function guardText(state: unknown, field?: string): string {
  if (typeof state === "string") return state;
  if (field && state && typeof state === "object") {
    const v = (state as any)[field] ?? (state as any).transmission?.[field];
    if (typeof v === "string") return v;
  }
  return JSON.stringify(state ?? "");
}

function applyGuards(preset: Preset | undefined, state: unknown, questions: Questions, answers: SimpleAnswers) {
  const hits: string[] = [];
  if (!preset?.guards?.length) return { answers, hits };
  const t = guardText(state, preset.text_field);
  const out = { ...answers };
  for (const g of preset.guards) {
    if (!new RegExp(g.pattern, g.flags).test(t)) continue;
    hits.push(g.name);
    for (const [q, v] of Object.entries(g.set)) if (q in questions) out[q] = v;
  }
  return { answers: out, hits };
}

// ---------------------------------------------------------------- teacher

const SYSTEM = `You are labelling radio and message traffic to train a small decision model.
Read the state, then answer every question exactly as specified.
Use only the labels, levels or booleans offered. Give a short reason for each answer.
Reply with JSON only.`;

async function askTeacher(
  state: unknown,
  questions: Questions,
  student?: SimpleAnswers,
): Promise<Omit<TeacherRow, "id" | "ts" | "backfill">> {
  const parts = [
    `STATE:\n${typeof state === "string" ? state : JSON.stringify(state, null, 2)}`,
    `QUESTIONS:\n${describeQuestions(questions)}`,
  ];
  const seeStudent = config.teacherSeesStudent && student && Object.keys(student).length > 0;
  if (seeStudent) parts.push(`A smaller model answered: ${JSON.stringify(student)}. Correct it where it is wrong.`);

  const t0 = Date.now();
  const res = await ollama.chat(
    [
      { role: "system", content: SYSTEM },
      { role: "user", content: parts.join("\n\n") },
    ],
    { format: teacherSchema(questions), options: { temperature: 0 } },
  );
  let parsed: any;
  try {
    parsed = JSON.parse(res.content);
  } catch {
    throw new Error(`teacher returned non-JSON: ${res.content.slice(0, 200)}`);
  }
  const answers: SimpleAnswers = {};
  const reasons: Record<string, string> = {};
  for (const [id, q] of Object.entries(questions)) {
    const item = parsed?.[id];
    const raw = item && typeof item === "object" && "answer" in item ? item.answer : item;
    const v = coerceTeacher(q, raw);
    if (v !== undefined) answers[id] = v;
    if (typeof item?.reason === "string") reasons[id] = item.reason;
  }
  if (Object.keys(answers).length === 0) throw new Error("teacher answered none of the questions in a valid form");
  return { model: res.model, answers, reasons, latency_ms: Date.now() - t0, saw_student: !!seeStudent };
}

// ---------------------------------------------------------------- decide

export interface DecideInput {
  state: unknown;
  context?: unknown;
  preset?: string;
  questions?: Questions;
  model?: string;
  teacher?: "auto" | "skip" | "require";
  /** Pull related past traffic from Lume into the context (default on when Lume is available). */
  lume_context?: boolean;
}

/**
 * Recent related traffic from the Lume log, as compact context. Works with
 * Ollama offline: it is keyword search plus frontmatter filters.
 */
async function lumeContext(transcript: string, excludeId?: string) {
  const k = config.lume.contextHits;
  const q = lume.plainQuery(transcript);
  if (k <= 0 || !q) return { items: [] as unknown[] };
  try {
    const hits = (await lume.search(q, { limit: k + 1, sinceHours: config.lume.contextHours })).filter(
      (h) => h.id && h.id !== excludeId,
    );
    if (!hits.length) return { items: [] };
    const byId = new Map(store.joined().map((r) => [r.id, r]));
    const items = hits.slice(0, k).flatMap((h) => {
      const r = byId.get(h.id!);
      if (!r) return [];
      return [
        {
          when: r.ts,
          ...(r.meta ?? {}),
          transcript: r.transcript ?? lume.transcriptOf(r.state),
          decision: { ...r.final, ...(r.label?.labels ?? {}) },
          corrected_by_operator: !!r.label,
        },
      ];
    });
    return { items };
  } catch (e: any) {
    return { items: [], error: e.message };
  }
}

/**
 * The loop:
 *   1. Ollaya (student) answers first. Fast, always local.
 *   2. If Ollama is online, the teacher answers the same questions. Both are logged:
 *      that pair is a training row for the decision model.
 *   3. The returned answer is the teacher's when it answered, else the student's.
 *   4. Deterministic guards (e.g. MAYDAY) override both.
 */
export async function decide(input: DecideInput) {
  const preset = input.preset || (!input.questions ? config.defaultPreset : undefined);
  const p = preset ? loadPreset(preset) : undefined;
  const questions: Questions = input.questions ?? p!.questions;
  if (!questions || Object.keys(questions).length === 0) throw new Error("no questions: pass questions or a preset");
  const model = input.model ?? p?.model ?? config.ollayaModel;

  const id = randomUUID();
  const ts = new Date().toISOString();
  const transcript = lume.transcriptOf(input.state, p?.text_field);
  const meta = lume.metaOf(input.state, p?.text_field);

  // 0. memory: related recent traffic from Lume (no model needed)
  const useLume = input.lume_context ?? true;
  const lc = useLume && (await lume.version()) ? await lumeContext(transcript) : { items: [] as unknown[] };
  let context: unknown = input.context;
  if (lc.items.length) context = input.context === undefined ? { recent_traffic: lc.items } : { notes: input.context, recent_traffic: lc.items };

  let state = input.state;
  if (context !== undefined) {
    state =
      state && typeof state === "object" && !Array.isArray(state)
        ? { ...(state as object), context }
        : { transmission: state, context };
  }

  // 1. student
  let student: DecisionRow["student"] = null;
  let studentError: string | undefined;
  const s0 = Date.now();
  try {
    const r = await ollaya.decide(model, state, questions);
    const simple: SimpleAnswers = {};
    for (const [qid, q] of Object.entries(questions)) {
      const v = simplifyOllaya(q, r.answers?.[qid]);
      if (v !== undefined) simple[qid] = v;
    }
    student = { model: r.model, answers: r.answers, simple, latency_ms: Date.now() - s0 };
  } catch (e: any) {
    studentError = e.message;
  }

  // 2. teacher
  const mode = input.teacher ?? (config.teacherMode === "off" ? "skip" : config.teacherMode === "always" ? "require" : "auto");
  let teacher: TeacherRow | undefined;
  let teacherStatus: string;
  if (mode === "skip") {
    teacherStatus = "skipped";
  } else if (!(await ollama.isOnline())) {
    teacherStatus = "offline";
  } else {
    try {
      teacher = { id, ts: new Date().toISOString(), backfill: false, ...(await askTeacher(state, questions, student?.simple)) };
      teacherStatus = "answered";
    } catch (e: any) {
      teacherStatus = `error: ${e.message}`;
    }
  }
  if (mode === "require" && !teacher) throw new Error(`teacher required but ${teacherStatus}`);
  if (!student && !teacher) throw new Error(`no model answered. ollaya: ${studentError}; ollama: ${teacherStatus}`);

  // 3. final answer: teacher first, student fills any gaps
  const merged: SimpleAnswers = { ...(student?.simple ?? {}), ...(teacher?.answers ?? {}) };
  let source: DecisionRow["final_source"] = teacher ? "teacher" : "student";

  // 4. guards
  const g = applyGuards(p, input.state, questions, merged);
  if (g.hits.length) source = "guard";

  const row: DecisionRow = {
    id,
    ts,
    preset,
    state,
    transcript,
    meta,
    questions,
    student,
    ...(studentError ? { student_error: studentError } : {}),
    final: g.answers,
    final_source: source,
    guards: g.hits,
  };
  store.addDecision(row);
  if (teacher) store.addTeacher(teacher);
  await lume.log(row, teacher);

  const agreement: Record<string, boolean> = {};
  if (student && teacher) {
    for (const qid of Object.keys(teacher.answers)) {
      if (qid in student.simple) agreement[qid] = student.simple[qid] === teacher.answers[qid];
    }
  }

  return {
    id,
    answers: g.answers,
    source,
    guards: g.hits,
    student: student
      ? {
          model: student.model,
          answers: student.simple,
          confidence: Object.fromEntries(
            Object.entries(student.answers).map(([k, a]: [string, any]) => [k, a?.confidence ?? a?.noul ?? null]),
          ),
          latency_ms: student.latency_ms,
        }
      : { error: studentError },
    teacher: teacher
      ? { model: teacher.model, answers: teacher.answers, reasons: teacher.reasons, latency_ms: teacher.latency_ms }
      : { status: teacherStatus },
    agreement,
    lume: (await lume.version())
      ? { context_items: lc.items.length, ...("error" in lc ? { error: lc.error } : {}) }
      : { status: "not available" },
  };
}

// ---------------------------------------------------------------- backfill

/** Ask the teacher about stored decisions it never saw (Ollama was offline at the time). */
export async function backfill(limit = 25) {
  if (!(await ollama.isOnline(true))) return { status: "offline", labelled: 0, remaining: undefined };
  const pending = store.joined().filter((r) => !r.teacher);
  let labelled = 0;
  const errors: string[] = [];
  for (const r of pending.slice(0, limit)) {
    try {
      const t = await askTeacher(r.state, r.questions, r.student?.simple);
      const row: TeacherRow = { id: r.id, ts: new Date().toISOString(), backfill: true, ...t };
      store.addTeacher(row);
      await lume.log(r, row, r.label);
      labelled++;
    } catch (e: any) {
      errors.push(`${r.id}: ${e.message}`);
      if (!(await ollama.isOnline(true))) break;
    }
  }
  return { status: "ok", labelled, remaining: pending.length - labelled, errors: errors.slice(0, 5) };
}

// ---------------------------------------------------------------- labels

export async function label(id: string, labels: SimpleAnswers, by?: string, note?: string) {
  const row = store.joined().find((r) => r.id === id);
  if (!row) throw new Error(`no decision with id ${id}`);
  const unknown = Object.keys(labels).filter((k) => !(k in row.questions));
  if (unknown.length) throw new Error(`not questions on this decision: ${unknown.join(", ")}`);
  const clean: SimpleAnswers = {};
  for (const [k, v] of Object.entries(labels)) {
    const c = coerceTeacher(row.questions[k], v);
    if (c === undefined) throw new Error(`"${String(v)}" is not a valid answer for ${k}`);
    clean[k] = c;
  }
  const l = { id, ts: new Date().toISOString(), labels: clean, by, note };
  store.addLabel(l);
  await lume.log(row, row.teacher, { ...l, labels: { ...(row.label?.labels ?? {}), ...clean } });
  return { id, labels: clean };
}
