/**
 * Question schema (TypeSafe / Ollaya wire format) plus helpers that turn
 * answers from either model into one comparable "simple" form.
 */

export type Criteria = string | Record<string, unknown> | unknown[] | null;

export type Question =
  | { type: "choice"; instructions?: Criteria; criteria: Record<string, Criteria> | string[] }
  | { type: "score"; instructions?: Criteria; criteria: Criteria[] }
  | { type: "noul"; instructions?: Criteria; criteria?: { true?: Criteria; false?: Criteria } | null };

export type Questions = Record<string, Question>;

/** One comparable value per question: a label, a level index, or a boolean. */
export type SimpleValue = string | number | boolean;
export type SimpleAnswers = Record<string, SimpleValue>;

export function choiceLabels(q: Question & { type: "choice" }): string[] {
  if (Array.isArray(q.criteria)) return [...new Set(q.criteria.map(String))];
  return Object.keys(q.criteria);
}

export function scoreLevels(q: Question & { type: "score" }): number {
  return q.criteria.length;
}

/** Number of options a question has (used for calibration buckets). */
export function optionCount(q: Question): number {
  if (q.type === "choice") return choiceLabels(q).length;
  if (q.type === "score") return scoreLevels(q);
  return 2;
}

export function bucket(q: Question): string {
  const k = optionCount(q);
  const b = k <= 2 ? "2" : k <= 5 ? "3-5" : k <= 10 ? "6-10" : "11+";
  return `${q.type}:${b}`;
}

const text = (c: Criteria | undefined): string =>
  c === undefined || c === null ? "" : typeof c === "string" ? c : JSON.stringify(c);

/** Ollaya answer object → simple value. */
export function simplifyOllaya(q: Question, a: any): SimpleValue | undefined {
  if (!a || typeof a !== "object") return undefined;
  if (q.type === "choice" && typeof a.choice === "string") return a.choice;
  if (q.type === "score" && typeof a.score === "number") return Math.round(a.score);
  if (q.type === "noul" && typeof a.noul === "number") return a.noul >= 0.5;
  return undefined;
}

/** Validate a teacher value against the question; undefined if it doesn't fit. */
export function coerceTeacher(q: Question, v: unknown): SimpleValue | undefined {
  if (q.type === "choice") {
    if (typeof v !== "string") return undefined;
    const labels = choiceLabels(q);
    return labels.includes(v) ? v : labels.find((l) => l.toLowerCase() === v.toLowerCase());
  }
  if (q.type === "score") {
    const n = typeof v === "string" ? Number(v) : v;
    if (typeof n !== "number" || !Number.isFinite(n)) return undefined;
    const i = Math.round(n);
    return i >= 0 && i < scoreLevels(q) ? i : undefined;
  }
  if (typeof v === "boolean") return v;
  if (v === "true" || v === "yes") return true;
  if (v === "false" || v === "no") return false;
  return undefined;
}

/** JSON schema handed to Ollama's `format` so the teacher must answer in shape. */
export function teacherSchema(questions: Questions): Record<string, unknown> {
  const properties: Record<string, unknown> = {};
  for (const [id, q] of Object.entries(questions)) {
    const answer =
      q.type === "choice"
        ? { type: "string", enum: choiceLabels(q) }
        : q.type === "score"
          ? { type: "integer", minimum: 0, maximum: scoreLevels(q) - 1 }
          : { type: "boolean" };
    properties[id] = {
      type: "object",
      properties: { answer, reason: { type: "string" } },
      required: ["answer", "reason"],
    };
  }
  return { type: "object", properties, required: Object.keys(questions) };
}

/** Plain-language rendering of the question set for the teacher prompt. */
export function describeQuestions(questions: Questions): string {
  const out: string[] = [];
  for (const [id, q] of Object.entries(questions)) {
    const ins = text(q.instructions) || id;
    if (q.type === "choice") {
      const opts = Array.isArray(q.criteria)
        ? q.criteria.map((l) => `    - "${l}"`)
        : Object.entries(q.criteria).map(([l, d]) => `    - "${l}"${d ? `: ${text(d)}` : ""}`);
      out.push(`- ${id} (choose exactly one label): ${ins}\n${opts.join("\n")}`);
    } else if (q.type === "score") {
      const lv = q.criteria.map((d, i) => `    - ${i}: ${text(d)}`);
      out.push(`- ${id} (integer level): ${ins}\n${lv.join("\n")}`);
    } else {
      const t = q.criteria?.true ? ` true = ${text(q.criteria.true)}.` : "";
      const f = q.criteria?.false ? ` false = ${text(q.criteria.false)}.` : "";
      out.push(`- ${id} (true or false): ${ins}${t}${f}`);
    }
  }
  return out.join("\n");
}

/** Probability the student gave to a particular simple value (for calibration). */
export function studentProbs(q: Question, a: any): { labels: string[]; probs: number[] } | undefined {
  if (!a) return undefined;
  if ((q.type === "choice" || q.type === "score") && a.probabilities && typeof a.probabilities === "object") {
    const labels = Object.keys(a.probabilities);
    return { labels, probs: labels.map((l) => Number(a.probabilities[l])) };
  }
  if (q.type === "noul" && typeof a.noul === "number") {
    return { labels: ["false", "true"], probs: [1 - a.noul, a.noul] };
  }
  return undefined;
}

export function valueKey(q: Question, v: SimpleValue): string {
  if (q.type === "noul") return String(v === true);
  return String(v);
}
