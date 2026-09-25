import { createHash } from "node:crypto";
import type { Judgement, Repeat } from "./checks";
import { formatUsd } from "./cost";
import type { Claim } from "./parse";
import { at, SNIPPET_MAX, type Block, type View } from "./render";
import type { Term } from "./terms";

export const READ_CAP = 40;
export const MAYBE_CAP = 25;
export const SPOT_CHECK = 5;
export const LINE_LIST_CAP = 20;
export const TERM_SKIP_LIST_CAP = 10;
export const AUTHOR_COLLAPSE = 3;

export type ChunkInfo = {
  why: "flag" | "items" | "tokens";
  windows: number;
  size: number;
  overlap: number;
  twice: number;
  disagreed: number;
  retried: number[];
  failed: { window: number; reason: string }[];
  overviewFailed: string | undefined;
  leadsFailed: string | undefined;
  ownFrom: { handle: string; from: string[] }[];
};

export type RollupInput = {
  view: View;
  model: string;
  rolesLine: string;
  judged: Map<string, Judgement>;
  errors: Map<number, string>;
  blockErrors: Map<string, string>;
  summary: Claim[];
  own: string[];
  calls: number;
  ms: number;
  tokensIn: number;
  tokensOut: number;
  usd: number | undefined;
  repaired: string[];
  duplicates: string[];
  unknown: string[];
  unparsed: number;
  lifts: { fragments: string[]; own: string[] };
  repeats: Repeat[];
  hits: Map<Term, string[]>;
  textPath: string | undefined;
  file: string;
  badLines: number;
  interrupted: boolean;
  aborted: string | undefined;
  chunk?: ChunkInfo | undefined;
};

const CHUNK_WHY = {
  flag: (c: ChunkInfo) => `--window ${c.size} asked for windows`,
  items: () => "over 400 items",
  tokens: () => "too long for one call",
};

function chunkLine(c: ChunkInfo): string {
  return (
    `chunked: ${CHUNK_WHY[c.why](c)}, so judged in ${c.windows} windows of up to ${c.size} items that overlap by ${c.overlap}, ` +
    `not in one call. ${c.twice} items were judged twice and kept the higher verdict (${c.disagreed} disagreed). ` +
    "Expect a longer maybe list than one call would give."
  );
}

function ownList(input: RollupInput): string {
  if (!input.chunk) return input.own.map(at).join(" ");
  return input.chunk.ownFrom.map((o) => `${at(o.handle)} (${o.from.join(", ")})`).join(" ");
}

const lineOf = (pointer: string) => Number(pointer.slice(1));

function list(lines: number[], cap = LINE_LIST_CAP): string {
  const shown = lines.slice(0, cap).join(" ");
  return lines.length > cap ? `${shown} +${lines.length - cap}` : shown;
}

function blockLabel(b: Block): string {
  const verb = b.kind === "quote" ? "quoted by" : "reposted by";
  return b.lines.length === 1
    ? `${verb} ${b.lines[0]}`
    : `${verb} ${b.lines.length}: ${list(b.lines, 6)}`;
}

function row(input: RollupInput, pointer: string, j: Judgement | undefined): string[] {
  const { view } = input;
  const said = j ? `${j.tag || "?"}${j.reason ? `: ${j.reason}` : ""}` : "";
  const lifted = j?.notes.some((n) => n.includes("lifted")) ? "  (lifted to maybe by askq)" : "";
  if (pointer.startsWith("q")) {
    const b = view.blocks.find((x) => x.pointer === pointer)!;
    const via = view.entries.get(b.lines[0]!);
    const open = via?.id ? `via ${via.id}` : `via line ${b.lines[0]}`;
    return [
      `  [${blockLabel(b)}] ${b.author ?? "author not in the data"} · ${said}${lifted}`,
      `      ${open} · "${snip(b.text)}"`,
    ];
  }
  const e = view.entries.get(lineOf(pointer))!;
  const who = e.author ? at(e.author) : "—";
  return [
    `  [${e.line}] ${who} · ${said}${lifted}`,
    `      ${e.id ?? `line ${e.line}`} · "${e.snippet}"`,
  ];
}

function snip(s: string, max = SNIPPET_MAX): string {
  const flat = s.replace(/\s+/g, " ").trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
}

function pointerLabel(view: View, pointer: string): string {
  if (!pointer.startsWith("q")) return String(lineOf(pointer));
  const b = view.blocks.find((x) => x.pointer === pointer);
  return b ? `the post ${b.kind === "quote" ? "quoted" : "reposted"} by ${b.lines[0]}` : pointer;
}

