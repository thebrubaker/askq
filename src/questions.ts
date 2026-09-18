export type Question =
  | { kind: "bool"; name: string; text: string }
  | { kind: "choice"; name: string; text: string; values: string[] }
  | { kind: "score"; name: string; text: string };

export type QuestionKind = Question["kind"];

export const RESERVED_KEYS = ["askq_error", "askq_review", "askq_line", "askq_id"];

export class UsageError extends Error {}

const NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

export type QuestionSpec = { kind: QuestionKind; spec: string };

export function parseQuestions(specs: QuestionSpec[]): Question[] {
  if (specs.length === 0) {
    throw new UsageError("no questions: pass at least one --bool, --choice or --score");
  }
  const questions: Question[] = [];
  const seen = new Set<string>();

  for (const { kind, spec } of specs) {
    const eq = spec.indexOf("=");
    if (eq < 1) {
      throw new UsageError(`--${kind} needs NAME=SPEC, got: ${spec}`);
    }
    const name = spec.slice(0, eq).trim();
    const rest = spec.slice(eq + 1).trim();

    if (!NAME_RE.test(name)) {
      throw new UsageError(`invalid question name '${name}': use letters, digits, underscore`);
    }
    if (RESERVED_KEYS.includes(name)) {
      throw new UsageError(`question name '${name}' is reserved by askq`);
    }
    if (seen.has(name)) {
      throw new UsageError(`duplicate question name '${name}'`);
    }
    seen.add(name);

    if (kind === "choice") {
      const split = rest.indexOf(": ");
      const rawValues = split === -1 ? rest : rest.slice(0, split);
      const text = split === -1 ? "" : rest.slice(split + 2).trim();
      const values = rawValues
        .split("|")
        .map((v) => v.trim())
        .filter((v) => v.length > 0);
      if (values.length < 2) {
        throw new UsageError(`--choice ${name} needs at least two values separated by '|'`);
      }
      if (new Set(values).size !== values.length) {
        throw new UsageError(`--choice ${name} has duplicate values`);
      }
      questions.push({ kind, name, text, values });
      continue;
    }

    if (rest.length === 0) {
      throw new UsageError(`--${kind} ${name} has no question text`);
    }
    questions.push({ kind, name, text: rest });
  }

  return questions;
}

export function outputKeys(questions: Question[]): string[] {
  return questions.map((q) => q.name);
}
