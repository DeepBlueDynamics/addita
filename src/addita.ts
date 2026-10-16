import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { config } from "./config.js";
import { HttpError } from "./http.js";
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
import {
  ApiError,
  defaultCodeForStatus,
  type ErrorCode,
  type ValidatedDecideRequest,
  type ValidatedV1Request,
} from "./validate.js";

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
  const overrides: Record<string, string> = {};
  if (!preset?.guards?.length) return { answers, hits, overrides };
  const t = guardText(state, preset.text_field);
  const out = { ...answers };
  for (const g of preset.guards) {
    if (!new RegExp(g.pattern, g.flags).test(t)) continue;
    hits.push(g.name);
    for (const [q, v] of Object.entries(g.set)) {
      if (q in questions) {
        out[q] = v;
        overrides[q] = g.name;
      }
    }
  }
  return { answers: out, hits, overrides };
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

function httpErrorToApiError(e: any, model?: string): ApiError {
  if (e instanceof ApiError) return e;
  if (e instanceof HttpError && e.status !== undefined) {
    if (e.status === 404 && (!e.code || e.code === "MODEL_NOT_FOUND") && model) {
      return ApiError.modelNotFound(model);
    }
    const code = (e.code ?? defaultCodeForStatus(e.status)) as ErrorCode;
    return new ApiError(
      e.status,
      {
        error: e.rawError ?? e.message,
        code,
        ...(e.detail ? { detail: e.detail as any } : {}),
      },
      e.headers,
    );
  }
  return ApiError.backendUnavailable(
    `cannot reach Ollaya at ${config.ollayaUrl}: ${e?.message ?? String(e)}`,
  );
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

/**
 * Runs teacher inference following Kord's rules:
 * - If `ADDITA_NO_CLOUD=true`: never call cloud; only local (`qwen3.5:4b`) is used.
 * - If `ADDITA_NO_CLOUD=false`: try cloud teacher (`deepseek-v4.1-flash:cloud`) first.
 *   If cloud fails for any reason, local teacher (`qwen3.5:4b`) answers immediately and
 *   marks the row `cloud_pending: true` so `backfill` re-asks the cloud when it is back.
 */
async function runTeacherWithFallback(
  id: string,
  state: unknown,
  questions: Questions,
  studentSimple: SimpleAnswers | undefined,
  forceSkip: boolean,
  onlyCloud = false,
): Promise<{
  teacher?: TeacherRow;
  status: string;
  wireState: "answered" | "pending" | "skipped" | "failed";
  teacherModel: string;
  teacherHost: string;
  cloudPending: boolean;
}> {
  const { candidates, defaultInfo, hadCloudPrimary } = await ollama.resolveTeacherCandidates({ onlyCloud });
  if (forceSkip || candidates.length === 0) {
    return {
      status: "skipped",
      wireState: "skipped",
      teacherModel: defaultInfo.model,
      teacherHost: defaultInfo.host,
      cloudPending: false,
    };
  }
  if (!(await ollama.isOnline())) {
    return {
      status: "offline",
      wireState: "pending",
      teacherModel: defaultInfo.model,
      teacherHost: defaultInfo.host,
      cloudPending: hadCloudPrimary,
    };
  }
  let lastError = "unknown error";
  let lastCandidate = defaultInfo;
  let cloudFailed = false;
  for (const cand of candidates) {
    lastCandidate = cand;
    try {
      const t = await askTeacher(state, questions, studentSimple, cand);
      const isCloudFallback = hadCloudPrimary && cloudFailed && !cand.isCloud;
      const row: TeacherRow = {
        id,
        ts: new Date().toISOString(),
        backfill: false,
        cloud_pending: isCloudFallback,
        ...t,
      };
      return {
        teacher: row,
        status: "answered",
        wireState: "answered",
        teacherModel: row.model,
        teacherHost: row.host ?? cand.host,
        cloudPending: isCloudFallback,
      };
    } catch (e: any) {
      if (cand.isCloud) cloudFailed = true;
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
      cloudPending: hadCloudPrimary,
    };
  }
  return {
    status: `error: ${lastError}`,
    wireState: "failed",
    teacherModel: lastCandidate.model,
    teacherHost: lastCandidate.host,
    cloudPending: hadCloudPrimary,
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
  group?: string;
  addita?: { ref?: string; group?: string };
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
  const ref = input.ref ?? input.addita?.ref ?? null;
  const rawGroup = input.group ?? input.addita?.group;
  const group = (typeof rawGroup === "string" && rawGroup.trim()) ? rawGroup.trim() : (ref || id);
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

  // 2. teacher (cloud -> local fallback, governed solely by ADDITA_NO_CLOUD)
  const mode = input.teacher ?? (config.teacherMode === "off" ? "skip" : config.teacherMode === "always" ? "require" : "auto");
  const t0 = Date.now();
  const tOut = await runTeacherWithFallback(id, state, questions, student?.simple, mode === "skip");
  const teacher = tOut.teacher;
  const teacherStatus = tOut.status;
  const wireTeacherState = tOut.wireState;
  const studentMs = student?.latency_ms ?? (Date.now() - s0);
  const teacherMs = wireTeacherState === "skipped" ? 0 : (teacher?.latency_ms ?? (Date.now() - t0));

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
    ...(ref !== null ? { ref } : {}),
    group,
    preset,
    state,
    transcript,
    meta,
    questions,
    student,
    ...(studentError ? { student_error: studentError } : {}),
    teacher_status: wireTeacherState,
    teacher_model: teacher?.model ?? null,
    teacher_host: teacher?.host ?? null,
    ...(tOut.cloudPending ? { cloud_pending: true } : {}),
    student_ms: studentMs,
    teacher_ms: teacherMs,
    final: g.answers,
    final_source: source,
    guards: g.hits,
    ...(Object.keys(g.overrides).length ? { guard_overrides: g.overrides } : {}),
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
    ref,
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
    ...(ref !== null ? { ref } : {}),
    group,
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
      ? {
          model: teacher.model,
          host: teacher.host,
          answers: teacher.answers,
          reasons: teacher.reasons,
          latency_ms: teacher.latency_ms,
          ...(teacher.cloud_pending ? { cloud_pending: true } : {}),
        }
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
      if (e instanceof HttpError && e.status !== undefined) {
        throw httpErrorToApiError(e);
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
    if (e instanceof HttpError && e.status !== undefined) {
      throw httpErrorToApiError(e, model);
    }
  }
  throw ApiError.validation([
    {
      type: "missing",
      loc: ["body", "questions"],
      msg: "Field required",
    },
  ]);
}

export async function decideHttp(req: ValidatedDecideRequest | ValidatedV1Request, isV1: boolean): Promise<Record<string, unknown>> {
  const tStart = Date.now();
  const tStartNs = process.hrtime.bigint();

  // Lifecycle-only request on /api/decide (no state): forward directly to Ollaya, never fabricate 200
  if (!isV1 && (req as ValidatedDecideRequest).state === undefined) {
    const dReq = req as ValidatedDecideRequest;
    try {
      const r = await ollaya.decide(dReq.model, undefined, undefined, { keepAlive: dReq.keep_alive });
      return r as unknown as Record<string, unknown>;
    } catch (e: any) {
      throw httpErrorToApiError(e, dReq.model);
    }
  }

  const presetName = !isV1 ? (req as ValidatedDecideRequest).preset : undefined;
  const { questions, presetObj } = await resolveQuestionsForWire(req.model, req.questions, presetName);
  const state = req.state!;
  const id = randomUUID();
  const ts = new Date().toISOString();
  const ref = req.addita?.ref ?? null;
  const group = (req.addita?.group && req.addita.group.trim()) ? req.addita.group.trim() : (ref || id);
  const transcript = lume.transcriptOf(state, presetObj?.text_field);
  const meta = lume.metaOf(state, presetObj?.text_field);

  // 1. Call student (Ollaya)
  let studentWire: ollaya.DecideResponse | undefined;
  let student: DecisionRow["student"] = null;
  let studentError: string | undefined;
  let studentHttpError: any = undefined;
  const s0 = Date.now();
  const s0Ns = process.hrtime.bigint();
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
    studentHttpError = e;
  }
  const studentMs = student?.latency_ms ?? (Date.now() - s0);
  const studentDurationNs = Number(process.hrtime.bigint() - s0Ns);

  // 2. Teacher (Ollama) with cloud -> local fallback policy (governed by ADDITA_NO_CLOUD)
  const t0 = Date.now();
  const tOut = await runTeacherWithFallback(
    id,
    state,
    questions,
    student?.simple,
    config.teacherMode === "off",
  );
  const teacher = tOut.teacher;
  const teacherState = tOut.wireState;
  const teacherMs = teacherState === "skipped" ? 0 : (Date.now() - t0);

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
    ref,
    group,
    preset: presetName,
    state,
    transcript,
    meta,
    questions,
    student,
    ...(studentError ? { student_error: studentError } : {}),
    teacher_status: teacherState,
    teacher_model: teacher?.model ?? null,
    teacher_host: teacher?.host ?? null,
    ...(tOut.cloudPending ? { cloud_pending: true } : {}),
    student_ms: studentMs,
    teacher_ms: teacherMs,
    final: g.answers,
    final_source: source,
    guards: g.hits,
    ...(Object.keys(g.overrides).length ? { guard_overrides: g.overrides } : {}),
  };
  store.addDecision(row);
  if (teacher) store.addTeacher(teacher);
  await lume.log(row, teacher);

  // #5: Errors must not look like success on /v1/* (or 4xx/501 model/validation errors on /api/decide)
  let postError: ApiError | undefined = undefined;
  if (isV1 && studentWire?.state_truncated === true) {
    postError = ApiError.stateTruncated(studentWire.model || req.model);
  } else if (studentHttpError) {
    const isClientOrModelErr =
      studentHttpError instanceof HttpError &&
      studentHttpError.status !== undefined &&
      [400, 401, 403, 404, 409, 413, 422, 501].includes(studentHttpError.status);
    if (isV1 || isClientOrModelErr) {
      postError = httpErrorToApiError(studentHttpError, req.model);
    }
  }

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
    student_ms: studentMs,
    teacher_ms: teacherMs,
    total_ms: totalMs,
    state_truncated: !!studentWire?.state_truncated,
    status: postError ? "error" : "ok",
    ...(postError ? { error_code: postError.body.code } : {}),
  });

  if (postError) {
    throw postError;
  }

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

  const evalDurationNs = studentWire?.eval_duration ?? studentWire?.total_duration ?? studentDurationNs;
  const wallDurationNs = Number(process.hrtime.bigint() - tStartNs);
  const totalDurationNs = Math.max(wallDurationNs, evalDurationNs);
  const doneReason: "decide" | "load" | "unload" =
    studentWire?.done_reason === "load" || studentWire?.done_reason === "unload"
      ? studentWire.done_reason
      : "decide";

  return {
    model: studentWire?.model ?? req.model,
    answers: wireAnswers,
    usage,
    routing: studentWire?.routing ?? null,
    state_truncated: studentWire?.state_truncated ?? false,
    done_reason: doneReason,
    created_at: studentWire?.created_at ?? ts,
    total_duration: totalDurationNs,
    load_duration: studentWire?.load_duration ?? 0,
    eval_duration: evalDurationNs,
    addita: {
      id,
      ref,
      group,
      final: g.answers,
      source,
      teacher: teacherState,
      teacher_model: teacher?.model ?? null,
      teacher_host: teacher?.host ?? null,
      ...(tOut.cloudPending ? { cloud_pending: true } : {}),
      guards: g.hits,
      agreement,
      ...(teacher ? { teacher_answers: teacher.answers } : {}),
      student_ms: studentMs,
      teacher_ms: teacherMs,
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
  const cloudPending = row.teacher ? !!row.teacher.cloud_pending : !!row.cloud_pending;
  const group = (row.group && row.group.trim()) || (row.ref && row.ref.trim()) || row.id;

  return {
    id: row.id,
    ref: row.ref ?? null,
    group,
    created_at: row.ts,
    updated_at: updatedAt,
    final,
    source,
    teacher: teacherState,
    teacher_model: row.teacher?.model ?? null,
    teacher_host: row.teacher?.host ?? null,
    ...(cloudPending ? { cloud_pending: true } : {}),
    guards: row.guards,
    agreement,
    ...(row.teacher ? { teacher_answers: row.teacher.answers } : {}),
    student_ms: row.student_ms ?? row.student?.latency_ms ?? 0,
    teacher_ms: row.teacher?.latency_ms ?? row.teacher_ms ?? 0,
    ...(row.label ? { labels: row.label.labels, labelled_by: row.label.by ?? null } : {}),
  };
}

// ---------------------------------------------------------------- backfill

/**
 * Ask the teacher about stored decisions it missed while offline, or rows marked
 * `cloud_pending` where the local teacher answered because the cloud failed.
 * When `ADDITA_NO_CLOUD=true`, never sends anything to a cloud teacher.
 */
export async function backfill(limit = 25) {
  const pending = store.joined().filter(
    (r) => !r.teacher || (!config.noCloud && r.teacher.cloud_pending === true),
  );
  const { candidates } = await ollama.resolveTeacherCandidates();
  if (candidates.length === 0) {
    return { status: "skipped", labelled: 0, remaining: pending.length, errors: [] as string[] };
  }
  if (!(await ollama.isOnline(true))) return { status: "offline", labelled: 0, remaining: undefined };
  let labelled = 0;
  const errors: string[] = [];
  for (const r of pending.slice(0, limit)) {
    const isCloudUpgrade = !!r.teacher && r.teacher.cloud_pending === true;
    const tOut = await runTeacherWithFallback(
      r.id,
      r.state,
      r.questions,
      r.student?.simple,
      false,
      isCloudUpgrade,
    );
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