export function displayOrder(view: View): string[] {
  const after = new Map<number, string[]>();
  for (const b of view.blocks)
    after.set(b.lines[0]!, [...(after.get(b.lines[0]!) ?? []), b.pointer]);
  const out: string[] = [];
  for (const e of view.sent) out.push(e.pointer, ...(after.get(e.line) ?? []));
  for (const b of view.blocks) if (!out.includes(b.pointer)) out.push(b.pointer);
  return out;
}

type Group = { lead: string; author: string; rest: string[] };

function collapseByAuthor(view: View, pointers: string[]): Group[] {
  const authorOf = (p: string) => {
    if (p.startsWith("q")) return undefined;
    const a = view.entries.get(lineOf(p))?.author;
    return a ? at(a) : undefined;
  };
  const count = new Map<string, number>();
  for (const p of pointers) {
    const a = authorOf(p);
    if (a) count.set(a.toLowerCase(), (count.get(a.toLowerCase()) ?? 0) + 1);
  }
  const groups: Group[] = [];
  const open = new Map<string, Group>();
  for (const p of pointers) {
    const a = authorOf(p);
    const key = a?.toLowerCase();
    if (a && key && (count.get(key) ?? 0) >= AUTHOR_COLLAPSE) {
      const g = open.get(key);
      if (g) {
        g.rest.push(p);
        continue;
      }
      const fresh = { lead: p, author: a, rest: [] as string[] };
      open.set(key, fresh);
      groups.push(fresh);
      continue;
    }
    groups.push({ lead: p, author: a ?? "", rest: [] });
  }
  return groups;
}

