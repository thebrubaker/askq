import type { FinishReport, Slot } from "./coverage";
import type { Question } from "./questions";
import { hasBand, reviewReasons } from "./review";
import { borderlineIndices, scoreQuestion, snippet, spotCheck, topByScore } from "./triage";

/** First proposals, set against real runs in stage 3 rather than derived from anything. */
export const MIN_ITEMS_FOR_WARNING = 20;
export const ONE_CLASS_SHARE = 0.98;
export const MIN_DISTINCT_SCORES = 3;
export const BAND_TOO_WIDE = 1 / 3;
export const LIST_CAP = 20;
export const TOP_LIMIT = 10;
export const TOP_SHOWN = 5;
export const SPOT_CHECK_LIMIT = 5;
export const SNIPPET_WIDTH = 72;

export type ReportInput = {
  questions: Question[];
  slots: readonly Slot[];
  texts?: readonly (string | undefined)[] | undefined;
  finish: FinishReport;
  calls: number;
  tokensIn: number;
  tokensOut: number;
  elapsedMs: number;
  cache?: { hit: number; miss: number } | undefined;
  costUsd?: number | undefined;
  /** An interrupted run leaves items unresolved on purpose; that is not a bug to report. */
  interrupted?: boolean | undefined;
  /** A sample has nothing to triage: it prints its items in full already. */
  sample?: boolean | undefined;
  hasId?: boolean | undefined;
  full?: boolean | undefined;
  stderr: (line: string) => void;
};

const pct = (n: number, of: number): string => (of === 0 ? "0.0" : ((100 * n) / of).toFixed(1));

export function formatUsd(usd: number): string {
  if (usd === 0) return "$0";
  if (usd < 0.01) return `$${usd.toFixed(4)}`;
  return `$${usd.toFixed(2)}`;
}

function answeredAnswers(slots: readonly Slot[]): Record<string, unknown>[] {
  return slots.filter((s) => s.state === "answered").map((s) => s.answers);
}

function distributionLine(q: Question, answers: Record<string, unknown>[], total: number): string {
  if (q.kind === "score") {
    const values = answers.map((a) => a[q.name]).filter((v): v is number => typeof v === "number");
    const bucket = (lo: number, hi: number) =>
      values.filter((v) => v >= lo && v <= hi).length.toString();
    const mean = values.length === 0 ? 0 : values.reduce((a, b) => a + b, 0) / values.length;
    return (
      `0-3 ${bucket(0, 3)}  4-6 ${bucket(4, 6)}  7-10 ${bucket(7, 10)}   ` +
      `mean ${mean.toFixed(1)}  distinct ${new Set(values).size}`
    );
  }
  const classes = q.kind === "bool" ? ["true", "false"] : q.values;
  return classes
    .map((c) => {
      const n = answers.filter((a) => String(a[q.name]) === c).length;
      return `${c} ${n} (${pct(n, total)}%)`;
    })
    .join("  ");
}

function oneClassWarning(q: Question, answers: Record<string, unknown>[]): string | undefined {
  if (answers.length < MIN_ITEMS_FOR_WARNING) return undefined;

  if (q.kind === "score") {
    const values = answers.map((a) => a[q.name]).filter((v): v is number => typeof v === "number");
    const distinct = new Set(values).size;
    if (distinct >= MIN_DISTINCT_SCORES) return undefined;
    return (
      `\`${q.name}\` used only ${distinct} distinct value${distinct === 1 ? "" : "s"} across ` +
      `${values.length} answered items — an unanchored scale looks exactly like this`
    );
  }

  const classes = q.kind === "bool" ? ["true", "false"] : q.values;
  for (const c of classes) {
    const n = answers.filter((a) => String(a[q.name]) === c).length;
    if (n / answers.length < ONE_CLASS_SHARE) continue;
    const where =
      n === answers.length
        ? "for every item"
        : `for ${n} of ${answers.length} answered items (${pct(n, answers.length)}%)`;
    return `\`${q.name}\` answered "${c}" ${where} — a broken question looks exactly like this`;
  }
  return undefined;
}

