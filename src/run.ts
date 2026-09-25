import {
  collect,
  liftFragments,
  liftOwn,
  liftPointers,
  repeatedReasons,
  type Judgement,
  type Repeat,
} from "./checks";
import { costOf, estimate, formatUsd, type Estimate } from "./cost";
import { Coverage } from "./coverage";
import { UsageError } from "./errors";
import type { Client } from "./gemini";
import { parseLine, splitLines } from "./lines";
import { parseLeads, parseResponse, type Claim } from "./parse";
import {
  buildLeadsPrompt,
  buildOverviewPrompt,
  buildPrompt,
  buildRepairPrompt,
  buildWindowPrompt,
  LEADS_MAX_CHARS,
  type Ask,
} from "./prompt";
import { judgeInWindows, type ChunkResult } from "./chunked";
import {
  CHUNK_ABOVE,
  CHUNK_TOKENS,
  overlapFor,
  planWindows,
  WINDOW_SIZE,
  type Window,
} from "./windows";
import { blockRecord, lineRecord, type LineOutcome } from "./records";
import { buildView, type View } from "./render";
import { getPath } from "./field";
import { describeRoles, resolveRoles, type Role, type Roles } from "./roles";
import { displayOrder, rollup, type ChunkInfo } from "./rollup";
import { buildTerms, matchTerms, termsByPointer } from "./terms";

export const VERSION = "0.3.0";
export const MAX_ITEMS = 2000;
export const MAX_INPUT_TOKENS = 400_000;
export const OVERVIEW_MODEL = "gemini-3.8-flash";

export type RunConfig = {
  ask: Ask;
  flags: Partial<Record<Role, string>>;
  autodetect: boolean;
  model: string;
  maxCost: number | undefined;
  yes: boolean;
  printPrompt: boolean;
  maxItems?: number;
  watch?: string[];
  window?: number | undefined;
};

export type Sink = (line: string) => void;

export type RunDeps = {
  client: () => Client;
  overviewClient?: () => Client;
  rollupOut: Sink;
  recordsOut: { path: string; write: (lines: string[]) => void };
  notice: Sink;
  now?: () => number;
  abort?: AbortSignal | undefined;
};

const ISO_START = /^\d{4}-\d{2}-\d{2}/;

export function capRefusal(view: View, roles: Roles, totalLines: number, cap: number): string[] {
  const refs = view.blocks.length;
  const out = [
    `askq: ${view.pointers.length} items to judge is over the ${cap.toLocaleString("en-US")} one run can safely handle. Nothing was sent.`,
    `askq:   ${view.sent.length} posts${refs ? `, plus ${refs} posts they quote or repost: each of those is judged as an item too` : ""}.`,
    "askq:   Split the input into two runs rather than filtering it: an item you drop to fit is never judged, " +
      "and nothing will tell you it was missed.",
  ];
  const time = roles.time;
  const stamps = time
    ? view.sent
        .map((e) => getPath(e.item, time.steps))
        .filter((t): t is string => typeof t === "string" && ISO_START.test(t))
        .sort()
    : [];
  if (time && stamps.length === view.sent.length && stamps.length > 1) {
    const mid = JSON.stringify(stamps[Math.floor(stamps.length / 2)]);
    out.push(
      `askq:   By time, at the midpoint: jq -c 'select(${time.path} < ${mid})' for one run and ` +
        `jq -c 'select(${time.path} >= ${mid})' for the other.`,
    );
  } else {
    out.push(
      `askq:   By position: split -l ${Math.ceil(totalLines / 2)} items.jsonl part- and run askq on each part.`,
    );
  }
  return out;
}

