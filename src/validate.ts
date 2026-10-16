/**
 * Boundary validation and structured error envelopes matching upstream
 * `crates/ollaya-api/src/{error,validate,keep_alive}.rs`.
 */
import type { CalibrationSpec } from "./ollaya.js";
import type { Question, Questions } from "./questions.js";

export const MAX_BODY_BYTES = 8 * 1024 * 1024; // 8_388_608
export const MAX_QUESTIONS = 256;
export const MAX_CHOICE_LABELS = 255;
export const MIN_SCORE_LEVELS = 2;
export const MAX_SCORE_LEVELS = 10;
export const MAX_MODEL_NAME_BYTES = 256;
export const MAX_PRESET_NAME_BYTES = 128;

export type ErrorCode =
  | "INVALID_JSON"
  | "REQUEST_TOO_LARGE"
  | "UNAUTHORIZED"
  | "NOT_FOUND"
  | "METHOD_NOT_ALLOWED"
  | "UNPROCESSABLE_REQUEST"
  | "STATE_TRUNCATED"
  | "MODEL_UNSUPPORTED"
  | "BUSY"
  | "INTERNAL_ERROR"
  | "NOT_IMPLEMENTED"
  | "BACKEND_UNAVAILABLE";

export type LocPart = string | number;

export interface ValidationIssue {
  type: string;
  loc: LocPart[];
  msg: string;
  ctx?: Record<string, unknown>;
}

export interface ErrorBody {
  error: string;
  code: ErrorCode;
  detail?: ValidationIssue[];
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly body: ErrorBody,
    readonly headers?: Record<string, string>,
  ) {
    super(body.error);
  }

  static invalidJson(msg: string): ApiError {
    return new ApiError(400, { error: msg, code: "INVALID_JSON" });
  }

  static requestTooLarge(limit = MAX_BODY_BYTES): ApiError {
    return new ApiError(413, {
      error: `request body is larger than ${limit} bytes`,
      code: "REQUEST_TOO_LARGE",
    });
  }

  static unauthorized(msg = "missing or invalid Authorization: Bearer token"): ApiError {
    return new ApiError(
      401,
      { error: msg, code: "UNAUTHORIZED" },
      { "www-authenticate": "Bearer" },
    );
  }

  static notFound(msg: string): ApiError {
    return new ApiError(404, { error: msg, code: "NOT_FOUND" });
  }

  static methodNotAllowed(method: string, path: string, allowed: string): ApiError {
    return new ApiError(
      405,
      {
        error: `method ${method} is not allowed on ${path}; allowed: ${allowed}`,
        code: "METHOD_NOT_ALLOWED",
      },
      { allow: allowed },
    );
  }

  static validation(issues: ValidationIssue[]): ApiError {
    const first = issues[0];
    const summary = first
      ? first.loc.length === 0
        ? first.msg
        : `${first.loc.map(String).join(".")}: ${first.msg}`
      : "request validation failed";
    return new ApiError(422, {
      error: summary,
      code: "UNPROCESSABLE_REQUEST",
      detail: issues,
    });
  }

  static stateTruncated(model: string): ApiError {
    return new ApiError(422, {
      error: `state exceeded ${model}'s context window and was truncated; shorten state or call /api/decide which reports state_truncated without failing`,
      code: "STATE_TRUNCATED",
    });
  }

  static notImplemented(feature: string): ApiError {
    return new ApiError(501, { error: feature, code: "NOT_IMPLEMENTED" });
  }

  static backendUnavailable(msg: string): ApiError {
    return new ApiError(503, { error: msg, code: "BACKEND_UNAVAILABLE" });
  }

  static internal(msg: string): ApiError {
    return new ApiError(500, { error: msg, code: "INTERNAL_ERROR" });
  }
}

