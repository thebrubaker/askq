import {
  collect,
  liftFragments,
  liftOwn,
  repeatedReasons,
  type Judgement,
  type Repeat,
} from "./checks";
import { costOf, estimate, formatUsd } from "./cost";
import { Coverage } from "./coverage";
import { UsageError } from "./errors";
import type { Client } from "./gemini";
import { parseLine, splitLines } from "./lines";
import { parseResponse, type Claim } from "./parse";
import { buildPrompt, buildRepairPrompt, type Ask } from "./prompt";
import { blockRecord, lineRecord, type LineOutcome } from "./records";
import { buildView } from "./render";
import { describeRoles, resolveRoles, type Role } from "./roles";
import { rollup } from "./rollup";

export const VERSION = "0.2.0-dev";
export const MAX_ITEMS = 800;
export const MAX_INPUT_TOKENS = 400_000;

export type RunConfig = {
  ask: Ask;
  flags: Partial<Record<Role, string>>;
  autodetect: boolean;
  model: string;
  maxCost: number | undefined;
  yes: boolean;
  printPrompt: boolean;
  maxItems?: number;
};

export type Sink = (line: string) => void;

export type RunDeps = {
  client: () => Client;
  rollupOut: Sink;
  recordsOut: { path: string; write: (lines: string[]) => void };
  notice: Sink;
  now?: () => number;
  abort?: AbortSignal | undefined;
};

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

  if (cfg.printPrompt) {
    deps.rollupOut(prompt || "(nothing to send: every item is empty)");
    return 0;
  }

  const cap = cfg.maxItems ?? MAX_ITEMS;
  if (view.pointers.length > cap) {
    deps.notice(
      `askq: ${view.pointers.length} items to judge (${view.sent.length} posts + ${view.blocks.length} referenced) is over the ` +
        `${cap} one call can safely handle, and splitting into several calls is not built yet. Nothing was sent. ` +
        `Filter or split the input first (for example with jq, by date or by query).`,
    );
    return 2;
  }

  const guess = estimate(prompt.length, view.pointers.length, cfg.model);
  if (guess.tokensIn > MAX_INPUT_TOKENS) {
    deps.notice(
      `askq: the rendered dataset is ~${guess.tokensIn.toLocaleString("en-US")} tokens, over the ${MAX_INPUT_TOKENS.toLocaleString("en-US")} ` +
        `one call takes. Nothing was sent. Send less of each item (--text) or split the input.`,
    );
    return 2;
  }
  if (cfg.maxCost !== undefined && !cfg.yes && guess.usd !== undefined && guess.usd > cfg.maxCost) {
    deps.notice(
      `askq: estimated ~${formatUsd(guess.usd)} for ${view.pointers.length} items (${cfg.model}, ` +
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
  let repaired: string[] = [];
  let duplicates: string[] = [];
  let unknown: string[] = [];
  let unparsed = 0;
  let missing: string[] = [];

  if (view.pointers.length > 0) {
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

  const lifts = { fragments: liftFragments(judged), own: liftOwn(judged, view, own) };
  const repeats: Repeat[] = repeatedReasons(judged);

  const failure = aborted
    ? `no verdict: ${aborted}`
    : interrupted
      ? "no verdict: interrupted"
      : "the model gave no verdict for this item, even when asked again";
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
      j ? { kind: "judged", entry: e, judgement: j } : { kind: "error", entry: e, reason: failure },
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
  for (const b of view.blocks) if (!judged.has(b.pointer)) blockErrors.set(b.pointer, failure);

  const ms = now() - started;
  const usd = costOf(tokensIn, tokensOut, cfg.model);
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
      summary,
    },
  };
  const records = [
    JSON.stringify(runRecord),
    ...Array.from({ length: lines.length }, (_, i) =>
      JSON.stringify(lineRecord(i + 1, outcomes.get(i + 1)!)),
    ),
    ...view.blocks.map((b) =>
      JSON.stringify(blockRecord(view, b, judged.get(b.pointer), blockErrors.get(b.pointer))),
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
    file: deps.recordsOut.path,
    badLines: bad.size,
    interrupted,
    aborted,
  })) {
    deps.rollupOut(line);
  }

  if (interrupted) return 130;
  if (fatal) return 2;
  return errors.size > 0 || blockErrors.size > 0 ? 1 : 0;
}
