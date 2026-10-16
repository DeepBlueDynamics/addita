import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { config } from "./config.js";
import * as ollaya from "./ollaya.js";
import * as ollama from "./ollama.js";
import * as lume from "./lume.js";
import * as otlp from "./otlp.js";
import {
  coerceTeacher,
  describeQuestions,
  simplifyOllaya,
  teacherSchema,
  type Questions,
  type SimpleAnswers,
} from "./questions.js";
import { store, type DecisionRow, type TeacherRow } from "./store.js";
import { ApiError, type ValidatedDecideRequest, type ValidatedV1Request } from "./validate.js";

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

export function tryLoadLocalPreset(name: string): Preset | undefined {
  if (!/^[A-Za-z0-9_.-]+$/.test(name)) return undefined;
  const p = join(config.presetsDir, `${name}.json`);
  if (!existsSync(p)) return undefined;
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

function extractNoulScores(questions: Questions, rawAnswers: Record<string, any> | undefined): Record<string, number> {
  const out: Record<string, number> = {};
  if (!rawAnswers) return out;
  for (const [qid, q] of Object.entries(questions)) {
    if (q.type === "noul" && typeof rawAnswers[qid]?.noul === "number") {
      out[qid] = rawAnswers[qid].noul;
    }
  }
  return out;
}

// ---------------------------------------------------------------- teacher

const SYSTEM = `You are labelling radio and message traffic to train a small decision model.
Read the state, then answer every question exactly as specified.
Use only the labels, levels or booleans offered. Give a short reason for each answer.
Reply with JSON only, mapping each question id to {"answer": <value>, "reason": "<short reason>"}.`;

async function askTeacher(
  state: unknown,
  questions: Questions,
  student?: SimpleAnswers,
  candidate?: ollama.TeacherCandidate,
): Promise<Omit<TeacherRow, "id" | "ts" | "backfill">> {
  const parts = [
    `STATE:\n${typeof state === "string" ? state : JSON.stringify(state, null, 2)}`,
    `QUESTIONS:\n${describeQuestions(questions)}`,
  ];
  const seeStudent = config.teacherSeesStudent && student && Object.keys(student).length > 0;
  if (seeStudent) parts.push(`A smaller model answered: ${JSON.stringify(student)}. Correct it where it is wrong.`);

  const t0 = Date.now();
  const targetModel = candidate?.model ?? config.ollamaModel;
  const res = await ollama.chat(
    [
      { role: "system", content: SYSTEM },
      { role: "user", content: parts.join("\n\n") },
    ],
    {
      model: targetModel,
      format: teacherSchema(questions),
      options: { temperature: 0 },
      think: config.ollamaThink ?? false,
    },
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
    const r =
      typeof item?.reason === "string"
        ? item.reason
        : typeof parsed?.reasons?.[id] === "string"
          ? parsed.reasons[id]
          : typeof parsed?.reason === "string"
            ? parsed.reason
            : undefined;
    if (r) reasons[id] = r;
  }
  if (Object.keys(answers).length === 0) throw new Error("teacher answered none of the questions in a valid form");
  const resolvedHost = candidate?.host ?? ollama.syncTeacherInfo(res.model || targetModel).host;
  return {
    model: res.model || targetModel,
    host: resolvedHost,
    answers,
    reasons,
    latency_ms: Date.now() - t0,
    saw_student: !!seeStudent,
  };
}

async function runTeacherWithFallback(
  id: string,
  state: unknown,
  questions: Questions,
  studentSimple: SimpleAnswers | undefined,
  allowCloud: boolean,
  forceSkip: boolean,
): Promise<{
  teacher?: TeacherRow;
  status: string;
  wireState: "answered" | "pending" | "skipped" | "failed";
  teacherModel: string;
  teacherHost: string;
}> {
  const { candidates, defaultInfo } = await ollama.resolveTeacherCandidates(allowCloud);
  if (forceSkip || candidates.length === 0) {
    return {
      status: "skipped",
      wireState: "skipped",
      teacherModel: defaultInfo.model,
      teacherHost: defaultInfo.host,
    };
  }
  if (!(await ollama.isOnline())) {
    return {
      status: "offline",
      wireState: "pending",
      teacherModel: defaultInfo.model,
      teacherHost: defaultInfo.host,
    };
  }
  let lastError = "unknown error";
  let lastCandidate = defaultInfo;
  for (const cand of candidates) {
    lastCandidate = cand;
    try {
      const t = await askTeacher(state, questions, studentSimple, cand);
      const row: TeacherRow = {
        id,
        ts: new Date().toISOString(),
        backfill: false,
        ...t,
      };
      return {
        teacher: row,
        status: "answered",
        wireState: "answered",
        teacherModel: row.model,
        teacherHost: row.host ?? cand.host,
      };
    } catch (e: any) {
      lastError = e?.message ?? String(e);
    }
  }
  const stillOnline = await ollama.isOnline();
  if (!stillOnline) {
    return {
      status: "offline",
      wireState: "pending",
      teacherModel: lastCandidate.model,
      teacherHost: lastCandidate.host,
    };
  }
  return {
    status: `error: ${lastError}`,
    wireState: "failed",
    teacherModel: lastCandidate.model,
    teacherHost: lastCandidate.host,
  };
}

// ---------------------------------------------------------------- decide (MCP)

export interface DecideInput {
  state: unknown;
  context?: unknown;
  preset?: string;
  questions?: Questions;
  model?: string;
  teacher?: "auto" | "skip" | "require";
  /** Pull related past traffic from Lume into the context (default on when Lume is available). */
  lume_context?: boolean;
  ref?: string;
  allow_cloud_teacher?: boolean;
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
 * The loop (MCP `comms_decide`):
 *   1. Ollaya (student) answers first. Fast, always local.
 *   2. If Ollama is online, the teacher (cloud by default, falling back to local) answers the same questions.
 *      Both are logged: that pair is a training row for the decision model.
 *   3. The returned answer is the teacher's when it answered, else the student's.
 *   4. Deterministic guards (e.g. MAYDAY) override both.
 */
export async function decide(input: DecideInput) {
  const tStart = Date.now();
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
  let stateTruncated = false;
  const s0 = Date.now();
  try {
    const r = await ollaya.decide(model, state, questions);
    stateTruncated = !!r.state_truncated;
    const simple: SimpleAnswers = {};
    for (const [qid, q] of Object.entries(questions)) {
      const v = simplifyOllaya(q, r.answers?.[qid]);
      if (v !== undefined) simple[qid] = v;
    }
    student = { model: r.model, answers: r.answers, simple, latency_ms: Date.now() - s0 };
  } catch (e: any) {
    studentError = e.message;
  }

  // 2. teacher (cloud -> local fallback)
  const allowCloud = input.allow_cloud_teacher ?? config.allowCloudTeacher;
  const mode = input.teacher ?? (config.teacherMode === "off" ? "skip" : config.teacherMode === "always" ? "require" : "auto");
  const tOut = await runTeacherWithFallback(id, state, questions, student?.simple, allowCloud, mode === "skip");
  const teacher = tOut.teacher;
  const teacherStatus = tOut.status;
  const wireTeacherState = tOut.wireState;

  if (mode === "require" && !teacher) throw new Error(`teacher required but ${teacherStatus}`);

  // 3. final answer: teacher first, student fills any gaps
  const merged: SimpleAnswers = { ...(student?.simple ?? {}), ...(teacher?.answers ?? {}) };
  let source: DecisionRow["final_source"] = teacher ? "teacher" : student ? "student" : "none";

  // 4. guards
  const g = applyGuards(p, input.state, questions, merged);
  if (g.hits.length) source = "guard";

  if (!student && !teacher && g.hits.length === 0) {
    throw new Error(`no model answered. ollaya: ${studentError}; ollama: ${teacherStatus}`);
  }

  const row: DecisionRow = {
    id,
    ts,
    ...(input.ref !== undefined ? { ref: input.ref } : {}),
    preset,
    state,
    transcript,
    meta,
    questions,
    student,
    ...(studentError ? { student_error: studentError } : {}),
    teacher_status: wireTeacherState,
    teacher_model: tOut.teacherModel,
    teacher_host: tOut.teacherHost,
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

  const totalMs = Date.now() - tStart;
  void otlp.emitDecision({
    id,
    ref: input.ref ?? null,
    preset,
    model: student?.model ?? model,
    teacher_model: tOut.teacherModel,
    teacher_host: tOut.teacherHost,
    source,
    teacher: wireTeacherState,
    guards: g.hits,
    agreement,
    final: g.answers,
    noul: extractNoulScores(questions, student?.answers),
    student_ms: student?.latency_ms ?? 0,
    teacher_ms: teacher?.latency_ms,
    total_ms: totalMs,
    state_truncated: stateTruncated,
    status: "ok",
  });

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
      ? { model: teacher.model, host: teacher.host, answers: teacher.answers, reasons: teacher.reasons, latency_ms: teacher.latency_ms }
      : { status: teacherStatus },
    agreement,
    lume: (await lume.version())
      ? { context_items: lc.items.length, ...("error" in lc ? { error: lc.error } : {}) }
      : { status: "not available" },
  };
}

// ---------------------------------------------------------------- HTTP /api/decide & /v1/*

function stripLayaExtra(answers: Record<string, any>, keepLaya: boolean): Record<string, any> {
  if (keepLaya) return answers;
  const out: Record<string, any> = {};
  for (const [k, v] of Object.entries(answers)) {
    if (v && typeof v === "object" && !Array.isArray(v) && "laya" in v) {
      const { laya: _laya, ...rest } = v;
      out[k] = rest;
    } else {
      out[k] = v;
    }
  }
  return out;
}

function isUnloadKeepAlive(ka: string | number | undefined): boolean {
  if (ka === 0) return true;
  if (typeof ka === "string") {
    const s = ka.trim();
    return s === "0" || s === "0s" || s === "0ms" || s === "0m" || s === "0h";
  }
  return false;
}

async function resolveQuestionsForWire(
  model: string,
  inlineQuestions: Questions | undefined,
  presetName: string | undefined,
): Promise<{ questions: Questions; presetObj?: Preset }> {
  if (inlineQuestions) {
    return { questions: inlineQuestions };
  }
  if (presetName) {
    const local = tryLoadLocalPreset(presetName);
    if (local) return { questions: local.questions, presetObj: local };
    try {
      const remote = await ollaya.presetShow(presetName);
      if (remote && typeof remote.questions === "object" && remote.questions !== null) {
        return {
          questions: remote.questions as Questions,
          presetObj: {
            name: presetName,
            description: remote.description,
            questions: remote.questions as Questions,
          },
        };
      }
    } catch (e: any) {
      if (e?.status === 404) {
        throw ApiError.notFound(`preset '${presetName}' not found`);
      }
    }
    throw ApiError.notFound(`preset '${presetName}' not found`);
  }

  // Fallback: inspect model's embedded questions on Ollaya via /api/show
  try {
    const info = await ollaya.show(model);
    if (info?.questions && typeof info.questions === "object" && Object.keys(info.questions).length > 0) {
      return { questions: info.questions as Questions };
    }
  } catch (e: any) {
    if (e?.status === 404) {
      throw ApiError.notFound(`model '${model}' not found`);
    }
  }
  throw ApiError.validation([
    {
      type: "missing",
      loc: ["body", "questions"],
      msg: `Field required (model '${model}' has no embedded questions and no preset was specified)`,
    },
  ]);
}

export async function decideHttp(req: ValidatedDecideRequest | ValidatedV1Request, isV1: boolean): Promise<Record<string, unknown>> {
  const tStart = Date.now();

  // Lifecycle-only request on /api/decide (no state)
  if (!isV1 && (req as ValidatedDecideRequest).state === undefined) {
    const dReq = req as ValidatedDecideRequest;
    try {
      const r = await ollaya.decide(dReq.model, undefined, undefined, { keepAlive: dReq.keep_alive });
      return r as unknown as Record<string, unknown>;
    } catch (e: any) {
      if (e?.status === 404) throw ApiError.notFound(`model '${dReq.model}' not found`);
      if (e?.status === 422 && e?.code === "MODEL_UNSUPPORTED") {
        throw new ApiError(422, { error: e.message, code: "MODEL_UNSUPPORTED" });
      }
      return {
        model: dReq.model,
        answers: {},
        usage: { input_tokens: 0, output_tokens: 0 },
        routing: null,
        state_truncated: false,
        done_reason: isUnloadKeepAlive(dReq.keep_alive) ? "unload" : "load",
        created_at: new Date().toISOString(),
        total_duration: 0,
        load_duration: 0,
        eval_duration: 0,
      };
    }
  }

  const presetName = !isV1 ? (req as ValidatedDecideRequest).preset : undefined;
  const { questions, presetObj } = await resolveQuestionsForWire(req.model, req.questions, presetName);
  const state = req.state!;
  const id = randomUUID();
  const ts = new Date().toISOString();
  const transcript = lume.transcriptOf(state, presetObj?.text_field);
  const meta = lume.metaOf(state, presetObj?.text_field);

  // 1. Call student (Ollaya)
  let studentWire: ollaya.DecideResponse | undefined;
  let student: DecisionRow["student"] = null;
  let studentError: string | undefined;
  const s0 = Date.now();
  try {
    const dReq = req as ValidatedDecideRequest;
    studentWire = await ollaya.decide(req.model, state, questions, {
      keepAlive: !isV1 ? dReq.keep_alive : undefined,
      images: !isV1 ? dReq.images : undefined,
      extras: !isV1 ? dReq.extras : undefined,
    });
    const simple: SimpleAnswers = {};
    for (const [qid, q] of Object.entries(questions)) {
      const v = simplifyOllaya(q, studentWire.answers?.[qid]);
      if (v !== undefined) simple[qid] = v;
    }
    student = {
      model: studentWire.model || req.model,
      answers: studentWire.answers ?? {},
      simple,
      latency_ms: Date.now() - s0,
    };
  } catch (e: any) {
    studentError = e?.message ?? String(e);
  }

  // On /v1/* endpoints, state_truncated is a 422 STATE_TRUNCATED error
  if (isV1 && studentWire?.state_truncated === true) {
    const tInfo = ollama.syncTeacherInfo(config.ollamaModel);
    void otlp.emitDecision({
      id,
      ref: req.addita?.ref ?? null,
      preset: presetName,
      model: studentWire.model || req.model,
      teacher_model: tInfo.model,
      teacher_host: tInfo.host,
      source: "student",
      teacher: "skipped",
      guards: [],
      agreement: {},
      final: student?.simple ?? {},
      noul: extractNoulScores(questions, studentWire.answers),
      student_ms: student?.latency_ms ?? 0,
      total_ms: Date.now() - tStart,
      state_truncated: true,
      status: "error",
      error_code: "STATE_TRUNCATED",
    });
    throw ApiError.stateTruncated(studentWire.model || req.model);
  }

  // 2. Teacher (Ollama) with cloud -> local fallback policy
  const allowCloud = req.addita?.allow_cloud_teacher ?? config.allowCloudTeacher;
  const tOut = await runTeacherWithFallback(
    id,
    state,
    questions,
    student?.simple,
    allowCloud,
    config.teacherMode === "off",
  );
  const teacher = tOut.teacher;
  const teacherState = tOut.wireState;

  // 3. Final simple decision: student -> teacher -> guards
  const merged: SimpleAnswers = { ...(student?.simple ?? {}), ...(teacher?.answers ?? {}) };
  let source: DecisionRow["final_source"] = teacher ? "teacher" : student ? "student" : "none";
  const g = applyGuards(presetObj, state, questions, merged);
  if (g.hits.length > 0) source = "guard";

  const agreement: Record<string, boolean> = {};
  if (student && teacher) {
    for (const qid of Object.keys(teacher.answers)) {
      if (qid in student.simple) {
        agreement[qid] = student.simple[qid] === teacher.answers[qid];
      }
    }
  }

  const row: DecisionRow = {
    id,
    ts,
    ref: req.addita?.ref ?? null,
    preset: presetName,
    state,
    transcript,
    meta,
    questions,
    student,
    ...(studentError ? { student_error: studentError } : {}),
    teacher_status: teacherState,
    teacher_model: tOut.teacherModel,
    teacher_host: tOut.teacherHost,
    final: g.answers,
    final_source: source,
    guards: g.hits,
  };
  store.addDecision(row);
  if (teacher) store.addTeacher(teacher);
  await lume.log(row, teacher);

  const totalMs = Date.now() - tStart;
  void otlp.emitDecision({
    id,
    ref: req.addita?.ref ?? null,
    preset: presetName,
    model: studentWire?.model ?? req.model,
    teacher_model: tOut.teacherModel,
    teacher_host: tOut.teacherHost,
    source,
    teacher: teacherState,
    guards: g.hits,
    agreement,
    final: g.answers,
    noul: extractNoulScores(questions, studentWire?.answers),
    student_ms: student?.latency_ms ?? 0,
    teacher_ms: teacher?.latency_ms,
    total_ms: totalMs,
    state_truncated: !!studentWire?.state_truncated,
    status: "ok",
  });

  const keepLaya = !isV1 && (req as ValidatedDecideRequest).extras.includes("laya");
  const wireAnswers = stripLayaExtra(studentWire?.answers ?? {}, keepLaya);
  const usage = studentWire?.usage ?? { input_tokens: 0, output_tokens: 0 };

  if (isV1) {
    return {
      model: studentWire?.model ?? req.model,
      answers: wireAnswers,
      usage,
    };
  }

  const totalDurationNs = studentWire?.total_duration ?? totalMs * 1_000_000;
  const evalDurationNs = studentWire?.eval_duration ?? (student?.latency_ms ?? 0) * 1_000_000;

  return {
    model: studentWire?.model ?? req.model,
    answers: wireAnswers,
    usage,
    routing: studentWire?.routing ?? null,
    state_truncated: studentWire?.state_truncated ?? false,
    done_reason: studentWire?.done_reason ?? "complete",
    created_at: studentWire?.created_at ?? ts,
    total_duration: totalDurationNs,
    load_duration: studentWire?.load_duration ?? 0,
    eval_duration: evalDurationNs,
    addita: {
      id,
      ref: req.addita?.ref ?? null,
      final: g.answers,
      source,
      teacher: teacherState,
      teacher_model: tOut.teacherModel,
      teacher_host: tOut.teacherHost,
      guards: g.hits,
      agreement,
      ...(teacher ? { teacher_answers: teacher.answers } : {}),
    },
  };
}

// ---------------------------------------------------------------- decision lookup

export function getDecision(id: string) {
  const row = store.joined().find((r) => r.id === id);
  if (!row) return null;

  const presetObj = row.preset ? tryLoadLocalPreset(row.preset) : undefined;
  const baseMerged: SimpleAnswers = {
    ...(row.student?.simple ?? {}),
    ...(row.teacher?.answers ?? {}),
  };
  const guarded = applyGuards(presetObj, row.state, row.questions, baseMerged);
  const final: SimpleAnswers = {
    ...row.final,
    ...guarded.answers,
    ...(row.label?.labels ?? {}),
  };

  let source: "human" | "guard" | "teacher" | "student" | "none";
  if (row.label) {
    source = "human";
  } else if (row.guards.length > 0 || guarded.hits.length > 0) {
    source = "guard";
  } else if (row.teacher) {
    source = "teacher";
  } else if (row.student) {
    source = "student";
  } else {
    source = row.final_source;
  }

  const teacherState: "answered" | "pending" | "skipped" | "failed" = row.teacher
    ? "answered"
    : (row.teacher_status ?? "pending");

  const agreement: Record<string, boolean> = {};
  if (row.student && row.teacher) {
    for (const qid of Object.keys(row.teacher.answers)) {
      if (qid in row.student.simple) {
        agreement[qid] = row.student.simple[qid] === row.teacher.answers[qid];
      }
    }
  }

  const updatedAt = row.label?.ts ?? row.teacher?.ts ?? row.ts;
  const fallbackTeacher = ollama.syncTeacherInfo(config.ollamaModel);

  return {
    id: row.id,
    ref: row.ref ?? null,
    created_at: row.ts,
    updated_at: updatedAt,
    final,
    source,
    teacher: teacherState,
    teacher_model: row.teacher?.model ?? row.teacher_model ?? fallbackTeacher.model,
    teacher_host: row.teacher?.host ?? row.teacher_host ?? fallbackTeacher.host,
    guards: row.guards,
    agreement,
    ...(row.teacher ? { teacher_answers: row.teacher.answers } : {}),
    ...(row.label ? { labels: row.label.labels, labelled_by: row.label.by ?? null } : {}),
  };
}

// ---------------------------------------------------------------- backfill

/** Ask the teacher about stored decisions it never saw (Ollama was offline at the time). */
export async function backfill(limit = 25, opts: { allowCloudTeacher?: boolean } = {}) {
  const pending = store.joined().filter((r) => !r.teacher);
  const allowCloud = opts.allowCloudTeacher ?? config.allowCloudTeacher;
  const { candidates } = await ollama.resolveTeacherCandidates(allowCloud);
  if (candidates.length === 0) {
    return { status: "skipped", labelled: 0, remaining: pending.length, errors: [] as string[] };
  }
  if (!(await ollama.isOnline(true))) return { status: "offline", labelled: 0, remaining: undefined };
  let labelled = 0;
  const errors: string[] = [];
  for (const r of pending.slice(0, limit)) {
    const tOut = await runTeacherWithFallback(r.id, r.state, r.questions, r.student?.simple, allowCloud, false);
    if (tOut.teacher) {
      const row: TeacherRow = { ...tOut.teacher, backfill: true };
      store.addTeacher(row);
      await lume.log(r, row, r.label);
      const presetObj = r.preset ? tryLoadLocalPreset(r.preset) : undefined;
      const merged = { ...(r.student?.simple ?? {}), ...row.answers };
      const guarded = applyGuards(presetObj, r.state, r.questions, merged);
      const final = { ...guarded.answers, ...(r.label?.labels ?? {}) };
      const source = r.label ? "human" : r.guards.length > 0 ? "guard" : "teacher";
      void otlp.emitDecisionFinal({
        id: r.id,
        ref: r.ref ?? null,
        final,
        source,
        teacher_model: row.model,
        teacher_host: row.host ?? tOut.teacherHost,
        teacher_ms: row.latency_ms,
      });
      labelled++;
    } else {
      errors.push(`${r.id}: ${tOut.status}`);
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
  const mergedLabels = { ...(row.label?.labels ?? {}), ...clean };
  const l = { id, ts: new Date().toISOString(), labels: clean, by, note };
  store.addLabel(l);
  await lume.log(row, row.teacher, { ...l, labels: mergedLabels });

  const final: SimpleAnswers = {
    ...row.final,
    ...(row.teacher?.answers ?? {}),
    ...mergedLabels,
  };
  void otlp.emitLabel({
    id,
    ref: row.ref ?? null,
    labels: clean,
    by,
  });
  return { id, labels: clean, final, source: "human" as const };
}
