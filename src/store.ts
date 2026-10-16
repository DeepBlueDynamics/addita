import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { config } from "./config.js";
import type { Questions, SimpleAnswers } from "./questions.js";

/**
 * Append-only JSONL store. Three files, merged on read by decision id:
 *   decisions.jsonl  every call: state, questions, student answers, final answer
 *   teacher.jsonl    teacher (Ollama) answers, written live or by backfill
 *   labels.jsonl     human corrections: the only gold labels
 */

export interface DecisionRow {
  id: string;
  ts: string;
  ref?: string | null;
  preset?: string;
  /** The state exactly as the models saw it (context included). */
  state: unknown;
  /** The transmission text alone, before any context was added. */
  transcript?: string;
  /** Scalar fields of the original state (channel, duration_s, ...), for the Lume log. */
  meta?: Record<string, string | number | boolean>;
  questions: Questions;
  student: {
    model: string;
    answers: Record<string, any>; // raw Ollaya answers (probabilities kept for calibration)
    simple: SimpleAnswers;
    latency_ms: number;
  } | null;
  student_error?: string;
  teacher_status?: "answered" | "pending" | "skipped" | "failed";
  teacher_model?: string;
  teacher_host?: string;
  /** True when local teacher answered because the primary cloud teacher failed; backfill will re-ask cloud. */
  cloud_pending?: boolean;
  student_ms?: number;
  teacher_ms?: number;
  final: SimpleAnswers;
  final_source: "teacher" | "student" | "guard" | "none";
  guards: string[];
}

export interface TeacherRow {
  id: string;
  ts: string;
  model: string;
  host?: string;
  answers: SimpleAnswers;
  reasons: Record<string, string>;
  latency_ms: number;
  saw_student: boolean;
  backfill: boolean;
  /** True when this row came from the local fallback after a cloud teacher failure; cleared once cloud answers on backfill. */
  cloud_pending?: boolean;
}

export interface LabelRow {
  id: string;
  ts: string;
  labels: SimpleAnswers;
  by?: string;
  note?: string;
}

const file = (name: string) => join(config.dataDir, name);

function ensureDir() {
  if (!existsSync(config.dataDir)) mkdirSync(config.dataDir, { recursive: true });
}

function append(name: string, row: unknown) {
  ensureDir();
  appendFileSync(file(name), JSON.stringify(row) + "\n");
}

function readAll<T>(name: string): T[] {
  const p = file(name);
  if (!existsSync(p)) return [];
  const out: T[] = [];
  for (const line of readFileSync(p, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line));
    } catch {
      /* skip a torn line from a crash mid-write */
    }
  }
  return out;
}

export const store = {
  addDecision: (r: DecisionRow) => append("decisions.jsonl", r),
  addTeacher: (r: TeacherRow) => append("teacher.jsonl", r),
  addLabel: (r: LabelRow) => append("labels.jsonl", r),

  /** Every decision with its latest teacher answer and merged human labels. */
  joined() {
    const teacher = new Map<string, TeacherRow>();
    for (const t of readAll<TeacherRow>("teacher.jsonl")) teacher.set(t.id, t);
    const labels = new Map<string, LabelRow>();
    for (const l of readAll<LabelRow>("labels.jsonl")) {
      const prev = labels.get(l.id);
      labels.set(l.id, prev ? { ...l, labels: { ...prev.labels, ...l.labels } } : l);
    }
    return readAll<DecisionRow>("decisions.jsonl").map((d) => ({
      ...d,
      teacher: teacher.get(d.id),
      label: labels.get(d.id),
    }));
  },

  path: file,
};

export type JoinedRow = ReturnType<typeof store.joined>[number];