function reportReviewBand(input: ReportInput, answeredCount: number): void {
  const { questions, slots, stderr } = input;

  if (!hasBand(questions)) {
    if (answeredCount >= MIN_ITEMS_FOR_WARNING) {
      stderr("askq: no review band — declare a --score question to get one (see --help)");
    }
    return;
  }

  const lines: number[] = [];
  const labels = new Map<string, number>();
  for (let i = 0; i < slots.length; i++) {
    const slot = slots[i];
    if (slot?.state !== "answered") continue;
    const reasons = reviewReasons(questions, slot.answers);
    if (reasons.length === 0) continue;
    lines.push(i + 1);
    for (const r of reasons) labels.set(r.label, (labels.get(r.label) ?? 0) + 1);
  }

  if (lines.length === 0) {
    stderr(`askq: borderline — none of the ${answeredCount} answered items landed in between`);
    return;
  }

  const shown = lines.slice(0, LIST_CAP).join(" ");
  const more = lines.length > LIST_CAP ? ` … and ${lines.length - LIST_CAP} more` : "";
  stderr(
    `askq: borderline — ${lines.length} of ${answeredCount} worth reading yourself ` +
      `(${pct(lines.length, answeredCount)}%): lines ${shown}${more}`,
  );
  stderr(`askq:   ${[...labels].map(([label, n]) => `${n} ${label}`).join(", ")}`);
  stderr("askq:   jq -c 'select(.askq_review)' <output file>");

  // A band this wide is not a triage aid, and it says the same thing the one-class warning
  // says from the other end: the question is not separating these items.
  if (answeredCount >= MIN_ITEMS_FOR_WARNING && lines.length / answeredCount >= BAND_TOO_WIDE) {
    stderr(
      `askq: warning: ${pct(lines.length, answeredCount)}% of answered items are in the review ` +
        `band — too many to read. A sharper question usually narrows it`,
    );
  }
}

function row(index: number, score: unknown, text: string | undefined): string {
  const scoreCell = typeof score === "number" ? String(score).padStart(2) : "  ";
  return `askq:   [${String(index + 1).padStart(2)}] ${scoreCell}  ${snippet(text, SNIPPET_WIDTH)}`;
}

function reportTop(input: ReportInput): void {
  const { questions, slots, stderr } = input;
  const q = scoreQuestion(questions);
  if (!q) return;
  const top = topByScore(questions, slots, TOP_LIMIT);
  if (top.length === 0) return;

  stderr(`askq: read from the top — highest ${q.name} first:`);
  for (const i of top.slice(0, TOP_SHOWN)) {
    const slot = slots[i];
    stderr(row(i, slot?.state === "answered" ? slot.answers[q.name] : undefined, input.texts?.[i]));
  }
  const rest = top.slice(TOP_SHOWN);
  if (rest.length > 0) {
    stderr(`askq:   … ${rest.length} more, lines ${rest.map((i) => i + 1).join(" ")}`);
  }
  stderr(
    `askq:   read on: jq -sc 'map(select(.${q.name}!=null))|sort_by(-.${q.name})|.[${TOP_LIMIT}:][]'` +
      " <output file>",
  );
}

function reportSpotCheck(input: ReportInput): void {
  const { questions, slots, stderr } = input;
  if (input.finish.answered <= TOP_LIMIT) return;

  const exclude = new Set([
    ...topByScore(questions, slots, TOP_LIMIT),
    ...borderlineIndices(questions, slots),
  ]);
  const check = spotCheck(questions, slots, input.texts ?? [], SPOT_CHECK_LIMIT, exclude);

  if (check.kind === "empty") {
    stderr(`askq: spot-check — ${check.label}`);
    return;
  }

  const q = scoreQuestion(questions);
  stderr(`askq: spot-check — ${check.label}:`);
  for (const i of check.indices) {
    const slot = slots[i];
    const score = q && slot?.state === "answered" ? slot.answers[q.name] : undefined;
    stderr(row(i, score, input.texts?.[i]));
  }
  stderr("askq:   if any of those is what you were looking for, the question is wrong — reword it");
  stderr("askq:   and re-run. askq decides what you read first, not what you skip.");
}

