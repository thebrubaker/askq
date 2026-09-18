import { UsageError } from "./questions";

type Step = { key: string } | { index: number };

export type Extracted = { ok: true; text: string } | { ok: false; reason: string };

export function parsePath(path: string): Step[] {
  if (path === ".") return [];
  if (!path.startsWith(".")) {
    throw new UsageError(`--field must start with '.', got: ${path}`);
  }
  const steps: Step[] = [];
  let i = 0;
  while (i < path.length) {
    const ch = path[i];
    if (ch === ".") {
      i++;
      let key = "";
      while (i < path.length && path[i] !== "." && path[i] !== "[") {
        key += path[i];
        i++;
      }
      if (key.length === 0) {
        throw new UsageError(`--field has an empty key: ${path}`);
      }
      steps.push({ key });
      continue;
    }
    if (ch === "[") {
      const close = path.indexOf("]", i);
      if (close === -1) throw new UsageError(`--field has an unclosed '[': ${path}`);
      const raw = path.slice(i + 1, close);
      if (!/^\d+$/.test(raw)) {
        throw new UsageError(`--field index must be a non-negative integer: ${path}`);
      }
      steps.push({ index: Number(raw) });
      i = close + 1;
      continue;
    }
    throw new UsageError(`--field is not a supported path: ${path}`);
  }
  return steps;
}

export function extract(item: unknown, path: string, steps: Step[]): Extracted {
  let cur: unknown = item;
  for (const step of steps) {
    if (cur === null || cur === undefined) {
      return { ok: false, reason: `field ${path} missing` };
    }
    if ("key" in step) {
      if (typeof cur !== "object" || Array.isArray(cur)) {
        return { ok: false, reason: `field ${path} missing` };
      }
      if (!Object.prototype.hasOwnProperty.call(cur, step.key)) {
        return { ok: false, reason: `field ${path} missing` };
      }
      cur = (cur as Record<string, unknown>)[step.key];
    } else {
      if (!Array.isArray(cur)) {
        return { ok: false, reason: `field ${path} missing` };
      }
      if (step.index >= cur.length) {
        return { ok: false, reason: `field ${path} missing` };
      }
      cur = cur[step.index];
    }
  }

  if (cur === null || cur === undefined) {
    return { ok: false, reason: `field ${path} is null` };
  }

  // An empty container serializes to "{}" or "[]", which is text a model will happily answer
  // about. There is nothing in it to answer about, so it is empty in the same sense "" is.
  if (typeof cur === "object" && Object.keys(cur).length === 0) {
    return { ok: false, reason: `field ${path} empty` };
  }

  const text =
    typeof cur === "string"
      ? cur
      : typeof cur === "number" || typeof cur === "boolean"
        ? String(cur)
        : JSON.stringify(cur);

  if (text.trim().length === 0) {
    return { ok: false, reason: `field ${path} empty` };
  }
  return { ok: true, text };
}
