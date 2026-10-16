import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { config } from "./config.js";
import { bucket, studentProbs, valueKey, type SimpleAnswers, type SimpleValue } from "./questions.js";
import { store, type JoinedRow } from "./store.js";

type LabelSource = "human" | "teacher";

/** Per-question training label: human beats teacher; the student never labels itself. */
function labelsFor(r: JoinedRow, allowTeacher: boolean) {
  const labels: SimpleAnswers = {};
  const source: Record<string, LabelSource> = {};
  for (const q of Object.keys(r.questions)) {
    const h = r.label?.labels[q];
    const t = r.teacher?.answers[q];
    if (h !== undefined) {
      labels[q] = h;
      source[q] = "human";
    } else if (allowTeacher && t !== undefined) {
      labels[q] = t;
      source[q] = "teacher";
    }
  }
  return { labels, source };
}

function rate(hit: number, n: number) {
  return n ? Math.round((hit / n) * 1000) / 1000 : null;
}

// ---------------------------------------------------------------- stats

export function stats() {
  const rows = store.joined();
  const perQ: Record<string, { student_vs_teacher: [number, number]; student_vs_human: [number, number]; teacher_vs_human: [number, number] }> = {};
  const guards: Record<string, number> = {};
  const sources: Record<string, number> = {};
  for (const r of rows) {
    sources[r.final_source] = (sources[r.final_source] ?? 0) + 1;
    for (const g of r.guards) guards[g] = (guards[g] ?? 0) + 1;
    for (const q of Object.keys(r.questions)) {
      const s = r.student?.simple[q];
      const t = r.teacher?.answers[q];
      const h = r.label?.labels[q];
      const e = (perQ[q] ??= { student_vs_teacher: [0, 0], student_vs_human: [0, 0], teacher_vs_human: [0, 0] });
      const cmp = (a: SimpleValue | undefined, b: SimpleValue | undefined, k: keyof typeof e) => {
        if (a === undefined || b === undefined) return;
        e[k][1]++;
        if (a === b) e[k][0]++;
      };
      cmp(s, t, "student_vs_teacher");
      cmp(s, h, "student_vs_human");
      cmp(t, h, "teacher_vs_human");
    }
  }
  return {
    data_dir: config.dataDir,
    decisions: rows.length,
    with_teacher: rows.filter((r) => r.teacher).length,
    awaiting_teacher: rows.filter((r) => !r.teacher).length,
    human_labelled: rows.filter((r) => r.label).length,
    final_source: sources,
    guard_hits: guards,
    questions: Object.fromEntries(
      Object.entries(perQ).map(([q, e]) => [
        q,
        {
          student_agrees_with_teacher: rate(...e.student_vs_teacher),
          student_accuracy_vs_human: rate(...e.student_vs_human),
          teacher_accuracy_vs_human: rate(...e.teacher_vs_human),
          n: { teacher: e.student_vs_teacher[1], human: e.student_vs_human[1] },
        },
      ]),
    ),
  };
}

/** Recent rows where the student and teacher disagree: the best ones to label by hand. */
export function disagreements(limit = 10) {
  return store
    .joined()
    .filter((r) => r.student && r.teacher && !r.label)
    .map((r) => ({
      id: r.id,
      ts: r.ts,
      state: r.state,
      diff: Object.fromEntries(
        Object.keys(r.teacher!.answers)
          .filter((q) => r.student!.simple[q] !== undefined && r.student!.simple[q] !== r.teacher!.answers[q])
          .map((q) => [q, { student: r.student!.simple[q], teacher: r.teacher!.answers[q], reason: r.teacher!.reasons[q] }]),
      ),
    }))
    .filter((r) => Object.keys(r.diff).length > 0)
    .slice(-limit)
    .reverse();
}

// ---------------------------------------------------------------- export

/**
 * Writes train.jsonl and eval.jsonl. Eval holds only human-labelled rows
 * (a deterministic hash split of them), so the score you measure is never
 * graded by the teacher that produced the training labels.
 */
