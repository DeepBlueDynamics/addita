import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tryLoadLocalPreset } from "./addita.js";
import { config } from "./config.js";
import { bucket, studentProbs, valueKey, type SimpleAnswers, type SimpleValue } from "./questions.js";
import { store, type JoinedRow } from "./store.js";

export type LabelSource = "human" | "teacher" | "guard";

function resolveGroup(r: JoinedRow): string {
  if (typeof r.group === "string" && r.group.trim()) return r.group.trim();
  if (typeof r.ref === "string" && r.ref.trim()) return r.ref.trim();
  return r.id;
}

/** Resolve which questions on row `r` were forced by a deterministic guard, and to what values. */
export function guardOverridesFor(r: JoinedRow): {
  overrides: Record<string, string>;
  values: SimpleAnswers;
} {
  const overrides: Record<string, string> = {};
  const values: SimpleAnswers = {};

  if (r.guards && r.guards.length > 0) {
    const presetName = r.preset ?? config.defaultPreset;
    const preset = presetName ? tryLoadLocalPreset(presetName) : undefined;
    if (preset?.guards?.length) {
      const hitSet = new Set(r.guards);
      for (const g of preset.guards) {
        if (!hitSet.has(g.name)) continue;
        for (const [q, v] of Object.entries(g.set)) {
          if (q in r.questions) {
            overrides[q] = g.name;
            values[q] = v;
          }
        }
      }
    }
  }

  if (r.guard_overrides && typeof r.guard_overrides === "object") {
    for (const [q, gName] of Object.entries(r.guard_overrides)) {
      if (q in r.questions && typeof gName === "string") {
        overrides[q] = gName;
        if (values[q] === undefined && r.final?.[q] !== undefined) {
          values[q] = r.final[q];
        }
      }
    }
  }

  return { overrides, values };
}

/**
 * Per-question training label:
 * - Human beats guard and teacher (`"human"`).
 * - When `allowGuard` is true and a guard forced a question's final answer, use the guard's final answer (`"guard"`).
 * - When `allowTeacher` is true, use the teacher's answer (`"teacher"`).
 * - A missing label stays missing (never coerced to false).
 * - The student never labels itself.
 */
export function labelsFor(r: JoinedRow, allowTeacher: boolean, allowGuard = allowTeacher) {
  const labels: SimpleAnswers = {};
  const source: Record<string, LabelSource> = {};
  const guardInfo = allowGuard ? guardOverridesFor(r) : { overrides: {}, values: {} };

  for (const q of Object.keys(r.questions)) {
    const h = r.label?.labels[q];
    const gName = guardInfo.overrides[q];
    const gVal = guardInfo.values[q];
    const t = r.teacher?.answers[q];
    if (h !== undefined) {
      labels[q] = h;
      source[q] = "human";
    } else if (allowGuard && gName !== undefined && gVal !== undefined) {
      labels[q] = gVal;
      source[q] = "guard";
    } else if (allowTeacher && t !== undefined) {
      labels[q] = t;
      source[q] = "teacher";
    }
  }
  return { labels, source, guardOverrides: guardInfo.overrides };
}

function rate(hit: number, n: number) {
  return n ? Math.round((hit / n) * 1000) / 1000 : null;
}

// ---------------------------------------------------------------- stats

