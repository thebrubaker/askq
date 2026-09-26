import { CHARS_PER_TOKEN } from "./cost";
import type { Block, Entry, View } from "./render";

export const CHUNK_ABOVE = 400;
export const CHUNK_TOKENS = 160_000;
export const WINDOW_SIZE = 60;
export const WINDOW_TOKENS = 60_000;
export const CONTEXT_CAP = 40;
export const CONCURRENCY = 8;
export const MIN_WINDOW = 60;

export const overlapFor = (size: number) => Math.floor(size / 4);
export const halfOverlap = (size: number) => Math.floor(size / 2);

export type Window = {
  index: number;
  entries: Entry[];
  blocks: Block[];
  context: Entry[];
  pointers: string[];
};

type Unit = { entries: Entry[]; root?: Entry | undefined };

const tokensOf = (entries: readonly Entry[]) =>
  entries.reduce((n, e) => n + Math.ceil(e.rendered.length / CHARS_PER_TOKEN), 0);

function unitsOf(view: View, size: number, overlap: number): Unit[] {
  const runs: Entry[][] = [];
  let key: string | undefined;
  for (const e of view.sent) {
    const k = view.groupOf.get(e.line) ?? `l:${e.line}`;
    if (k !== key || runs.length === 0) runs.push([]);
    runs[runs.length - 1]!.push(e);
    key = k;
  }
  const units: Unit[] = [];
  for (const run of runs) {
    if (run.length <= size) {
      units.push({ entries: run });
      continue;
    }
    const stride = Math.max(1, size - overlap);
    for (let s = 0; s < run.length; s += stride) {
      units.push({ entries: run.slice(s, s + size), root: s > 0 ? run[0] : undefined });
      if (s + size >= run.length) break;
    }
  }
  return units;
}

export function planWindows(
  view: View,
  size = WINDOW_SIZE,
  overlap = overlapFor(size),
  maxTokens = WINDOW_TOKENS,
  wrap = false,
): Window[] {
  const groups: Unit[][] = [];
  let current: Unit[] = [];
  const count = (us: Unit[]) => us.reduce((n, u) => n + u.entries.length, 0);
  const tokens = (us: Unit[]) => us.reduce((n, u) => n + tokensOf(u.entries), 0);

  for (const unit of unitsOf(view, size, overlap)) {
    const n = unit.entries.length;
    const t = tokensOf(unit.entries);
    if (current.length > 0 && (count(current) + n > size || tokens(current) + t > maxTokens)) {
      groups.push(current);
      const budget = Math.min(overlap, size - n);
      let carry: Unit[] = [];
      for (let i = current.length - 1; i >= 0 && budget > 0; i--) {
        const u = current[i]!;
        if (count(carry) + u.entries.length > budget) {
          if (carry.length === 0) carry = [{ entries: u.entries.slice(-budget), root: u.root }];
          break;
        }
        carry.unshift(u);
      }
      current = tokens(carry) + t > maxTokens ? [] : carry;
    }
    current.push(unit);
  }
  if (current.length > 0) groups.push(current);
  if (wrap && groups.length > 1) {
    const seen = new Map<string, number>();
    for (const g of groups)
      for (const p of new Set(g.flatMap((u) => u.entries.map((e) => e.pointer))))
        seen.set(p, (seen.get(p) ?? 0) + 1);
    const once = view.sent.filter((e) => (seen.get(e.pointer) ?? 0) < 2);
    for (let s = 0; s < once.length; s += size) groups.push([{ entries: once.slice(s, s + size) }]);
  }

  const sentPointers = new Set(view.sent.map((e) => e.pointer));
  return groups.map((units, index) => {
    const seen = new Set<string>();
    const entries: Entry[] = [];
    for (const u of units)
      for (const e of u.entries)
        if (!seen.has(e.pointer)) {
          seen.add(e.pointer);
          entries.push(e);
        }
    const blockPointers = new Set<string>();
    const contextPointers = new Set<string>();
    for (const u of units)
      if (u.root && !seen.has(u.root.pointer)) contextPointers.add(u.root.pointer);
    for (const e of entries)
      for (const l of e.links) {
        if (!("pointer" in l)) continue;
        if (l.pointer.startsWith("q")) blockPointers.add(l.pointer);
        else if (!seen.has(l.pointer) && sentPointers.has(l.pointer))
          contextPointers.add(l.pointer);
      }
    const blocks = view.blocks.filter((b) => blockPointers.has(b.pointer));
    const context = [...contextPointers]
      .map((p) => view.entries.get(Number(p.slice(1)))!)
      .sort((a, b) => a.line - b.line)
      .slice(0, CONTEXT_CAP);
    return {
      index,
      entries,
      blocks,
      context,
      pointers: [...entries.map((e) => e.pointer), ...blocks.map((b) => b.pointer)],
    };
  });
}
