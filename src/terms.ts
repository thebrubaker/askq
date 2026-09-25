import type { View } from "./render";

export const MAX_TERMS = 12;
export const MAX_TERM_WORDS = 6;

export type TermSource = "context" | "--watch";

export type Term = { term: string; from: TermSource[]; forms: string[]; pattern: RegExp };

const SEPARATORS = /[\s\-_]+/;
const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const keyOf = (s: string) => s.toLowerCase().split(SEPARATORS).filter(Boolean).join(" ");

function clean(raw: string): string {
  return raw
    .trim()
    .replace(/^["'“”‘’`]+|["'“”‘’`.;:]+$/g, "")
    .replace(/^@/, "")
    .trim();
}

export function splitTerms(raw: string): string[] {
  if (/^\s*(none|n\/a|-)\s*\.?\s*$/i.test(raw)) return [];
  return raw
    .split(/[,;]/)
    .map(clean)
    .filter((t) => t.length > 0);
}

export function formsOf(term: string): string[] {
  const tokens = term.split(SEPARATORS).filter(Boolean);
  const forms = [tokens.join(" ")];
  for (let i = 1; tokens.length - i >= 2; i++) forms.push(tokens.slice(i).join(" "));
  return forms;
}

const LATIN_OR_DIGIT = /[\p{Script=Latin}\p{N}]/u;

function patternOf(forms: string[]): RegExp {
  const alternatives = forms.map((f) => {
    const body = f.split(" ").map(escape).join("[\\s\\-_]*");
    const before = LATIN_OR_DIGIT.test(f[0]!) ? "(?<![\\p{Script=Latin}\\p{N}])" : "";
    const after = LATIN_OR_DIGIT.test(f[f.length - 1]!) ? "(?![\\p{Script=Latin}\\p{N}])" : "";
    return `${before}${body}${after}`;
  });
  return new RegExp(alternatives.join("|"), "iu");
}

export function buildTerms(named: readonly string[], watch: readonly string[]): Term[] {
  const byKey = new Map<string, Term>();
  const add = (raw: string, source: TermSource) => {
    const term = clean(raw);
    const words = term.split(SEPARATORS).filter(Boolean);
    if (!term || words.length > MAX_TERM_WORDS || term.length > 60) return;
    const key = keyOf(term);
    const known = byKey.get(key);
    if (known) {
      if (!known.from.includes(source)) known.from.push(source);
      return;
    }
    const forms = formsOf(term);
    byKey.set(key, { term, from: [source], forms, pattern: patternOf(forms) });
  };
  for (const w of watch) add(w, "--watch");
  for (const n of named) add(n, "context");
  return [...byKey.values()].slice(0, MAX_TERMS);
}

function searchable(view: View, pointer: string): string {
  if (pointer.startsWith("q")) {
    const b = view.blocks.find((x) => x.pointer === pointer);
    return b ? [b.text, b.author ?? ""].join("\n") : "";
  }
  const e = view.entries.get(Number(pointer.slice(1)));
  if (!e) return "";
  return view.hasText ? [e.text, e.reposted ?? "", e.author ?? ""].join("\n") : e.rendered;
}

export function matchTerms(
  terms: readonly Term[],
  view: View,
  order: readonly string[],
): Map<Term, string[]> {
  const hits = new Map<Term, string[]>(terms.map((t) => [t, []]));
  const pointers = [...order, ...view.empties.map((e) => e.pointer)];
  for (const pointer of pointers) {
    const text = searchable(view, pointer);
    if (!text) continue;
    for (const t of terms) if (t.pattern.test(text)) hits.get(t)!.push(pointer);
  }
  return hits;
}

export function termsByPointer(hits: Map<Term, string[]>): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const [t, pointers] of hits) {
    for (const p of pointers) out.set(p, [...(out.get(p) ?? []), t.term]);
  }
  return out;
}