export function stats() {
  const rows = store.joined();
  const perQ: Record<string, { student_vs_teacher: [number, number]; student_vs_human: [number, number]; teacher_vs_human: [number, number] }> = {};
  const byTeacher: Record<
    string,
    {
      decisions: number;
      questions: Record<string, { student_vs_teacher: [number, number]; teacher_vs_human: [number, number] }>;
    }
  > = {};
  const guards: Record<string, number> = {};
  const sources: Record<string, number> = { human: 0, teacher: 0, guard: 0 };
  const labelSources: Record<LabelSource, number> = { human: 0, teacher: 0, guard: 0 };

  for (const r of rows) {
    const effectiveRowSource = r.label
      ? "human"
      : r.guards.length > 0
        ? "guard"
        : r.teacher
          ? "teacher"
          : r.final_source;
    sources[effectiveRowSource] = (sources[effectiveRowSource] ?? 0) + 1;

    const { source: qSources } = labelsFor(r, true, true);
    for (const s of Object.values(qSources)) {
      labelSources[s] = (labelSources[s] ?? 0) + 1;
    }

    for (const g of r.guards) guards[g] = (guards[g] ?? 0) + 1;
    const tModel = r.teacher?.model;
    const tEntry = tModel ? (byTeacher[tModel] ??= { decisions: 0, questions: {} }) : undefined;
    if (tEntry) tEntry.decisions++;

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

      if (tEntry) {
        const te = (tEntry.questions[q] ??= { student_vs_teacher: [0, 0], teacher_vs_human: [0, 0] });
        if (s !== undefined && t !== undefined) {
          te.student_vs_teacher[1]++;
          if (s === t) te.student_vs_teacher[0]++;
        }
        if (t !== undefined && h !== undefined) {
          te.teacher_vs_human[1]++;
          if (t === h) te.teacher_vs_human[0]++;
        }
      }
    }
  }
  return {
    data_dir: config.dataDir,
    decisions: rows.length,
    with_teacher: rows.filter((r) => r.teacher).length,
    awaiting_teacher: rows.filter((r) => !r.teacher).length,
    human_labelled: rows.filter((r) => r.label).length,
    final_source: sources,
    label_source: labelSources,
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
    by_teacher: Object.fromEntries(
      Object.entries(byTeacher).map(([model, t]) => [
        model,
        {
          decisions: t.decisions,
          questions: Object.fromEntries(
            Object.entries(t.questions).map(([q, e]) => [
              q,
              {
                student_agrees_with_teacher: rate(...e.student_vs_teacher),
                teacher_accuracy_vs_human: rate(...e.teacher_vs_human),
                n: { teacher: e.student_vs_teacher[1], human: e.teacher_vs_human[1] },
              },
            ]),
          ),
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
 * Writes train.jsonl, eval.jsonl, calibration.jsonl, and manifest.json:
 * 1. Partition by `group` (default chain: group -> ref -> id) BEFORE any per-question label selection.
 * 2. Hash bucket is decided by `sha256(group)[0] / 256` alone:
 *    - `[0, evalFraction)` -> eval.jsonl (human-labelled questions only; rows without human labels are dropped and counted as `held_out_unlabelled`).
 *    - `[evalFraction, evalFraction + calibrationFraction)` -> calibration.jsonl (train label policy and row shape).
 *    - `[evalFraction + calibrationFraction, 1)` -> train.jsonl (human > guard > teacher precedence, `guard_overrides`, and `teacher_labels`).
 * 3. `teacher_model` is the teacher that actually answered (`r.teacher?.model ?? null`), never a configured default fallback.
 */
export function exportDataset(
  opts: { evalFraction?: number; calibrationFraction?: number; includeTeacher?: boolean } = {},
) {
  const evalFraction = opts.evalFraction ?? 0.3;
  const calibrationFraction = opts.calibrationFraction ?? 0;
  const includeTeacher = opts.includeTeacher ?? true;

  if (!Number.isFinite(evalFraction) || evalFraction < 0 || evalFraction >= 1) {
    throw new Error(`eval_fraction must be in [0, 1), got ${evalFraction}`);
  }
  if (!Number.isFinite(calibrationFraction) || calibrationFraction < 0 || calibrationFraction >= 1) {
    throw new Error(`calibration_fraction must be in [0, 1), got ${calibrationFraction}`);
  }
  if (evalFraction + calibrationFraction >= 1) {
    throw new Error(
      `eval_fraction (${evalFraction}) + calibration_fraction (${calibrationFraction}) must be less than 1`,
    );
  }

  const exportedAt = new Date().toISOString();
  const stamp = exportedAt.replace(/[:.]/g, "-");
  const dir = join(config.dataDir, "exports", stamp);
  mkdirSync(dir, { recursive: true });

  const train: string[] = [];
  const evalRows: string[] = [];
  const calRows: string[] = [];
  const trainGroupSet = new Set<string>();
  const evalGroupSet = new Set<string>();
  const calGroupSet = new Set<string>();
  const counts = {
    human: 0,
    guard: 0,
    teacher_only: 0,
    held_out_unlabelled: 0,
    skipped: 0,
  };

  // 1. Partition by group BEFORE any per-question label selection
  const byGroup = new Map<string, JoinedRow[]>();
  for (const r of store.joined()) {
    const group = resolveGroup(r);
    let list = byGroup.get(group);
    if (!list) {
      list = [];
      byGroup.set(group, list);
    }
    list.push(r);
  }

  // 2. Assign each group to its band by group hash alone, then select labels per band
  for (const [group, groupRows] of byGroup.entries()) {
    const h = createHash("sha256").update(group).digest()[0] / 256;
    const band: "eval" | "calibration" | "train" =
      h < evalFraction
        ? "eval"
        : h < evalFraction + calibrationFraction
          ? "calibration"
          : "train";

    if (band === "eval") {
      for (const r of groupRows) {
        const humanOnly = labelsFor(r, false, false);
        if (Object.keys(humanOnly.labels).length === 0) {
          counts.held_out_unlabelled++;
          continue;
        }
        counts.human++;
        evalGroupSet.add(group);
        const evalObj: Record<string, unknown> = {
          id: r.id,
          ref: r.ref ?? null,
          group,
          created_at: r.ts,
          ...(r.preset ? { preset: r.preset } : {}),
          teacher_model: r.teacher?.model ?? null,
          state: r.state,
          questions: r.questions,
          labels: humanOnly.labels,
          label_source: humanOnly.source,
        };
        evalRows.push(JSON.stringify(evalObj));
      }
    } else {
      for (const r of groupRows) {
        const humanOnly = labelsFor(r, false, false);
        const trainLabels = labelsFor(r, includeTeacher, includeTeacher);
        if (Object.keys(trainLabels.labels).length === 0) {
          counts.skipped++;
          continue;
        }
        const hasHuman = Object.keys(humanOnly.labels).length > 0;
        const hasGuard = Object.keys(trainLabels.guardOverrides).length > 0;
        if (hasHuman) {
          counts.human++;
        } else {
          counts.teacher_only++;
        }
        if (hasGuard) {
          counts.guard++;
        }
        const rowObj: Record<string, unknown> = {
          id: r.id,
          ref: r.ref ?? null,
          group,
          created_at: r.ts,
          ...(r.preset ? { preset: r.preset } : {}),
          teacher_model: r.teacher?.model ?? null,
          state: r.state,
          questions: r.questions,
          labels: trainLabels.labels,
          label_source: trainLabels.source,
          ...(hasGuard ? { guard_overrides: trainLabels.guardOverrides } : {}),
          ...(r.teacher ? { teacher_labels: r.teacher.answers } : {}),
        };
        if (band === "calibration") {
          calGroupSet.add(group);
          calRows.push(JSON.stringify(rowObj));
        } else {
          trainGroupSet.add(group);
          train.push(JSON.stringify(rowObj));
        }
      }
    }
  }

  writeFileSync(join(dir, "train.jsonl"), train.join("\n") + (train.length ? "\n" : ""));
  writeFileSync(join(dir, "eval.jsonl"), evalRows.join("\n") + (evalRows.length ? "\n" : ""));
  writeFileSync(join(dir, "calibration.jsonl"), calRows.join("\n") + (calRows.length ? "\n" : ""));

  const summary = {
    train: train.length,
    eval: evalRows.length,
    calibration: calRows.length,
    train_groups: trainGroupSet.size,
    eval_groups: evalGroupSet.size,
    calibration_groups: calGroupSet.size,
    groups: {
      train: trainGroupSet.size,
      eval: evalGroupSet.size,
      calibration: calGroupSet.size,
    },
    ...counts,
  };

  const manifest = {
    schema_version: 1,
    exported_at: exportedAt,
    eval_fraction: evalFraction,
    calibration_fraction: calibrationFraction,
    split: "sha256(group)[0]/256",
    include_teacher: includeTeacher,
    ...summary,
    counts: {
      train: train.length,
      eval: evalRows.length,
      calibration: calRows.length,
      ...counts,
    },
  };
  writeFileSync(join(dir, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");

  return {
    dir,
    ...summary,
  };
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
    const { labels } = labelsFor(r, opts.includeTeacher ?? false, opts.includeTeacher ?? false);
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