function issue(
  type: string,
  loc: LocPart[],
  msg: string,
  ctx?: Record<string, unknown>,
): ValidationIssue {
  return ctx ? { type, loc, msg, ctx } : { type, loc, msg };
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function jsonTypeName(v: unknown): string {
  if (v === null || v === undefined) return "null";
  if (typeof v === "boolean") return "boolean";
  if (typeof v === "number") return "number";
  if (typeof v === "string") return "string";
  if (Array.isArray(v)) return "array";
  return "object";
}

export function parseJsonObject(raw: Buffer | string): Record<string, unknown> {
  const text = typeof raw === "string" ? raw : raw.toString("utf8");
  if (!text.trim()) {
    throw ApiError.invalidJson("missing request body");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (e: any) {
    throw ApiError.invalidJson(`invalid JSON: ${e?.message ?? e}`);
  }
  if (!isPlainObject(parsed)) {
    throw ApiError.invalidJson("request body must be a JSON object");
  }
  return parsed;
}

// ---------------------------------------------------------------- keep_alive

const MAX_KEEP_ALIVE_SECS = 365 * 24 * 3600;

export function parseDurationString(raw: string): number {
  const s = raw.trim();
  if (!s) throw new Error("keep_alive duration string must not be empty");
  if (s.startsWith("-")) return -1;
  let rest = s.startsWith("+") ? s.slice(1) : s;
  if (!rest) throw new Error(`invalid duration '${raw}'`);
  if (rest === "0") return 0;

  let totalSecs = 0;
  let consumedAny = false;
  while (rest.length > 0) {
    let numEnd = 0;
    let seenDot = false;
    while (numEnd < rest.length) {
      const ch = rest[numEnd];
      if (ch >= "0" && ch <= "9") {
        numEnd++;
      } else if (ch === "." && !seenDot) {
        seenDot = true;
        numEnd++;
      } else {
        break;
      }
    }
    if (numEnd === 0) throw new Error(`expected a number in duration '${raw}'`);
    const value = Number(rest.slice(0, numEnd));
    if (!Number.isFinite(value)) throw new Error(`invalid number in duration '${raw}'`);
    rest = rest.slice(numEnd);

    let unitEnd = 0;
    while (unitEnd < rest.length && !(rest[unitEnd] >= "0" && rest[unitEnd] <= "9") && rest[unitEnd] !== ".") {
      unitEnd++;
    }
    const unit = rest.slice(0, unitEnd);
    rest = rest.slice(unitEnd);
    let factor: number;
    switch (unit) {
      case "ns":
        factor = 1e-9;
        break;
      case "us":
      case "µs":
      case "μs":
        factor = 1e-6;
        break;
      case "ms":
        factor = 1e-3;
        break;
      case "s":
        factor = 1;
        break;
      case "m":
        factor = 60;
        break;
      case "h":
        factor = 3600;
        break;
      default:
        throw new Error(`unknown or missing unit '${unit}' in duration '${raw}' (supported: ns, us, ms, s, m, h)`);
    }
    totalSecs += value * factor;
    consumedAny = true;
  }
  if (!consumedAny || !Number.isFinite(totalSecs) || totalSecs < 0) {
    throw new Error(`invalid duration '${raw}'`);
  }
  return Math.min(totalSecs, MAX_KEEP_ALIVE_SECS);
}

function validateKeepAlive(v: unknown, loc: LocPart[], issues: ValidationIssue[]): string | number | undefined {
  if (v === undefined || v === null) return undefined;
  if (typeof v === "number") {
    if (!Number.isFinite(v)) {
      issues.push(issue("value_error", loc, "keep_alive must be a finite number"));
      return undefined;
    }
    return v;
  }
  if (typeof v === "string") {
    try {
      parseDurationString(v);
      return v;
    } catch (e: any) {
      issues.push(issue("value_error", loc, e?.message ?? String(e)));
      return undefined;
    }
  }
  issues.push(issue("value_error", loc, "keep_alive must be a duration string (e.g. '5m') or a number of seconds"));
  return undefined;
}

// ---------------------------------------------------------------- names

export function validateModelName(raw: string): string | null {
  if (!raw) return "model must not be empty";
  if (Buffer.byteLength(raw, "utf8") > MAX_MODEL_NAME_BYTES) {
    return `model name must be at most ${MAX_MODEL_NAME_BYTES} bytes`;
  }
  for (const ch of raw) {
    const code = ch.codePointAt(0)!;
    if (code <= 0x1f || code === 0x7f || /\s/.test(ch)) {
      return "model name must not contain whitespace or control characters";
    }
  }
  const [pathPart, tag] = raw.includes(":") ? raw.split(":", 2) : [raw, undefined];
  if (raw.includes(":") && raw.indexOf(":") !== raw.lastIndexOf(":")) {
    return `invalid model tag in '${raw}'`;
  }
  if (!pathPart) return "model name must not start with ':'";
  if (tag !== undefined) {
    if (!tag || tag.startsWith(".") || tag.startsWith("-") || !/^[A-Za-z0-9._-]+$/.test(tag)) {
      return `invalid model tag '${tag}'`;
    }
  }
  for (const seg of pathPart.split("/")) {
    if (!seg || seg === "." || seg === ".." || seg.startsWith(".") || seg.startsWith("-")) {
      return `invalid model name segment in '${raw}'`;
    }
    if (!/^[A-Za-z0-9._-]+$/.test(seg)) {
      return `invalid character in model name '${raw}'`;
    }
  }
  return null;
}

function requireModelField(body: Record<string, unknown>, field: string, issues: ValidationIssue[]): string {
  const loc: LocPart[] = ["body", field];
  const v = body[field];
  if (v === undefined || v === null) {
    issues.push(issue("missing", loc, "Field required"));
    return "";
  }
  if (typeof v !== "string") {
    issues.push(issue("string_type", loc, "Input should be a valid string"));
    return "";
  }
  if (v.trim() === "") {
    issues.push(issue("string_too_short", loc, "String should have at least 1 character", { min_length: 1 }));
    return "";
  }
  const err = validateModelName(v);
  if (err) {
    issues.push(issue("value_error", loc, err));
    return "";
  }
  return v;
}

export function validatePresetName(raw: unknown, loc: LocPart[], issues: ValidationIssue[]): string {
  if (raw === undefined || raw === null) {
    issues.push(issue("missing", loc, "Field required"));
    return "";
  }
  if (typeof raw !== "string") {
    issues.push(issue("string_type", loc, "Input should be a valid string"));
    return "";
  }
  if (!raw) {
    issues.push(issue("string_too_short", loc, "String should have at least 1 character", { min_length: 1 }));
    return "";
  }
  if (Buffer.byteLength(raw, "utf8") > MAX_PRESET_NAME_BYTES) {
    issues.push(issue("value_error", loc, `preset name must be at most ${MAX_PRESET_NAME_BYTES} bytes`));
    return "";
  }
  if (raw.startsWith(".") || raw.startsWith("-") || !/^[A-Za-z0-9._-]+$/.test(raw)) {
    issues.push(
      issue(
        "value_error",
        loc,
        `invalid preset name '${raw}'; use ASCII letters, digits, '.', '_' or '-'`,
      ),
    );
    return "";
  }
  return raw;
}

function validateStreamField(
  body: Record<string, unknown>,
  defaultStream: boolean,
  issues: ValidationIssue[],
): boolean {
  const v = body.stream;
  if (v === undefined || v === null) return defaultStream;
  if (typeof v === "boolean") return v;
  issues.push(issue("bool_type", ["body", "stream"], "Input should be a valid boolean"));
  return defaultStream;
}

// ---------------------------------------------------------------- questions

function validateCriteriaValue(v: unknown, loc: LocPart[], allowNull: boolean, issues: ValidationIssue[]) {
  if (v === null) {
    if (!allowNull) {
      issues.push(issue("json_type", loc, "Input should be a string, object, or array"));
    }
    return;
  }
  if (typeof v === "string" || Array.isArray(v) || isPlainObject(v)) return;
  issues.push(issue("json_type", loc, "Input should be a string, object, or array"));
}

function validateInstructions(qObj: Record<string, unknown>, baseLoc: LocPart[], issues: ValidationIssue[]) {
  if ("instructions" in qObj && qObj.instructions !== undefined) {
    validateCriteriaValue(qObj.instructions, [...baseLoc, "instructions"], true, issues);
  }
}

function validateQuestion(id: string, raw: unknown, issues: ValidationIssue[]): Question | undefined {
  const qLoc: LocPart[] = ["body", "questions", id];
  if (!isPlainObject(raw)) {
    issues.push(issue("model_type", qLoc, "Input should be a valid dictionary or object"));
    return undefined;
  }
  const typeVal = raw.type;
  if (typeof typeVal !== "string") {
    issues.push(
      issue(
        "union_tag_not_found",
        qLoc,
        "Unable to extract tag using discriminator 'type'",
        { discriminator: "'type'" },
      ),
    );
    return undefined;
  }
  switch (typeVal) {
    case "choice": {
      const tLoc: LocPart[] = [...qLoc, "choice"];
      validateInstructions(raw, tLoc, issues);
      const cLoc: LocPart[] = [...tLoc, "criteria"];
      const c = raw.criteria;
      if (c === undefined || c === null) {
        issues.push(issue("missing", cLoc, "Field required"));
        return undefined;
      }
      if (isPlainObject(c)) {
        const keys = Object.keys(c);
        if (keys.length < 2) {
          issues.push(issue("value_error", cLoc, "Value error, choice criteria must define at least 2 options"));
          return undefined;
        }
        if (keys.length > MAX_CHOICE_LABELS) {
          issues.push(
            issue(
              "value_error",
              cLoc,
              `Value error, choice criteria supports at most ${MAX_CHOICE_LABELS} options (got ${keys.length})`,
            ),
          );
          return undefined;
        }
        for (const [label, desc] of Object.entries(c)) {
          if (!label.trim()) {
            issues.push(issue("value_error", [...cLoc, label], "Value error, choice option label must not be empty"));
          }
          validateCriteriaValue(desc, [...cLoc, label], true, issues);
        }
        return {
          type: "choice",
          ...(raw.instructions !== undefined ? { instructions: raw.instructions as any } : {}),
          criteria: c as Record<string, any>,
        };
      }
      if (Array.isArray(c)) {
        if (c.length > MAX_CHOICE_LABELS) {
          issues.push(
            issue(
              "value_error",
              cLoc,
              `Value error, choice criteria supports at most ${MAX_CHOICE_LABELS} options (got ${c.length})`,
            ),
          );
          return undefined;
        }
        const seen = new Set<string>();
        for (let idx = 0; idx < c.length; idx++) {
          const item = c[idx];
          const iLoc: LocPart[] = [...cLoc, idx];
          if (typeof item !== "string") {
            issues.push(issue("string_type", iLoc, "Input should be a valid string"));
          } else if (!item.trim()) {
            issues.push(issue("value_error", iLoc, "Value error, choice option label must not be empty"));
          } else {
            seen.add(item);
          }
        }
        if (seen.size < 2) {
          issues.push(issue("value_error", cLoc, "Value error, choice criteria must define at least 2 options"));
          return undefined;
        }
        return {
          type: "choice",
          ...(raw.instructions !== undefined ? { instructions: raw.instructions as any } : {}),
          criteria: c as string[],
        };
      }
      issues.push(
        issue("dict_type", cLoc, "Input should be a valid dictionary or an array of option strings"),
      );
      return undefined;
    }
    case "score": {
      const tLoc: LocPart[] = [...qLoc, "score"];
      validateInstructions(raw, tLoc, issues);
      const cLoc: LocPart[] = [...tLoc, "criteria"];
      const c = raw.criteria;
      if (c === undefined || c === null) {
        issues.push(issue("missing", cLoc, "Field required"));
        return undefined;
      }
      if (!Array.isArray(c)) {
        issues.push(issue("list_type", cLoc, "Input should be a valid list"));
        return undefined;
      }
      if (c.length < MIN_SCORE_LEVELS) {
        issues.push(
          issue("too_short", cLoc, `List should have at least ${MIN_SCORE_LEVELS} items after validation, not ${c.length}`, {
            field_type: "List",
            min_length: MIN_SCORE_LEVELS,
            actual_length: c.length,
          }),
        );
      }
      if (c.length > MAX_SCORE_LEVELS) {
        issues.push(
          issue("too_long", cLoc, `List should have at most ${MAX_SCORE_LEVELS} items after validation, not ${c.length}`, {
            field_type: "List",
            max_length: MAX_SCORE_LEVELS,
            actual_length: c.length,
          }),
        );
      }
      for (let idx = 0; idx < c.length; idx++) {
        validateCriteriaValue(c[idx], [...cLoc, idx], false, issues);
      }
      return {
        type: "score",
        ...(raw.instructions !== undefined ? { instructions: raw.instructions as any } : {}),
        criteria: c as any[],
      };
    }
    case "noul": {
      const tLoc: LocPart[] = [...qLoc, "noul"];
      validateInstructions(raw, tLoc, issues);
      const cLoc: LocPart[] = [...tLoc, "criteria"];
      const c = raw.criteria;
      if (c === undefined || c === null) {
        return {
          type: "noul",
          ...(raw.instructions !== undefined ? { instructions: raw.instructions as any } : {}),
          ...(c === null ? { criteria: null } : {}),
        };
      }
      if (!isPlainObject(c)) {
        issues.push(issue("model_type", cLoc, "Input should be a valid dictionary or object"));
        return undefined;
      }
      if ("true" in c && c.true !== undefined) {
        validateCriteriaValue(c.true, [...cLoc, "true"], true, issues);
      }
      if ("false" in c && c.false !== undefined) {
        validateCriteriaValue(c.false, [...cLoc, "false"], true, issues);
      }
      return {
        type: "noul",
        ...(raw.instructions !== undefined ? { instructions: raw.instructions as any } : {}),
        criteria: {
          ...("true" in c ? { true: c.true as any } : {}),
          ...("false" in c ? { false: c.false as any } : {}),
        },
      };
    }
    default:
      issues.push(
        issue(
          "union_tag_invalid",
          qLoc,
          `Input tag '${typeVal}' found using 'type' does not match any of the expected tags: 'choice', 'score', 'noul'`,
          {
            discriminator: "'type'",
            tag: typeVal,
            expected_tags: "'choice', 'score', 'noul'",
          },
        ),
      );
      return undefined;
  }
}

export function validateQuestionsMap(v: unknown, issues: ValidationIssue[]): Questions | undefined {
  const loc: LocPart[] = ["body", "questions"];
  if (!isPlainObject(v)) {
    issues.push(issue("dict_type", loc, "Input should be a valid dictionary"));
    return undefined;
  }
  const entries = Object.entries(v);
  if (entries.length === 0) {
    issues.push(issue("value_error", loc, "Value error, questions must contain at least 1 question"));
    return undefined;
  }
  if (entries.length > MAX_QUESTIONS) {
    issues.push(
      issue(
        "value_error",
        loc,
        `Value error, questions supports at most ${MAX_QUESTIONS} questions per request (got ${entries.length})`,
      ),
    );
    return undefined;
  }
  const out: Questions = {};
  for (const [id, qVal] of entries) {
    if (!id.trim()) {
      issues.push(issue("value_error", ["body", "questions", id], "Value error, question id must not be empty"));
      continue;
    }
    const q = validateQuestion(id, qVal, issues);
    if (q) out[id] = q;
  }
  return out;
}

// ---------------------------------------------------------------- decide & v1

export interface AdditaRequestOptions {
  ref?: string;
  allow_cloud_teacher?: boolean;
}

export interface ValidatedDecideRequest {
  model: string;
  state?: unknown;
  questions?: Questions;
  preset?: string;
  images?: string[];
  keep_alive?: string | number;
  extras: string[];
  addita?: AdditaRequestOptions;
}

export interface ValidatedV1Request {
  model: string;
  state: unknown;
  questions: Questions;
  addita?: AdditaRequestOptions;
}

function validateAdditaBlock(v: unknown, issues: ValidationIssue[]): AdditaRequestOptions | undefined {
  if (v === undefined || v === null) return undefined;
  const loc: LocPart[] = ["body", "addita"];
  if (!isPlainObject(v)) {
    issues.push(issue("dict_type", loc, "Input should be a valid dictionary"));
    return undefined;
  }
  const out: AdditaRequestOptions = {};
  if (v.ref !== undefined && v.ref !== null) {
    if (typeof v.ref !== "string") {
      issues.push(issue("string_type", [...loc, "ref"], "Input should be a valid string"));
    } else {
      out.ref = v.ref;
    }
  }
  if (v.allow_cloud_teacher !== undefined && v.allow_cloud_teacher !== null) {
    if (typeof v.allow_cloud_teacher !== "boolean") {
      issues.push(issue("bool_type", [...loc, "allow_cloud_teacher"], "Input should be a valid boolean"));
    } else {
      out.allow_cloud_teacher = v.allow_cloud_teacher;
    }
  }
  return out;
}

export function validateDecideRequest(body: Record<string, unknown>): ValidatedDecideRequest {
  const issues: ValidationIssue[] = [];
  const model = requireModelField(body, "model", issues);

  let state: unknown = undefined;
  if (body.state !== undefined && body.state !== null) {
    const s = body.state;
    if (typeof s === "string" || Array.isArray(s) || isPlainObject(s)) {
      state = s;
    } else {
      issues.push(
        issue(
          "state_invalid_type",
          ["body", "state"],
          `state must be a string, object, or array (got ${jsonTypeName(s)})`,
        ),
      );
    }
  }

  let questions: Questions | undefined = undefined;
  if (body.questions !== undefined && body.questions !== null) {
    questions = validateQuestionsMap(body.questions, issues);
  }

  let preset: string | undefined = undefined;
  if (body.preset !== undefined && body.preset !== null) {
    const p = validatePresetName(body.preset, ["body", "preset"], issues);
    if (p) preset = p;
  }

  if (questions !== undefined && preset !== undefined) {
    issues.push(
      issue("value_error", ["body", "preset"], "preset and questions are mutually exclusive; pass one or the other"),
    );
  }

  let images: string[] | undefined = undefined;
  if (body.images !== undefined && body.images !== null) {
    const loc: LocPart[] = ["body", "images"];
    if (!Array.isArray(body.images)) {
      issues.push(issue("list_type", loc, "Input should be a valid list"));
    } else {
      const list: string[] = [];
      for (let idx = 0; idx < body.images.length; idx++) {
        const item = body.images[idx];
        const iLoc: LocPart[] = [...loc, idx];
        if (typeof item !== "string") {
          issues.push(issue("string_type", iLoc, "Input should be a valid string"));
        } else if (!item.trim()) {
          issues.push(issue("string_too_short", iLoc, "image entry must not be empty"));
        } else {
          list.push(item);
        }
      }
      if (list.length > 0) images = list;
    }
  }

  const keep_alive = validateKeepAlive(body.keep_alive, ["body", "keep_alive"], issues);

  const extras: string[] = [];
  if (body.extras !== undefined && body.extras !== null) {
    const loc: LocPart[] = ["body", "extras"];
    if (!Array.isArray(body.extras)) {
      issues.push(issue("list_type", loc, "Input should be a valid list"));
    } else {
      for (let idx = 0; idx < body.extras.length; idx++) {
        const item = body.extras[idx];
        const iLoc: LocPart[] = [...loc, idx];
        if (item === "laya") {
          if (!extras.includes("laya")) extras.push("laya");
        } else if (typeof item === "string") {
          issues.push(issue("enum", iLoc, "Input should be 'laya'", { expected: "'laya'" }));
        } else {
          issues.push(issue("string_type", iLoc, "Input should be a valid string"));
        }
      }
    }
  }

  if (body.stream !== undefined && body.stream !== null) {
    const loc: LocPart[] = ["body", "stream"];
    if (body.stream === true) {
      issues.push(
        issue(
          "stream_unsupported",
          loc,
          "/api/decide is a single-forward-pass endpoint and does not support streaming; omit 'stream' or set it to false",
        ),
      );
    } else if (body.stream !== false) {
      issues.push(issue("bool_type", loc, "Input should be a valid boolean"));
    }
  }

  if (state === undefined && (questions !== undefined || preset !== undefined || images !== undefined)) {
    issues.push(issue("missing", ["body", "state"], "Field required when questions, preset, or images are provided"));
  }

  const addita = validateAdditaBlock(body.addita, issues);

  if (issues.length > 0) throw ApiError.validation(issues);

  return { model, state, questions, preset, images, keep_alive, extras, addita };
}

export function validateV1Request(body: Record<string, unknown>): ValidatedV1Request {
  const issues: ValidationIssue[] = [];
  const model = requireModelField(body, "model", issues);

  let state: unknown = null;
  if (body.state === undefined || body.state === null) {
    issues.push(issue("missing", ["body", "state"], "Field required"));
  } else if (typeof body.state === "string" || Array.isArray(body.state) || isPlainObject(body.state)) {
    state = body.state;
  } else {
    issues.push(
      issue(
        "state_invalid_type",
        ["body", "state"],
        `state must be a string, object, or array (got ${jsonTypeName(body.state)})`,
      ),
    );
  }

  let questions: Questions = {};
  if (body.questions === undefined || body.questions === null) {
    issues.push(issue("missing", ["body", "questions"], "Field required"));
  } else {
    questions = validateQuestionsMap(body.questions, issues) ?? {};
  }

  if (body.stream !== undefined && body.stream !== null) {
    const loc: LocPart[] = ["body", "stream"];
    if (body.stream === true) {
      issues.push(
        issue(
          "stream_unsupported",
          loc,
          "this endpoint runs a single forward pass and does not support streaming; omit 'stream' or set it to false",
        ),
      );
    } else if (body.stream !== false) {
      issues.push(issue("bool_type", loc, "Input should be a valid boolean"));
    }
  }

  const addita = validateAdditaBlock(body.addita, issues);

  if (issues.length > 0) throw ApiError.validation(issues);

  return { model, state, questions, addita };
}

// ---------------------------------------------------------------- management endpoints

export function validateShowRequest(body: Record<string, unknown>): { model: string; verbose: boolean } {
  const issues: ValidationIssue[] = [];
  const rawName = body.model !== undefined ? body.model : body.name;
  const field = body.model !== undefined ? "model" : "name";
  let model = "";
  if (rawName === undefined || rawName === null) {
    issues.push(issue("missing", ["body", "model"], "Field required"));
  } else if (typeof rawName !== "string") {
    issues.push(issue("string_type", ["body", field], "Input should be a valid string"));
  } else if (!rawName.trim()) {
    issues.push(issue("string_too_short", ["body", field], "String should have at least 1 character", { min_length: 1 }));
  } else {
    const err = validateModelName(rawName);
    if (err) issues.push(issue("value_error", ["body", field], err));
    else model = rawName;
  }

  let verbose = false;
  if (body.verbose !== undefined && body.verbose !== null) {
    if (typeof body.verbose === "boolean") verbose = body.verbose;
    else issues.push(issue("bool_type", ["body", "verbose"], "Input should be a valid boolean"));
  }

  if (issues.length > 0) throw ApiError.validation(issues);
  return { model, verbose };
}

export function validatePullRequest(body: Record<string, unknown>): { model: string; insecure: boolean; stream: boolean } {
  const issues: ValidationIssue[] = [];
  const field = body.model !== undefined ? "model" : body.name !== undefined ? "name" : "model";
  const model = requireModelField(body, field, issues);
  const stream = validateStreamField(body, true, issues);
  let insecure = false;
  if (body.insecure !== undefined && body.insecure !== null) {
    if (typeof body.insecure === "boolean") insecure = body.insecure;
    else issues.push(issue("bool_type", ["body", "insecure"], "Input should be a valid boolean"));
  }
  if (issues.length > 0) throw ApiError.validation(issues);
  return { model, insecure, stream };
}

export function validateDeleteRequest(body: Record<string, unknown>): { model: string } {
  const issues: ValidationIssue[] = [];
  const field = body.model !== undefined ? "model" : body.name !== undefined ? "name" : "model";
  const model = requireModelField(body, field, issues);
  if (issues.length > 0) throw ApiError.validation(issues);
  return { model };
}

export function validateCopyRequest(body: Record<string, unknown>): { source: string; destination: string } {
  const issues: ValidationIssue[] = [];
  const source = requireModelField(body, "source", issues);
  const destination = requireModelField(body, "destination", issues);
  if (issues.length > 0) throw ApiError.validation(issues);
  return { source, destination };
}

function validateCalibration(v: unknown, issues: ValidationIssue[]): CalibrationSpec | undefined {
  const loc: LocPart[] = ["body", "calibration"];
  if (!isPlainObject(v)) {
    issues.push(issue("dict_type", loc, "Input should be a valid dictionary"));
    return undefined;
  }
  const byOptions: Record<string, number> = {};
  if (v.temperature_by_options !== undefined && v.temperature_by_options !== null) {
    const tLoc: LocPart[] = [...loc, "temperature_by_options"];
    if (!isPlainObject(v.temperature_by_options)) {
      issues.push(issue("dict_type", tLoc, "Input should be a valid dictionary"));
    } else {
      for (const [k, raw] of Object.entries(v.temperature_by_options)) {
        const kLoc: LocPart[] = [...tLoc, k];
        if (typeof raw !== "number" || !Number.isFinite(raw) || raw <= 0 || raw > 100) {
          issues.push(issue("value_error", kLoc, "temperature must be a finite number in (0, 100]"));
        } else {
          byOptions[k] = raw;
        }
      }
    }
  }
  let noulThreshold: number | undefined = undefined;
  if (v.noul_threshold !== undefined && v.noul_threshold !== null) {
    const nLoc: LocPart[] = [...loc, "noul_threshold"];
    if (typeof v.noul_threshold !== "number" || !Number.isFinite(v.noul_threshold) || v.noul_threshold <= 0 || v.noul_threshold >= 1) {
      issues.push(issue("value_error", nLoc, "noul_threshold must be a finite number in (0, 1)"));
    } else {
      noulThreshold = v.noul_threshold;
    }
  }
  return {
    ...(Object.keys(byOptions).length ? { temperature_by_options: byOptions } : {}),
    ...(noulThreshold !== undefined ? { noul_threshold: noulThreshold } : {}),
  };
}

export function validateCreateRequest(body: Record<string, unknown>) {
  const issues: ValidationIssue[] = [];
  const mField = body.model !== undefined ? "model" : body.name !== undefined ? "name" : "model";
  const model = requireModelField(body, mField, issues);
  const from = requireModelField(body, "from", issues);
  const stream = validateStreamField(body, true, issues);

  let questions: Questions | undefined = undefined;
  if (body.questions !== undefined && body.questions !== null) {
    questions = validateQuestionsMap(body.questions, issues);
  }
  let calibration: CalibrationSpec | undefined = undefined;
  if (body.calibration !== undefined && body.calibration !== null) {
    calibration = validateCalibration(body.calibration, issues);
  }
  let description: string | undefined = undefined;
  if (body.description !== undefined && body.description !== null) {
    if (typeof body.description === "string") description = body.description;
    else issues.push(issue("string_type", ["body", "description"], "Input should be a valid string"));
  }
  if (issues.length > 0) throw ApiError.validation(issues);
  return { model, from, questions, calibration, description, stream };
}

export function validatePresetCreateRequest(body: Record<string, unknown>) {
  const issues: ValidationIssue[] = [];
  const name = validatePresetName(body.name, ["body", "name"], issues);
  let questions: Questions = {};
  if (body.questions === undefined || body.questions === null) {
    issues.push(issue("missing", ["body", "questions"], "Field required"));
  } else {
    questions = validateQuestionsMap(body.questions, issues) ?? {};
  }
  let description: string | undefined = undefined;
  if (body.description !== undefined && body.description !== null) {
    if (typeof body.description === "string") description = body.description;
    else issues.push(issue("string_type", ["body", "description"], "Input should be a valid string"));
  }
  if (issues.length > 0) throw ApiError.validation(issues);
  return { name, questions, description };
}

export function validatePresetNameRequest(body: Record<string, unknown>): { name: string } {
  const issues: ValidationIssue[] = [];
  const name = validatePresetName(body.name, ["body", "name"], issues);
  if (issues.length > 0) throw ApiError.validation(issues);
  return { name };
}
