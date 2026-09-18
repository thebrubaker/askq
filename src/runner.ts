import { type Cache, cacheKey } from "./cache";
import { Coverage, type Slot } from "./coverage";
import { costOf, estimate } from "./cost";
import { extract, parsePath } from "./field";
import type { Client } from "./gemini";
import { buildPrompt } from "./prompt";
import { RESERVED_KEYS, type Question, UsageError } from "./questions";
import { formatUsd, report, reportSample } from "./report";
import { reviewMarker } from "./review";
import { answerKeys, buildSchema, coerceAnswer, coerceWhy, whyKey } from "./schema";

export type Throttle = { capacity: number; reduce(): number };

export function createThrottle(initial: number, floor = 2): Throttle {
  return {
    capacity: Math.max(1, initial),
    reduce() {
      this.capacity = Math.max(Math.min(floor, this.capacity), Math.floor(this.capacity / 2));
      return this.capacity;
    },
  };
}

export type RunConfig = {
  questions: Question[];
  field: string;
  model: string;
  concurrency: number;
  why?: boolean | undefined;
  into?: string | undefined;
  id?: string | undefined;
  full?: boolean | undefined;
  sample?: number | undefined;
  cache?: Cache | undefined;
  maxCost?: number | undefined;
  yes?: boolean | undefined;
  throttle?: Throttle | undefined;
};

export type RunDeps = {
  client: Client;
  stdout: (line: string) => void | Promise<void>;
  stderr: (line: string) => void;
  now?: () => number;
  /** Aborting stops new items; the run still accounts for every input line before exiting. */
  abort?: AbortSignal | undefined;
};

export type RunResult = {
  exitCode: number;
  total: number;
  answered: number;
  failed: number;
  calls: number;
  tokensIn: number;
  tokensOut: number;
  cacheHits: number;
};

type Prepared =
  | { ok: true; item: Record<string, unknown>; text: string }
  | { ok: false; item?: Record<string, unknown>; reason: string };

export function splitLines(input: string): string[] {
  const lines = input.split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  return lines.map((l) => (l.endsWith("\r") ? l.slice(0, -1) : l));
}

function prepare(line: string, field: string, steps: ReturnType<typeof parsePath>): Prepared {
  if (line.trim().length === 0) return { ok: false, reason: "line is empty" };
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return { ok: false, reason: "line is not JSON" };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { ok: false, reason: "line is not a JSON object" };
  }
  const item = parsed as Record<string, unknown>;
  const got = extract(item, field, steps);
  if (!got.ok) return { ok: false, item, reason: got.reason };
  return { ok: true, item, text: got.text };
}

/**
 * Only --full puts askq's keys next to the caller's, so only --full can collide. The default
 * record carries pointers and answers and nothing of the input.
 */
function checkCollisions(prepared: Prepared[], cfg: RunConfig): void {
  if (cfg.full !== true) return;
  const written = cfg.into ? [cfg.into] : answerKeys(cfg.questions, cfg.why === true);
  const guarded = [...written, ...RESERVED_KEYS];
  for (let i = 0; i < prepared.length; i++) {
    const item = prepared[i]?.item;
    if (!item) continue;
    for (const key of guarded) {
      if (Object.prototype.hasOwnProperty.call(item, key)) {
        throw new UsageError(
          `line ${i + 1} already has a '${key}' key; askq will not overwrite input data ` +
            `(rename the question, or use --into to nest the answers)`,
        );
      }
    }
  }
}