export async function run(input: string, cfg: RunConfig, deps: RunDeps): Promise<number> {
  const now = deps.now ?? (() => Date.now());
  const started = now();
  const lines = splitLines(input);
  if (lines.length === 0)
    throw new UsageError("no items on stdin: pipe JSONL in, one item per line");

  const items = new Map<number, Record<string, unknown>>();
  const bad = new Map<number, string>();
  lines.forEach((raw, i) => {
    const parsed = parseLine(raw);
    if (parsed.ok) items.set(i + 1, parsed.item);
    else bad.set(i + 1, parsed.reason);
  });

  const roles = resolveRoles([...items.values()], cfg.flags, cfg.autodetect);
  const view = buildView({ total: lines.length, items, roles });
  const rolesLine = describeRoles(roles, items.size);
  const ask = cfg.ask;
  const prompt = view.pointers.length > 0 ? buildPrompt(view, ask) : "";
  const single = estimate(prompt.length, view.pointers.length, cfg.model);
  const why: ChunkWhy | undefined =
    view.pointers.length === 0
      ? undefined
      : cfg.window !== undefined
        ? "flag"
        : view.pointers.length > CHUNK_ABOVE
          ? "items"
          : single.tokensIn > CHUNK_TOKENS
            ? "tokens"
            : undefined;
  const size = cfg.window ?? WINDOW_SIZE;
  const overlap = overlapFor(size);
  const plan: Window[] = why ? planWindows(view, size, overlap) : [];
  const windowPrompts = plan.map((w) => buildWindowPrompt(view, w, plan.length, ask));
  const overviewPrompt = why ? buildOverviewPrompt(view, ask) : "";

  if (cfg.printPrompt) {
    if (!why) {
      deps.rollupOut(prompt || "(nothing to send: every item is empty)");
      return 0;
    }
    deps.rollupOut(
      `askq: ${view.pointers.length} items would be judged in ${plan.length} windows. Below: the overview prompt ` +
        `(${OVERVIEW_MODEL}), then each window's. The leads prompt depends on the verdicts, so it is not shown.`,
    );
    deps.rollupOut(`=== overview ===\n${overviewPrompt}`);
    windowPrompts.forEach((p, k) =>
      deps.rollupOut(`=== window ${k + 1} of ${plan.length} ===\n${p}`),
    );
    return 0;
  }

  const cap = cfg.maxItems ?? MAX_ITEMS;
  if (view.pointers.length > cap) {
    for (const line of capRefusal(view, roles, lines.length, cap)) deps.notice(line);
    return 2;
  }

  const guess = why ? chunkEstimate(view, windowPrompts, plan, overviewPrompt, cfg.model) : single;
  if (cfg.maxCost !== undefined && !cfg.yes && guess.usd !== undefined && guess.usd > cfg.maxCost) {
    deps.notice(
      `askq: estimated ~${formatUsd(guess.usd)} for ${view.pointers.length} items` +
        (why ? ` in ${plan.length} windows` : "") +
        ` (${cfg.model}, ` +
        `~${guess.tokensIn.toLocaleString("en-US")} in + ${guess.tokensOut.toLocaleString("en-US")} out tokens), over ` +
        `--max-cost ${cfg.maxCost.toFixed(2)}. Nothing was sent. Re-run with --yes or raise --max-cost.`,
    );
    return 3;
  }

  const judged = new Map<string, Judgement>();
  let calls = 0;
  let tokensIn = 0;
  let tokensOut = 0;
  let aborted: string | undefined;
  let fatal = false;
  let interrupted = false;
  let summary: Claim[] = [];
  let own: string[] = [];
  let named: string[] = [];
  let repaired: string[] = [];
  let duplicates: string[] = [];
  let unknown: string[] = [];
  let unparsed = 0;
  let missing: string[] = [];

  let chunk: ChunkResult | undefined;

  if (view.pointers.length > 0 && !why) {
    const client = deps.client();
    deps.notice(
      `askq: ${view.pointers.length} items to ${client.model} in one call` +
        (view.empties.length ? ` (${view.empties.length} empty, skipped)` : "") +
        (guess.usd !== undefined ? `, est. ~${formatUsd(guess.usd)}` : "") +
        (client.thinking
          ? ""
          : `; no thinking setting known for ${client.model}, so its cost and time may vary`),
    );
    const first = await client.call(prompt, deps.abort);
    calls += first.attempts;
    if (!first.ok) {
      if (first.reason === "interrupted") interrupted = true;
      else {
        aborted = first.reason;
        fatal = first.fatal;
      }
      missing = [...view.pointers];
    } else {
      tokensIn += first.usage.in;
      tokensOut += first.usage.out + first.usage.thoughts;
      const parsed = parseResponse(first.text);
      summary = parsed.summary;
      own = parsed.own;
      named = parsed.named;
      unparsed += parsed.unparsed.length;
      const tally = collect(parsed.lines, view.pointers, judged);
      duplicates = tally.duplicates;
      unknown = tally.unknown;
      missing = tally.missing;

      if (missing.length > 0 && !deps.abort?.aborted) {
        const retry = await client.call(buildRepairPrompt(view, ask, missing), deps.abort);
        calls += retry.attempts;
        if (retry.ok) {
          tokensIn += retry.usage.in;
          tokensOut += retry.usage.out + retry.usage.thoughts;
          const again = parseResponse(retry.text);
          unparsed += again.unparsed.length;
          const before = missing;
          const second = collect(again.lines, before, judged);
          repaired = before.filter((p) => judged.has(p));
          missing = second.missing;
        } else if (retry.reason === "interrupted") {
          interrupted = true;
        }
      }
    }
  }

  let leadsFailed: string | undefined;
  let overviewModel = cfg.model;
  let chunkUsd: number | undefined = 0;
  if (why) {
    const client = deps.client();
    const overviewClient = deps.overviewClient?.() ?? client;
    overviewModel = overviewClient.model;
    deps.notice(
      `askq: ${view.pointers.length} items to ${client.model} in ${plan.length} windows of up to ${size}, ` +
        `overlapping by ${overlap}, with an overview (${overviewClient.model}) and a leads call` +
        (view.empties.length ? ` (${view.empties.length} empty, skipped)` : "") +
        (guess.usd !== undefined ? `, est. ~${formatUsd(guess.usd)}` : "") +
        (client.thinking
          ? ""
          : `; no thinking setting known for ${client.model}, so its cost and time may vary`),
    );
    chunk = await judgeInWindows({
      view,
      plan,
      prompts: windowPrompts,
      overviewPrompt,
      ask,
      client,
      overviewClient,
      maxInputTokens: MAX_INPUT_TOKENS,
      abort: deps.abort,
    });
    for (const [p, j] of chunk.judged) judged.set(p, j);
    calls += chunk.calls;
    tokensIn += chunk.tokens.in + chunk.overviewTokens.in;
    tokensOut += chunk.tokens.out + chunk.overviewTokens.out;
    const windowsUsd = costOf(chunk.tokens.in, chunk.tokens.out, cfg.model);
    const overviewUsd = costOf(
      chunk.overviewTokens.in,
      chunk.overviewTokens.out,
      overviewClient.model,
    );
    chunkUsd =
      windowsUsd === undefined || overviewUsd === undefined ? undefined : windowsUsd + overviewUsd;
    own = chunk.own;
    named = chunk.named;
    repaired = chunk.repaired;
    duplicates = [...new Set(chunk.duplicates)];
    unknown = chunk.unknown;
    unparsed = chunk.unparsed;
    aborted = chunk.aborted;
    fatal = chunk.fatal;
    interrupted = chunk.interrupted;
  }

  const namedBy = (account: string) => {
    const from = chunk?.ownFrom.get(account)?.from ?? ["overview"];
    return from.includes("overview") ? "the overview" : `the answer for ${from.join(" and ")}`;
  };
  const fragments = liftFragments(judged);
  const ownLifts = liftOwn(judged, view, own, chunk ? namedBy : undefined);
  const lifts = { fragments, own: ownLifts, pointers: liftPointers(judged, view) };

  if (chunk && !interrupted && !fatal) {
    const order = displayOrder(view);
    const leadsPrompt = buildLeadsPrompt(
      view,
      ask,
      order.filter((p) => judged.get(p)?.verdict === "read"),
      order.filter((p) => judged.get(p)?.verdict === "maybe"),
    );
    if (leadsPrompt) {
      const client = deps.client();
      const r = await client.call(leadsPrompt, deps.abort);
      calls += r.attempts;
      if (r.ok) {
        tokensIn += r.usage.in;
        tokensOut += r.usage.out + r.usage.thoughts;
        const leadsUsd = costOf(r.usage.in, r.usage.out + r.usage.thoughts, cfg.model);
        chunkUsd =
          chunkUsd === undefined || leadsUsd === undefined ? undefined : chunkUsd + leadsUsd;
        summary = parseLeads(r.text);
      } else if (r.reason === "interrupted") interrupted = true;
      else leadsFailed = r.reason;
    }
  }

  const terms = buildTerms(named, cfg.watch ?? []);
  const hits = matchTerms(terms, view, displayOrder(view));
  const termsOf = termsByPointer(hits);
  const repeats: Repeat[] = chunk
    ? chunk.windowJudged
        .flatMap((m, k) => repeatedReasons(m).map((r) => ({ ...r, window: k + 1 })))
        .sort((a, b) => b.pointers.length - a.pointers.length)
    : repeatedReasons(judged);

  const failureFor = (pointer: string) =>
    chunk?.reasons.get(pointer) ??
    (aborted
      ? `no verdict: ${aborted}`
      : interrupted
        ? "no verdict: interrupted"
        : "the model gave no verdict for this item, even when asked again");
  const coverage = new Coverage(lines.length);
  const outcomes = new Map<number, LineOutcome>();
  const settle = (line: number, outcome: LineOutcome) => {
    if (outcome.kind === "error") coverage.fail(line - 1, outcome.reason);
    else coverage.answer(line - 1, {});
    outcomes.set(line, outcome);
  };
  for (const [line, reason] of bad) settle(line, { kind: "error", entry: undefined, reason });
  for (const e of view.empties) settle(e.line, { kind: "empty", entry: e });
  for (const e of view.sent) {
    const j = judged.get(e.pointer);
    settle(
      e.line,
      j
        ? { kind: "judged", entry: e, judgement: j }
        : { kind: "error", entry: e, reason: failureFor(e.pointer) },
    );
  }
  const finish = coverage.finish();
  for (const index of finish.unresolved) {
    outcomes.set(index + 1, {
      kind: "error",
      entry: view.entries.get(index + 1),
      reason: "internal: askq lost this line",
    });
  }

  const errors = new Map<number, string>();
  for (const [line, o] of outcomes) if (o.kind === "error") errors.set(line, o.reason);
  const blockErrors = new Map<string, string>();
  for (const b of view.blocks)
    if (!judged.has(b.pointer)) blockErrors.set(b.pointer, failureFor(b.pointer));

  const ms = now() - started;
  const usd = chunk ? chunkUsd : costOf(tokensIn, tokensOut, cfg.model);
  const runRecord = {
    askq_run: {
      version: VERSION,
      question: ask.question,
      context: ask.context ?? null,
      model: cfg.model,
      roles: Object.fromEntries(Object.entries(roles).map(([k, v]) => [k, v.path])),
      lines: lines.length,
      calls,
      ms,
      tokens: { in: tokensIn, out: tokensOut },
      usd: usd ?? null,
      own,
      terms: terms.map((t) => ({
        term: t.term,
        from: t.from,
        forms: t.forms,
        matches: hits.get(t)!.length,
      })),
      summary,
      ...(chunk
        ? {
            windows: chunk.status,
            overview: {
              model: overviewModel,
              ok: chunk.overviewFailed === undefined,
              ...(chunk.overviewFailed ? { reason: chunk.overviewFailed } : {}),
              own: [...chunk.ownFrom.values()].map((o) => ({ account: o.handle, from: o.from })),
              named: chunk.named,
            },
          }
        : {}),
    },
  };
  const extra = (pointer: string): Record<string, unknown> => {
    if (!chunk) return {};
    const votes = chunk.votes.get(pointer) ?? [];
    return {
      askq_windows: chunk.windowsOf.get(pointer) ?? [],
      ...(votes.length > 1 ? { askq_votes: votes } : {}),
    };
  };
  const records = [
    JSON.stringify(runRecord),
    ...Array.from({ length: lines.length }, (_, i) =>
      JSON.stringify(lineRecord(i + 1, outcomes.get(i + 1)!, termsOf, extra)),
    ),
    ...view.blocks.map((b) =>
      JSON.stringify(
        blockRecord(
          view,
          b,
          judged.get(b.pointer),
          blockErrors.get(b.pointer),
          termsOf.get(b.pointer),
          extra,
        ),
      ),
    ),
  ];
  deps.recordsOut.write(records);

  for (const line of rollup({
    view,
    model: cfg.model,
    rolesLine,
    judged,
    errors,
    blockErrors,
    summary,
    own,
    calls,
    ms,
    tokensIn,
    tokensOut,
    usd,
    repaired,
    duplicates,
    unknown,
    unparsed,
    lifts,
    repeats,
    hits,
    textPath: roles.text?.path,
    file: deps.recordsOut.path,
    badLines: bad.size,
    interrupted,
    aborted,
    chunk: chunk && why ? chunkSummary(chunk, why, size, overlap, leadsFailed) : undefined,
  })) {
    deps.rollupOut(line);
  }

  if (interrupted) return 130;
  if (fatal) return 2;
  return errors.size > 0 || blockErrors.size > 0 ? 1 : 0;
}