const jqString = (s: string) => JSON.stringify(s).replace(/'/g, "'\\''");

export const RECORDS_REF = '"$R"';

export function shellAssign(path: string): string {
  return /^[A-Za-z0-9_./@%+=:,-]+$/.test(path) ? `R=${path}` : `R='${path.replace(/'/g, "'\\''")}'`;
}

function skipTags(judged: Map<string, Judgement>, view: View, skipped: string[]): string {
  const counts = new Map<string, number>();
  for (const p of skipped) {
    const tag = isEmpty(view, p) ? "empty" : judged.get(p)?.tag || "untagged";
    counts.set(tag, (counts.get(tag) ?? 0) + 1);
  }
  const tags = [...counts].sort((a, b) => b[1] - a[1]).map(([t]) => t);
  if (tags.length === 1) return skipped.length > 1 ? ` (all ${tags[0]})` : ` (${tags[0]})`;
  if (skipped.length <= 3) return ` (${tags.join(", ")})`;
  return ` (mostly ${tags.slice(0, 2).join(", ")})`;
}

function termLines(input: RollupInput): string[] {
  const { view, judged } = input;
  const out: string[] = [];
  for (const [t, pointers] of input.hits) {
    const from = t.from.map((f) => (f === "context" ? "context" : "--watch")).join(" and ");
    const also =
      t.forms.length > 1
        ? ` · also as ${t.forms
            .slice(1)
            .map((f) => `"${f}"`)
            .join(", ")}`
        : "";
    const head = `  ${t.term} · from ${from}${also} · `;
    if (pointers.length === 0) {
      out.push(`${head}no items`);
      continue;
    }
    const of = (v: string) => pointers.filter((p) => judged.get(p)?.verdict === v);
    const skipped = pointers.filter((p) => judged.get(p)?.verdict === "skip" || isEmpty(view, p));
    const unjudged = pointers.filter((p) => !judged.has(p) && !isEmpty(view, p)).length;
    const counts =
      `${pointers.length} item${pointers.length === 1 ? "" : "s"}: ${of("read").length} read, ` +
      `${of("maybe").length} maybe, ${skipped.length} skipped` +
      (skipped.length ? skipTags(judged, view, skipped) : "") +
      (unjudged ? `, ${unjudged} without a verdict` : "");
    const detail =
      skipped.length === 0
        ? ""
        : skipped.length <= TERM_SKIP_LIST_CAP
          ? `: lines ${[...skipped]
              .sort((a, b) => (a[0] === b[0] ? lineOf(a) - lineOf(b) : a < b ? -1 : 1))
              .map((p) => pointerLabel(view, p))
              .join(", ")}`
          : `: jq -c 'select(.verdict=="skip" and any((.askq_terms // [])[]; . == ${jqString(t.term)}))' ${RECORDS_REF}`;
    out.push(`${head}${counts}${detail}`);
  }
  return out;
}

function isEmpty(view: View, pointer: string): boolean {
  return view.empties.some((e) => e.pointer === pointer);
}

function spotCheck(input: RollupInput): string[] {
  const byTag = new Map<string, string[]>();
  for (const p of displayOrder(input.view)) {
    const j = input.judged.get(p);
    if (j?.verdict !== "skip") continue;
    byTag.set(j.tag, [...(byTag.get(j.tag) ?? []), p]);
  }
  const hash = (p: string) => createHash("sha256").update(`askq-spot-check:${p}`).digest("hex");
  const queues = [...byTag.values()]
    .sort((a, b) => b.length - a.length)
    .map((q) => [...q].sort((a, b) => (hash(a) < hash(b) ? -1 : 1)));
  const picked: string[] = [];
  for (let k = 0; picked.length < SPOT_CHECK && queues.some((q) => q.length > k); k++) {
    for (const q of queues)
      if (q[k] !== undefined && picked.length < SPOT_CHECK) picked.push(q[k]!);
  }
  const rank = new Map(displayOrder(input.view).map((p, i) => [p, i]));
  return picked.sort((a, b) => rank.get(a)! - rank.get(b)!);
}

export function rollup(input: RollupInput): string[] {
  const { view, judged } = input;
  const out: string[] = [];
  const w = (s = "") => out.push(s);
  const file = input.file;

  const shown = displayOrder(view);
  const count = (v: string) => shown.filter((p) => judged.get(p)?.verdict === v);
  const read = count("read");
  const maybe = count("maybe");
  const skipped = count("skip");

  const cost = input.usd === undefined ? "" : ` · ~${formatUsd(input.usd)}`;
  w(
    `askq · ${view.total} items · ${input.model} · ${input.calls} call${input.calls === 1 ? "" : "s"} · ` +
      `${(input.ms / 1000).toFixed(1)}s · ${input.tokensIn.toLocaleString("en-US")} in + ` +
      `${input.tokensOut.toLocaleString("en-US")} out tokens${cost}`,
  );
  if (input.chunk) w(chunkLine(input.chunk));
  w(
    file === "(stdout)"
      ? "records: on stdout (--out -); set R to the file you saved them in, and the commands below read it"
      : `${shellAssign(file)}   # the records: every item with its verdict, tag, reason and the item itself; the commands below read "$R"`,
  );
  w(`roles: ${input.rolesLine}`);

  const warnings: string[] = [];
  if (input.aborted)
    warnings.push(`the run stopped: ${input.aborted}. Items without a verdict carry askq_error.`);
  if (input.interrupted) warnings.push("interrupted: items without a verdict carry askq_error.");
  const missing = [...input.errors.keys()].sort((a, b) => a - b);
  if (missing.length > 0) {
    warnings.push(
      `coverage incomplete: ${missing.length} of ${view.total} lines have no verdict (lines ${list(missing)}); ` +
        `each carries askq_error in the records. Read them yourself.`,
    );
  }
  if (input.blockErrors.size > 0) {
    warnings.push(
      `${input.blockErrors.size} referenced posts got no verdict: ${[...input.blockErrors.keys()].map((p) => pointerLabel(view, p)).join("; ")}.`,
    );
  }
  for (const f of input.chunk?.failed ?? []) {
    warnings.push(
      `window ${f.window} got no answer, even when sent again: ${f.reason}. Its items that no other window judged carry askq_error.`,
    );
  }
  if (input.chunk?.overviewFailed) {
    warnings.push(
      `the overview call failed (${input.chunk.overviewFailed}): the subject's own accounts come from the windows alone, ` +
        "and the terms block has only --watch terms.",
    );
  }
  if (input.chunk?.leadsFailed) {
    warnings.push(`the leads call failed (${input.chunk.leadsFailed}), so there are no leads.`);
  }
  for (const r of input.repeats) {
    warnings.push(
      `${r.pointers.length} items${r.window ? ` in window ${r.window}` : ""} share the reason "${r.reason}": the model may have judged them as a group, not ` +
        `one by one. Read a few: ${r.pointers
          .slice(0, LINE_LIST_CAP)
          .map((p) => pointerLabel(view, p))
          .join(", ")}.`,
    );
  }
  if (!input.aborted && !input.interrupted && judged.size > 0 && read.length === 0) {
    warnings.push(
      "nothing was marked read: the question may not match this data. Check the maybe list and the spot-check.",
    );
  }
  if (warnings.length > 0) {
    w();
    for (const x of warnings) w(`warning: ${x}`);
  }

  if (input.summary.length > 0) {
    w();
    w(
      "leads — the model's summary of the set. Leads to verify, not facts: check each against the items it cites.",
    );
    for (const c of input.summary) {
      const cites = c.pointers.length
        ? `  [${c.pointers.map((p) => pointerLabel(view, p)).join(", ")}]`
        : "";
      w(`  - ${c.text}${cites}`);
    }
  }

  if (input.hits.size > 0) {
    w();
    w(
      "terms — how the items that name each term were judged (post text and author; case, spaces and hyphens ignored)",
    );
    for (const l of termLines(input)) w(l);
  }

  const named = new Set([...input.hits.values()].flat());
  const namedFirst = [...maybe.filter((p) => named.has(p)), ...maybe.filter((p) => !named.has(p))];
  const sortedNote = maybe.some((p) => named.has(p)) ? "; items naming a term first" : "";

  const example = [...read, ...maybe].find((p) => !p.startsWith("q")) ?? view.sent[0]?.pointer;
  if (example) {
    w();
    w(
      `snippets are cut at ${SNIPPET_MAX} characters; the records hold the full text: ` +
        `jq -r 'select(.askq_line==${lineOf(example)}) | .item${input.textPath ?? ""}' ${RECORDS_REF}`,
    );
  }

  const section = (title: string, pointers: string[], cap: number, verdict: string, note = "") => {
    w();
    const refs = pointers.filter((p) => p.startsWith("q")).length;
    const split = refs ? ` (${pointers.length - refs} posts, ${refs} referenced posts)` : "";
    const groups = collapseByAuthor(view, pointers);
    const collapsed = groups.some((g) => g.rest.length > 0)
      ? `; authors with ${AUTHOR_COLLAPSE}+ here shown once`
      : "";
    w(
      `${title} — ${pointers.length}${split}${groups.length > cap ? `, first ${cap} rows shown` : ""}${note}${collapsed}`,
    );
    let reached = 0;
    for (const g of groups.slice(0, cap)) {
      out.push(...row(input, g.lead, judged.get(g.lead)));
      reached += 1 + g.rest.length;
      if (g.rest.length > 0) {
        w(
          `      … and ${g.rest.length} more by ${g.author} here: lines ${list(g.rest.map(lineOf).sort((a, b) => a - b))}`,
        );
      }
    }
    if (reached < pointers.length) {
      w(
        `  … ${pointers.length - reached} more: jq -c 'select(.verdict=="${verdict}")' ${RECORDS_REF}`,
      );
    }
  };
  section("read first", read, READ_CAP, "read");
  section("then maybe", namedFirst, MAYBE_CAP, "maybe", sortedNote);

  const spot = spotCheck(input);
  w();
  if (spot.length === 0) {
    w("spot-check — the model skipped nothing.");
  } else {
    w(
      `spot-check — ${spot.length} of the ${skipped.length} items the model skipped, one per tag. ` +
        "If one of these is what you wanted, the question missed it: reword it and run again.",
    );
    for (const p of spot) out.push(...row(input, p, judged.get(p)));
  }

  w();
  const judgedLines = view.total - missing.length;
  const modelLines = view.sent.filter((e) => judged.has(e.pointer)).length;
  const parts = [
    `${judgedLines}/${view.total} lines judged (${modelLines} by the model, ${view.empties.length} empty, skipped by askq)`,
  ];
  if (input.chunk) {
    const c = input.chunk;
    parts.push(
      `${c.windows} windows` +
        (c.retried.length
          ? `, window${c.retried.length === 1 ? "" : "s"} ${c.retried.join(", ")} sent twice`
          : ""),
    );
  }
  if (view.blocks.length)
    parts.push(
      `${view.blocks.length - input.blockErrors.size}/${view.blocks.length} referenced posts judged`,
    );
  if (input.repaired.length)
    parts.push(`${input.repaired.length} re-asked after the first answer missed them`);
  if (input.duplicates.length)
    parts.push(`${input.duplicates.length} answered twice (kept the higher)`);
  if (input.badLines) parts.push(`${input.badLines} lines were not JSON objects`);
  const most = Math.max(0, ...countReasons(judged));
  parts.push(
    input.repeats.length
      ? `repeated reasons: ${input.repeats.length} flagged`
      : `no reason repeated on 5+ items (most ${most})`,
  );
  const lifted = [
    input.lifts.fragments.length ? `${input.lifts.fragments.length} skipped fragments` : "",
    input.lifts.own.length
      ? input.chunk
        ? `${input.lifts.own.length} skipped posts by ${ownList(input)}, named as the subject's own`
        : `${input.lifts.own.length} skipped posts by ${input.own.map(at).join(" ")}, named in the overview as the subject's own`
      : "",
  ].filter(Boolean);
  if (lifted.length) parts.push(`lifted to maybe: ${lifted.join("; ")}`);
  else if (input.own.length)
    parts.push(
      input.chunk
        ? `the subject's own accounts: ${ownList(input)} (none of their posts skipped)`
        : `the subject's own accounts, per the overview: ${input.own.map(at).join(" ")} (none of their posts skipped)`,
    );
  w(`checks: ${parts.join(" · ")}`);
  w(`next: jq -c 'select(.verdict=="read")' ${RECORDS_REF}`);
  return out;
}

function countReasons(judged: Map<string, Judgement>): number[] {
  const counts = new Map<string, number>();
  for (const j of judged.values()) {
    if (j.reason) counts.set(j.reason, (counts.get(j.reason) ?? 0) + 1);
  }
  return [...counts.values()];
}