export function exportDataset(opts: { evalFraction?: number; includeTeacher?: boolean } = {}) {
  const evalFraction = opts.evalFraction ?? 0.3;
  const includeTeacher = opts.includeTeacher ?? true;
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const dir = join(config.dataDir, "exports", stamp);
  mkdirSync(dir, { recursive: true });

  const train: string[] = [];
  const evalRows: string[] = [];
  const counts = { human: 0, teacher_only: 0, skipped: 0 };

  for (const r of store.joined()) {
    const { labels, source } = labelsFor(r, includeTeacher);
    if (Object.keys(labels).length === 0) {
      counts.skipped++;
      continue;
    }
    const line = JSON.stringify({ id: r.id, state: r.state, questions: r.questions, labels, label_source: source });
    if (r.label) {
      counts.human++;
      const h = createHash("sha256").update(r.id).digest()[0] / 256;
      (h < evalFraction ? evalRows : train).push(line);
    } else {
      counts.teacher_only++;
      train.push(line);
    }
  }

  writeFileSync(join(dir, "train.jsonl"), train.join("\n") + (train.length ? "\n" : ""));
  writeFileSync(join(dir, "eval.jsonl"), evalRows.join("\n") + (evalRows.length ? "\n" : ""));
  return { dir, train: train.length, eval: evalRows.length, ...counts };
}

// ---------------------------------------------------------------- calibration

const SCALES = Array.from({ length: 61 }, (_, i) => Math.pow(10, -0.6 + i * 0.02)); // 0.25 … 4

function nll(samples: { probs: number[]; y: number }[], s: number) {
  let sum = 0;
  for (const { probs, y } of samples) {
    const logits = probs.map((p) => Math.log(Math.max(p, 1e-9)) / s);
    const m = Math.max(...logits);
    const lse = m + Math.log(logits.reduce((a, z) => a + Math.exp(z - m), 0));
    sum += lse - logits[y];
  }
  return sum / samples.length;
}

/**
 * Temperature scaling on stored student probabilities. Ollaya computes
 * p = softmax(z / T); refitting gives p' = softmax(z / (T·s)) = softmax(log p / s),
 * so the fit returns the multiplier s for each bucket. New temperature = T × s.
 */
export function fitCalibration(opts: { includeTeacher?: boolean; minSamples?: number; baseTemperatures?: Record<string, number> } = {}) {
  const min = opts.minSamples ?? 30;
  const buckets: Record<string, { probs: number[]; y: number }[]> = {};
  for (const r of store.joined()) {
    if (!r.student) continue;
    const { labels } = labelsFor(r, opts.includeTeacher ?? false);
    for (const [q, v] of Object.entries(labels)) {
      const question = r.questions[q];
      const sp = studentProbs(question, r.student.answers[q]);
      if (!sp) continue;
      const y = sp.labels.indexOf(valueKey(question, v));
      if (y < 0) continue;
      (buckets[bucket(question)] ??= []).push({ probs: sp.probs, y });
    }
  }

  const result: Record<string, unknown> = {};
  const temperature_by_options: Record<string, number> = {};
  for (const [b, samples] of Object.entries(buckets)) {
    const acc = samples.filter((s) => s.probs.indexOf(Math.max(...s.probs)) === s.y).length / samples.length;
    if (samples.length < min) {
      result[b] = { n: samples.length, accuracy: rate(acc * samples.length, samples.length), note: `need ${min} samples to fit` };
      continue;
    }
    let best = 1;
    let bestNll = nll(samples, 1);
    const before = bestNll;
    for (const s of SCALES) {
      const v = nll(samples, s);
      if (v < bestNll) [best, bestNll] = [s, v];
    }
    const scale = Math.round(best * 1000) / 1000;
    result[b] = {
      n: samples.length,
      accuracy: rate(acc * samples.length, samples.length),
      nll_before: Math.round(before * 10000) / 10000,
      nll_after: Math.round(bestNll * 10000) / 10000,
      temperature_multiplier: scale,
    };
    const base = opts.baseTemperatures?.[b];
    if (base !== undefined) temperature_by_options[b] = Math.round(base * scale * 1000) / 1000;
  }
  return {
    label_source: opts.includeTeacher ? "human + teacher" : "human only",
    buckets: result,
    ...(Object.keys(temperature_by_options).length ? { calibration: { temperature_by_options } } : {}),
  };
}