export type ChunkWhy = "flag" | "items" | "tokens";

export const WINDOW_OUT_FIXED = 150;
export const OVERVIEW_OUT_FIXED = 100;
export const LEADS_SHARE = 0.5;
export const LEADS_FRAME_CHARS = 2_000;

function chunkEstimate(
  view: View,
  prompts: string[],
  plan: Window[],
  overviewPrompt: string,
  model: string,
): Estimate {
  const sentChars = view.sent.reduce((n, e) => n + e.rendered.length, 0);
  const leadsChars = Math.min(LEADS_MAX_CHARS, LEADS_SHARE * sentChars) + LEADS_FRAME_CHARS;
  const parts = [
    ...prompts.map((p, k) => estimate(p.length, plan[k]!.pointers.length, model, WINDOW_OUT_FIXED)),
    estimate(overviewPrompt.length, 0, OVERVIEW_MODEL, OVERVIEW_OUT_FIXED),
    estimate(leadsChars, 0, model),
  ];
  const usd = parts.every((p) => p.usd !== undefined)
    ? parts.reduce((n, p) => n + p.usd!, 0)
    : undefined;
  return {
    tokensIn: parts.reduce((n, p) => n + p.tokensIn, 0),
    tokensOut: parts.reduce((n, p) => n + p.tokensOut, 0),
    usd,
  };
}

function chunkSummary(
  chunk: ChunkResult,
  why: ChunkWhy,
  size: number,
  overlap: number,
  leadsFailed: string | undefined,
): ChunkInfo {
  const votes = [...chunk.votes.values()];
  return {
    why,
    windows: chunk.status.length,
    size,
    overlap,
    twice: votes.filter((v) => v.length > 1).length,
    disagreed: votes.filter((v) => new Set(v).size > 1).length,
    retried: chunk.status.filter((s) => s.retried).map((s) => s.window),
    failed: chunk.status.flatMap((s) =>
      !s.ok && s.reason !== undefined ? [{ window: s.window, reason: s.reason }] : [],
    ),
    overviewFailed: chunk.overviewFailed,
    leadsFailed,
    ownFrom: [...chunk.ownFrom.values()].map((o) => ({ handle: o.handle, from: o.from })),
  };
}