export async function run(input: string, cfg: RunConfig, deps: RunDeps): Promise<RunResult> {
  const now = deps.now ?? (() => Date.now());
  const started = now();
  const why = cfg.why === true;
  const allLines = splitLines(input);
  const lines = cfg.sample === undefined ? allLines : allLines.slice(0, cfg.sample);
  const steps = parsePath(cfg.field);
  const schema = buildSchema(cfg.questions, why);

  const prepared = lines.map((line) => prepare(line, cfg.field, steps));
  checkCollisions(prepared, cfg);

  const coverage = new Coverage(lines.length);
  let calls = 0;
  let tokensIn = 0;
  let tokensOut = 0;
  let cacheHits = 0;
  let cacheMisses = 0;
  let fatal: string | undefined;
  const throttle = cfg.throttle ?? createThrottle(cfg.concurrency);

  const prompts: (string | undefined)[] = new Array(prepared.length).fill(undefined);
  const keys: (string | undefined)[] = new Array(prepared.length).fill(undefined);
  const ids: (string | undefined)[] = new Array(prepared.length).fill(undefined);

  const idPath = cfg.id;
  const idSteps = idPath === undefined ? undefined : parsePath(idPath);
  let missingIds = 0;

  for (let i = 0; i < prepared.length; i++) {
    const p = prepared[i];
    if (!p) continue;
    if (idSteps !== undefined && idPath !== undefined && p.item) {
      const got = extract(p.item, idPath, idSteps);
      if (got.ok) ids[i] = got.text;
      else missingIds++;
    }
    if (!p.ok) {
      coverage.fail(i, p.reason);
      continue;
    }
    prompts[i] = buildPrompt(p.text, cfg.questions, why);

    if (!cfg.cache) {
      cacheMisses++;
      continue;
    }
    const key = cacheKey({ model: cfg.model, questions: cfg.questions, why, text: p.text });
    keys[i] = key;
    const hit = cfg.cache.get(key);
    if (hit) {
      coverage.answer(i, hit.answers);
      cacheHits++;
    } else {
      cacheMisses++;
    }
  }

  if (missingIds > 0 && idPath !== undefined) {
    deps.stderr(
      `askq: warning: --id ${idPath} is missing on ${missingIds} item${missingIds === 1 ? "" : "s"}; ` +
        `those records carry askq_id: null`,
    );
  }

  const todo: number[] = [];
  for (let i = 0; i < prepared.length; i++) {
    if (prepared[i]?.ok && !coverage.isSettled(i)) todo.push(i);
  }

  const guess = estimate(
    todo.map((i) => prompts[i]?.length ?? 0),
    cfg.questions,
    why,
    cfg.model,
  );

  if (cfg.maxCost !== undefined && cfg.yes !== true && guess.usd !== undefined) {
    if (guess.usd > cfg.maxCost) {
      deps.stderr(
        `askq: estimated ~${formatUsd(guess.usd)} for ${todo.length} items (${cfg.model}, ` +
          `~${guess.tokensIn.toLocaleString("en-US")} in + ` +
          `${guess.tokensOut.toLocaleString("en-US")} out tokens)`,
      );
      deps.stderr(
        `askq: over --max-cost ${cfg.maxCost.toFixed(2)}. Nothing was sent. Re-run with --yes, ` +
          `raise --max-cost, or try --sample 20 first.`,
      );
      return {
        exitCode: 3,
        total: lines.length,
        answered: 0,
        failed: 0,
        calls: 0,
        tokensIn: 0,
        tokensOut: 0,
        cacheHits,
      };
    }
  }

  let emitCursor = 0;
  const emit = async (): Promise<void> => {
    while (emitCursor < coverage.total && coverage.isSettled(emitCursor)) {
      const index = emitCursor;
      emitCursor++;
      const slot = coverage.get(index);
      // A pointer, not the item: an agent that forgets `> out.jsonl` must not get the whole
      // corpus poured back into its context. --full restores the item.
      const head = {
        askq_line: index + 1,
        ...(idPath === undefined ? {} : { askq_id: ids[index] ?? null }),
        ...(cfg.full === true ? prepared[index]?.item : {}),
      };
      if (slot.state === "answered") {
        const marker = reviewMarker(cfg.questions, slot.answers);
        const record = {
          ...head,
          ...(cfg.into ? { [cfg.into]: slot.answers } : slot.answers),
          ...(marker ? { askq_review: marker } : {}),
        };
        await deps.stdout(JSON.stringify(record));
      } else if (slot.state === "failed") {
        await deps.stdout(JSON.stringify({ ...head, askq_error: slot.reason }));
      }
    }
  };

  const handle = async (index: number): Promise<void> => {
    const prompt = prompts[index];
    if (prompt === undefined) return;
    const result = await deps.client.call(prompt, schema);
    calls += result.attempts;
    if (!result.ok) {
      if (result.kind === "fatal") {
        fatal ??= result.reason;
        return;
      }
      coverage.fail(index, result.reason);
      return;
    }
    tokensIn += result.usage.in;
    tokensOut += result.usage.out;

    const answers: Record<string, unknown> = {};
    for (const q of cfg.questions) {
      const coerced = coerceAnswer(q, result.answers[q.name]);
      if (!coerced.ok) {
        coverage.fail(index, coerced.reason);
        return;
      }
      answers[q.name] = coerced.value;
      if (why) {
        const reason = coerceWhy(q, result.answers[whyKey(q)]);
        if (!reason.ok) {
          coverage.fail(index, reason.reason);
          return;
        }
        answers[whyKey(q)] = reason.value;
      }
    }

    coverage.answer(index, answers);
    const key = keys[index];
    if (cfg.cache && key) cfg.cache.put(key, { answers, usage: result.usage });
  };

  let cursor = 0;
  let live = 0;
  const worker = async (): Promise<void> => {
    live++;
    try {
      while (true) {
        if (fatal || deps.abort?.aborted) break;
        if (live > throttle.capacity && live > 1) break;
        const next = todo[cursor++];
        if (next === undefined) break;
        try {
          await handle(next);
        } catch (e) {
          coverage.fail(next, `internal: ${(e as Error).message}`);
        }
        await emit();
      }
    } finally {
      live--;
    }
  };

  const workers = Math.min(Math.max(1, cfg.concurrency), Math.max(1, todo.length));
  await Promise.all(Array.from({ length: workers }, () => worker()));
  await emit();

  const interrupted = deps.abort?.aborted === true;
  const finish = coverage.finish(
    fatal
      ? `aborted before this item was answered: ${fatal}`
      : interrupted
        ? "interrupted before this item was answered"
        : undefined,
  );
  await emit();

  const slots: Slot[] = Array.from({ length: coverage.total }, (_, i) => coverage.get(i));

  if (fatal) {
    deps.stderr(`askq: aborted: ${fatal}`);
    deps.stderr(
      `askq: this fails the same way for every item, so the run stopped after ` +
        `${finish.answered} of ${finish.total} items`,
    );
    deps.stderr(
      `askq: the output still has one line per item; the unanswered ones carry askq_error`,
    );
    return {
      exitCode: 2,
      total: finish.total,
      answered: finish.answered,
      failed: finish.failed,
      calls,
      tokensIn,
      tokensOut,
      cacheHits,
    };
  }

  if (cfg.sample !== undefined) {
    reportSample(
      {
        questions: cfg.questions,
        why,
        slots,
        texts: prepared.map((p) => (p.ok ? p.text : undefined)),
        taken: lines.length,
        total: allLines.length,
        prompt: prompts.find((p) => p !== undefined),
      },
      deps.stderr,
    );
  }

  if (interrupted) {
    deps.stderr(`askq: interrupted — every item is still accounted for below`);
  }

  report({
    questions: cfg.questions,
    slots,
    texts: prepared.map((p) => (p.ok ? p.text : undefined)),
    finish,
    sample: cfg.sample !== undefined,
    hasId: idPath !== undefined,
    full: cfg.full === true,
    calls,
    tokensIn,
    tokensOut,
    elapsedMs: now() - started,
    cache: cfg.cache ? { hit: cacheHits, miss: cacheMisses } : undefined,
    costUsd: costOf(tokensIn, tokensOut, cfg.model),
    interrupted,
    stderr: deps.stderr,
  });

  return {
    exitCode: interrupted ? 130 : finish.failed > 0 ? 1 : 0,
    total: finish.total,
    answered: finish.answered,
    failed: finish.failed,
    calls,
    tokensIn,
    tokensOut,
    cacheHits,
  };
}
