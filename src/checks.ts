import type { Verdict, VerdictLine } from "./parse";
import { handleKey, type View } from "./render";

export const RANK: Record<Verdict, number> = { skip: 0, maybe: 1, read: 2 };
export const REPEAT_THRESHOLD = 5;

export type Judgement = {
  verdict: Verdict;
  tag: string;
  reason: string;
  notes: string[];
  review?: string | undefined;
};

export type Tally = { missing: string[]; duplicates: string[]; unknown: string[] };

export function collect(
  lines: readonly VerdictLine[],
  scope: readonly string[],
  into: Map<string, Judgement>,
): Tally {
  const wanted = new Set(scope);
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  const unknown: string[] = [];
  for (const l of lines) {
    if (!wanted.has(l.pointer)) {
      unknown.push(l.pointer);
      continue;
    }
    const prior = into.get(l.pointer);
    if (seen.has(l.pointer)) {
      duplicates.add(l.pointer);
      if (prior && RANK[l.verdict] <= RANK[prior.verdict]) continue;
    }
    seen.add(l.pointer);
    into.set(l.pointer, { verdict: l.verdict, tag: l.tag, reason: l.reason, notes: [] });
  }
  return { missing: scope.filter((p) => !into.has(p)), duplicates: [...duplicates], unknown };
}

export function mergeVotes(votes: readonly Judgement[]): Judgement {
  const best = votes.reduce((a, b) => (RANK[b.verdict] > RANK[a.verdict] ? b : a));
  const verdict: Verdict = votes.every((v) => v.verdict === "read")
    ? "read"
    : votes.some((v) => v.verdict !== "skip")
      ? "maybe"
      : "skip";
  return { ...best, verdict, notes: [...best.notes] };
}

export function ownAccounts(view: View, handles: readonly string[]): string[] {
  const authors = new Set(
    [...[...view.entries.values()].map((e) => e.author), ...view.blocks.map((b) => b.author)]
      .map(handleKey)
      .filter(Boolean),
  );
  const seen = new Set<string>();
  return handles.filter((h) => {
    const key = handleKey(h);
    if (!authors.has(key) || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function liftFragments(judged: Map<string, Judgement>): string[] {
  const lifted: string[] = [];
  for (const [pointer, j] of judged) {
    if (j.verdict !== "skip" || !/^fragment/.test(j.tag)) continue;
    j.verdict = "maybe";
    j.notes.push("the model skipped a fragment; askq lifted it to maybe");
    lifted.push(pointer);
  }
  return lifted;
}

export function authorOf(view: View, pointer: string): string | undefined {
  if (pointer.startsWith("q")) return view.blocks.find((b) => b.pointer === pointer)?.author;
  return view.entries.get(Number(pointer.slice(1)))?.author;
}

export function liftOwn(
  judged: Map<string, Judgement>,
  view: View,
  own: readonly string[],
  namedBy: (account: string) => string = () => "the overview",
): string[] {
  const accounts = new Set(own.map(handleKey).filter(Boolean));
  if (accounts.size === 0) return [];
  const lifted: string[] = [];
  for (const [pointer, j] of judged) {
    if (j.verdict !== "skip") continue;
    const author = authorOf(view, pointer);
    if (!author || !accounts.has(handleKey(author))) continue;
    j.verdict = "maybe";
    j.notes.push(
      `by ${author}, an account ${namedBy(handleKey(author))} names as the subject's own; askq lifted it to maybe`,
    );
    lifted.push(pointer);
  }
  return lifted;
}

export const POINTER_TEXT_MAX = 20;

const ownWords = (text: string) => text.replace(/https?:\/\/\S+|@\w+/g, "").trim();

export function liftPointers(judged: Map<string, Judgement>, view: View): string[] {
  const lifted: string[] = [];
  for (const e of view.sent) {
    const j = judged.get(e.pointer);
    if (j?.verdict !== "skip" || ownWords(e.text).length > POINTER_TEXT_MAX) continue;
    const target = e.links.find(
      (l) =>
        l.kind === "quote" && "pointer" in l && RANK[judged.get(l.pointer)?.verdict ?? "skip"] > 0,
    );
    if (!target || !("pointer" in target)) continue;
    const where = target.pointer.startsWith("q")
      ? `the post it quotes (askq_ref ${target.pointer})`
      : `line ${Number(target.pointer.slice(1))}, the post it quotes`;
    j.verdict = "maybe";
    j.notes.push(`a short post pointing at ${where}, which was kept; askq lifted it to maybe`);
    lifted.push(e.pointer);
  }
  return lifted;
}

export type Repeat = { reason: string; pointers: string[]; window?: number };

export function repeatedReasons(
  judged: Map<string, Judgement>,
  threshold = REPEAT_THRESHOLD,
): Repeat[] {
  const byReason = new Map<string, string[]>();
  for (const [pointer, j] of judged) {
    const reason = j.reason.trim();
    if (!reason || j.tag === "empty") continue;
    byReason.set(reason, [...(byReason.get(reason) ?? []), pointer]);
  }
  const repeats = [...byReason]
    .filter(([, ps]) => ps.length >= threshold)
    .map(([reason, pointers]) => ({ reason, pointers }))
    .sort((a, b) => b.pointers.length - a.pointers.length);
  for (const r of repeats) {
    for (const p of r.pointers) {
      const j = judged.get(p);
      if (j) j.review = `shares the reason "${r.reason}" with ${r.pointers.length - 1} other items`;
    }
  }
  return repeats;
}
