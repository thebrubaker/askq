import { UsageError } from "./errors";

export type Step = { key: string } | { index: number };

export type Extracted = { ok: true; text: string } | { ok: false; reason: string };

export function parsePath(path: string, flag = "--field"): Step[] {
  if (path === ".") return [];
  if (!path.startsWith(".")) {
    throw new UsageError(`${flag} must start with '.', got: ${path}`);
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
        throw new UsageError(`${flag} has an empty key: ${path}`);
      }
      steps.push({ key });
      continue;
    }
    if (ch === "[") {
      const close = path.indexOf("]", i);
      if (close === -1) throw new UsageError(`${flag} has an unclosed '[': ${path}`);
      const raw = path.slice(i + 1, close);
      if (!/^\d+$/.test(raw)) {
        throw new UsageError(`${flag} index must be a non-negative integer: ${path}`);
      }
      steps.push({ index: Number(raw) });
      i = close + 1;
      continue;
    }
    throw new UsageError(`${flag} is not a supported path: ${path}`);
  }
  return steps;
}

export function getPath(item: unknown, steps: Step[]): unknown {
  let cur: unknown = item;
  for (const step of steps) {
    if (cur === null || cur === undefined) return undefined;
    if ("key" in step) {
      if (typeof cur !== "object" || Array.isArray(cur)) return undefined;
      if (!Object.prototype.hasOwnProperty.call(cur, step.key)) return undefined;
      cur = (cur as Record<string, unknown>)[step.key];
    } else {
      if (!Array.isArray(cur) || step.index >= cur.length) return undefined;
      cur = cur[step.index];
    }
  }
  return cur;
}

export function extract(item: unknown, path: string, steps: Step[]): Extracted {
  const value = getPath(item, steps);
  if (value === undefined) return { ok: false, reason: `field ${path} missing` };
  if (value === null) return { ok: false, reason: `field ${path} is null` };

  if (typeof value === "object" && Object.keys(value).length === 0) {
    return { ok: false, reason: `field ${path} empty` };
  }

  const text =
    typeof value === "string"
      ? value
      : typeof value === "number" || typeof value === "boolean"
        ? String(value)
        : JSON.stringify(value);

  if (text.trim().length === 0) {
    return { ok: false, reason: `field ${path} empty` };
  }
  return { ok: true, text };
}