export function report(input: ReportInput): void {
  const { finish, questions, slots, stderr } = input;
  const answers = answeredAnswers(slots);
  const elapsed = (input.elapsedMs / 1000).toFixed(1);
  const tokens =
    `${input.tokensIn.toLocaleString("en-US")} in + ` +
    `${input.tokensOut.toLocaleString("en-US")} out tokens`;
  const cost = input.costUsd === undefined ? "" : ` · ~${formatUsd(input.costUsd)}`;

  stderr(
    `askq: ${finish.total} items · ${finish.answered} answered · ${finish.failed} failed · ` +
      `${elapsed}s · ${input.calls} calls · ${tokens}${cost}`,
  );

  if (input.cache) {
    stderr(`askq: cache ${input.cache.hit} hit / ${input.cache.miss} miss`);
  }

  const width = Math.max(...questions.map((q) => q.name.length));
  for (const q of questions) {
    const failedNote = finish.failed > 0 ? `  —failed ${finish.failed}` : "";
    stderr(`  ${q.name.padEnd(width)}  ${distributionLine(q, answers, finish.total)}${failedNote}`);
  }

  if (input.full !== true && input.hasId !== true && finish.answered > 0) {
    stderr(
      "askq: records carry askq_line only — pass --id <path> for a pointer to join on, " +
        "or --full for the items",
    );
  }

  if (input.sample !== true) reportTop(input);
  reportReviewBand(input, finish.answered);
  if (input.sample !== true) reportSpotCheck(input);

  for (const q of questions) {
    const warning = oneClassWarning(q, answers);
    if (warning) stderr(`askq: warning: ${warning}`);
  }

  if (finish.unresolved.length > 0 && input.interrupted !== true) {
    const shown = finish.unresolved
      .slice(0, LIST_CAP)
      .map((i) => i + 1)
      .join(" ");
    const more =
      finish.unresolved.length > LIST_CAP
        ? ` … and ${finish.unresolved.length - LIST_CAP} more`
        : "";
    stderr(
      `askq: internal: ${finish.unresolved.length} items never resolved: lines ${shown}${more}`,
    );
  }

  if (finish.failed > 0) {
    stderr(`askq: ${finish.failed} item${finish.failed === 1 ? "" : "s"} failed:`);
    let shown = 0;
    for (let i = 0; i < slots.length; i++) {
      const slot = slots[i];
      if (slot?.state !== "failed") continue;
      if (shown === LIST_CAP) {
        stderr(`askq:   … and ${finish.failed - shown} more (see askq_error in the output)`);
        break;
      }
      stderr(`askq:   line ${i + 1} — ${slot.reason}`);
      shown++;
    }
    stderr(`askq: coverage incomplete: ${finish.answered}/${finish.total} answered`);
  } else {
    stderr(`askq: coverage complete: ${finish.answered}/${finish.total} answered`);
  }
}

export function reportSample(
  input: {
    questions: Question[];
    why: boolean;
    slots: readonly Slot[];
    texts: (string | undefined)[];
    taken: number;
    total: number;
    prompt: string | undefined;
  },
  stderr: (line: string) => void,
): void {
  stderr(`askq: sample of ${input.taken} of ${input.total} items — nothing else was sent`);
  if (input.prompt !== undefined) {
    stderr("");
    stderr("--- the prompt sent for the first sampled item ---");
    for (const line of input.prompt.split("\n")) stderr(line);
    stderr("--- end of prompt ---");
  }
  stderr("");
  for (let i = 0; i < input.slots.length; i++) {
    const slot = input.slots[i];
    if (!slot) continue;
    const answers =
      slot.state === "answered"
        ? input.questions.map((q) => `${q.name}=${String(slot.answers[q.name])}`).join("  ")
        : slot.state === "failed"
          ? `FAILED: ${slot.reason}`
          : "pending";
    stderr(`  [${i + 1}] ${answers}`);
    const text = input.texts[i];
    if (text !== undefined) {
      stderr(`       ${text.replace(/\s+/g, " ").slice(0, 120)}`);
    }
    if (slot.state === "answered" && input.why) {
      for (const q of input.questions) {
        const why = slot.answers[`${q.name}_why`];
        if (typeof why === "string") stderr(`       ${q.name}: ${why}`);
      }
    }
  }
  stderr("");
}
