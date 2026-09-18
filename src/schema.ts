import type { Question } from "./questions";

export const SCORE_VALUES = ["0", "1", "2", "3", "4", "5", "6", "7", "8", "9", "10"];

export type SchemaProperty = { type: "STRING"; enum?: string[] };

export type ResponseSchema = {
  type: "OBJECT";
  properties: Record<string, SchemaProperty>;
  required: string[];
  propertyOrdering: string[];
};

export function whyKey(q: Question): string {
  return `${q.name}_why`;
}

/** Every key askq will write into an output record, so one list guards every collision. */
export function answerKeys(questions: Question[], why: boolean): string[] {
  return questions.flatMap((q) => (why ? [q.name, whyKey(q)] : [q.name]));
}

export function allowedValues(q: Question): string[] {
  switch (q.kind) {
    case "bool":
      return ["true", "false"];
    case "choice":
      return q.values;
    case "score":
      return SCORE_VALUES;
  }
}

export function buildSchema(questions: Question[], why = false): ResponseSchema {
  const properties: Record<string, SchemaProperty> = {};
  for (const q of questions) {
    properties[q.name] = { type: "STRING", enum: allowedValues(q) };
    if (why) properties[whyKey(q)] = { type: "STRING" };
  }
  const names = answerKeys(questions, why);
  return { type: "OBJECT", properties, required: names, propertyOrdering: names };
}

export type Coerced =
  { ok: true; value: boolean | string | number } | { ok: false; reason: string };

export function coerceAnswer(q: Question, raw: unknown): Coerced {
  if (typeof raw !== "string") {
    return { ok: false, reason: `${q.name} missing from the model's answer` };
  }
  const value = raw.trim();
  if (!allowedValues(q).includes(value)) {
    return { ok: false, reason: `${q.name} answered '${value}', which is not an allowed value` };
  }
  switch (q.kind) {
    case "bool":
      return { ok: true, value: value === "true" };
    case "choice":
      return { ok: true, value };
    case "score":
      return { ok: true, value: Number(value) };
  }
}

export function coerceWhy(q: Question, raw: unknown): Coerced {
  if (typeof raw !== "string" || raw.trim().length === 0) {
    return { ok: false, reason: `${whyKey(q)} missing from the model's answer` };
  }
  return { ok: true, value: raw.trim() };
}
