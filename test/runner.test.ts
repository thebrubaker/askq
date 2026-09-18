import { describe, expect, test } from "bun:test";
import type { Client } from "../src/gemini";
import { UsageError } from "../src/questions";
import { run, type RunConfig } from "../src/runner";
import {
  capture,
  clientFrom,
  fatal,
  itemFailure,
  jsonl,
  memoryCache,
  ok,
  syntheticItems,
} from "./helpers";

const questions: RunConfig["questions"] = [
  { kind: "bool", name: "substantive", text: "Does it report a measurement?" },
  { kind: "score", name: "substantive_score", text: "0 = none, 10 = a hard number." },
];

const cfg = (over: Partial<RunConfig> = {}): RunConfig => ({
  questions,
  field: ".txt",
  model: "test-model",
  concurrency: 4,
  ...over,
});

const goodAnswer = () => ok({ substantive: "true", substantive_score: "8" });

/** Which input line a fake client is looking at, read back out of the prompt text. */
function lineOf(prompt: string): number {
  const m = /synthetic item (\d+)/.exec(prompt);
  return m?.[1] ? Number(m[1]) : -1;
}

describe("runner: the happy path is a real control", () => {
  test("every item answered: N lines out, exit 0, coverage complete", async () => {
    const input = jsonl(syntheticItems(12));
    const c = capture(clientFrom(() => goodAnswer()));

    const result = await run(input, cfg(), c.deps);

    expect(result.exitCode).toBe(0);
    expect(c.out).toHaveLength(12);
    expect(result.answered).toBe(12);
    expect(result.failed).toBe(0);
    expect(c.err.some((l) => l.includes("coverage complete: 12/12"))).toBe(true);
    expect(c.err.some((l) => l.includes("failed:"))).toBe(false);

    const first = JSON.parse(c.out[0] as string);
    expect(first).toEqual({ askq_line: 1, substantive: true, substantive_score: 8 });
  });

  test("output holds input order even when answers complete out of order", async () => {
    const input = jsonl(syntheticItems(8));
    const client: Client = {
      call: async (prompt) => {
        const line = lineOf(prompt);
        await new Promise((r) => setTimeout(r, (9 - line) * 3));
        return ok({ substantive: "true", substantive_score: String(line % 11) });
      },
    };
    const c = capture(client);

    const result = await run(input, cfg({ concurrency: 8 }), c.deps);

    expect(result.exitCode).toBe(0);
    expect(c.out.map((l) => JSON.parse(l).askq_line)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  });
});

describe("runner: the output record is a pointer, not the item", () => {
  test("line N carries askq_line N — the coverage invariant, checkable per record", async () => {
    const input = jsonl(syntheticItems(25));
    const c = capture(clientFrom(() => goodAnswer()));

    await run(input, cfg(), c.deps);

    expect(c.out).toHaveLength(25);
    c.out.forEach((line, i) => {
      expect(JSON.parse(line).askq_line).toBe(i + 1);
    });
  });

  test("the item is not in the record, so a forgotten redirect cannot flood a context", async () => {
    const input = jsonl([{ id: 1, txt: "synthetic item 1", huge: "x".repeat(5000) }]);
    const c = capture(clientFrom(() => goodAnswer()));

    await run(input, cfg(), c.deps);

    expect(c.out[0]).not.toContain("xxxx");
    expect((c.out[0] as string).length).toBeLessThan(120);
  });

  test("--id adds askq_id under a fixed key whatever the path", async () => {
    const input = jsonl([{ txt: "synthetic item 1", user: { name: "ada" } }]);
    const c = capture(clientFrom(() => goodAnswer()));

    await run(input, cfg({ id: ".user.name" }), c.deps);

    expect(JSON.parse(c.out[0] as string)).toEqual({
      askq_line: 1,
      askq_id: "ada",
      substantive: true,
      substantive_score: 8,
    });
  });

  test("an item missing the --id path gets askq_id null and one warning, not a failure", async () => {
    const input = jsonl([{ txt: "synthetic item 1", u: "one" }, { txt: "synthetic item 2" }]);
    const c = capture(clientFrom(() => goodAnswer()));

    const result = await run(input, cfg({ id: ".u" }), c.deps);

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(c.out[1] as string).askq_id).toBeNull();
    expect(c.err.filter((l) => l.includes("--id .u is missing"))).toHaveLength(1);
  });

  test("a failed item has the same shape as an answered one", async () => {
    const input = jsonl([{ txt: "synthetic item 1", u: "one" }, { u: "two" }]);
    const c = capture(clientFrom(() => goodAnswer()));

    await run(input, cfg({ id: ".u" }), c.deps);

    expect(JSON.parse(c.out[1] as string)).toEqual({
      askq_line: 2,
      askq_id: "two",
      askq_error: "field .txt missing",
    });
  });

  test("--full restores the item, with askq_line still leading", async () => {
    const input = jsonl(syntheticItems(1));
    const c = capture(clientFrom(() => goodAnswer()));

    await run(input, cfg({ full: true }), c.deps);

    expect(JSON.parse(c.out[0] as string)).toEqual({
      askq_line: 1,
      id: 1,
      txt: "synthetic item 1: shipped a 1% improvement in build time",
      substantive: true,
      substantive_score: 8,
    });
  });
});

describe("runner: fault injection — a skipped item cannot pass as success", () => {
  test("a permanently failing item still emits a line, is named, and exits 1", async () => {
    const input = jsonl(syntheticItems(10));
    const c = capture(
      clientFrom((prompt) =>
        lineOf(prompt) === 3 ? itemFailure("http 503 after 4 attempts") : goodAnswer(),
      ),
    );

    const result = await run(input, cfg(), c.deps);

    expect(result.exitCode).toBe(1);
    expect(c.out).toHaveLength(10);
    const line3 = JSON.parse(c.out[2] as string);
    expect(line3.askq_error).toBe("http 503 after 4 attempts");
    expect(line3.substantive).toBeUndefined();
    expect(c.err.some((l) => l.includes("line 3 — http 503 after 4 attempts"))).toBe(true);
    expect(c.err.some((l) => l.includes("coverage incomplete: 9/10"))).toBe(true);
  });

  test("a transport that throws is a named failure, not a crash", async () => {
    const input = jsonl(syntheticItems(10));
    const c = capture(
      clientFrom((prompt) => {
        if (lineOf(prompt) === 5) {
          const error = new Error("fetch failed");
          (error as Error & { cause?: unknown }).cause = { code: "ECONNRESET" };
          throw error;
        }
        return goodAnswer();
      }),
    );

    const result = await run(input, cfg(), c.deps);

    expect(result.exitCode).toBe(1);
    expect(c.out).toHaveLength(10);
    expect(JSON.parse(c.out[4] as string).askq_error).toContain("fetch failed");
    expect(c.err.some((l) => l.includes("line 5 —"))).toBe(true);
  });

  test("a dropped result (pool bug) is caught and named, never exit 0", async () => {
    const input = jsonl(syntheticItems(10));
    const c = capture(clientFrom((prompt) => (lineOf(prompt) === 9 ? undefined : goodAnswer())));

    const result = await run(input, cfg(), c.deps);

    expect(result.exitCode).toBe(1);
    expect(c.out).toHaveLength(10);
    expect(JSON.parse(c.out[8] as string).askq_error).toContain("internal:");
    expect(c.err.some((l) => l.includes("line 9 —"))).toBe(true);
  });

  test("an answer outside the declared values fails the item rather than passing it through", async () => {
    const input = jsonl(syntheticItems(3));
    const c = capture(
      clientFrom((prompt) =>
        lineOf(prompt) === 2
          ? ok({ substantive: "probably", substantive_score: "8" })
          : goodAnswer(),
      ),
    );

    const result = await run(input, cfg(), c.deps);

    expect(result.exitCode).toBe(1);
    expect(c.out).toHaveLength(3);
    expect(JSON.parse(c.out[1] as string).askq_error).toContain("not an allowed value");
  });

  test("a missing answer key fails the item", async () => {
    const input = jsonl(syntheticItems(2));
    const c = capture(clientFrom(() => ok({ substantive: "true" })));

    const result = await run(input, cfg(), c.deps);

    expect(result.exitCode).toBe(1);
    expect(c.out).toHaveLength(2);
    expect(JSON.parse(c.out[0] as string).askq_error).toContain("substantive_score missing");
  });
});

describe("runner: input that cannot be answered is a coverage event, not a skip", () => {
  test("a line that is not JSON still produces a line", async () => {
    const input = `${JSON.stringify({ id: 1, txt: "synthetic item 1: fine" })}\nnot json at all\n`;
    const c = capture(clientFrom(() => goodAnswer()));

    const result = await run(input, cfg(), c.deps);

    expect(result.exitCode).toBe(1);
    expect(c.out).toHaveLength(2);
    expect(JSON.parse(c.out[1] as string)).toEqual({
      askq_line: 2,
      askq_error: "line is not JSON",
    });
  });

  test("a missing field is named and costs no model call", async () => {
    const input = jsonl([
      { id: 1, txt: "synthetic item 1: fine" },
      { id: 2, other: "no txt here" },
    ]);
    let calls = 0;
    const c = capture(
      clientFrom(() => {
        calls++;
        return goodAnswer();
      }),
    );

    const result = await run(input, cfg(), c.deps);

    expect(result.exitCode).toBe(1);
    expect(calls).toBe(1);
    expect(c.out).toHaveLength(2);
    expect(JSON.parse(c.out[1] as string).askq_error).toBe("field .txt missing");
  });

  test("an empty field is named rather than answered about nothing", async () => {
    const input = jsonl([{ id: 1, txt: "   " }]);
    const c = capture(clientFrom(() => goodAnswer()));

    const result = await run(input, cfg(), c.deps);

    expect(result.exitCode).toBe(1);
    expect(JSON.parse(c.out[0] as string).askq_error).toBe("field .txt empty");
  });
});

describe("runner: collisions can only happen under --full", () => {
  test("--into nests the answers under --full", async () => {
    const input = jsonl(syntheticItems(2));
    const c = capture(clientFrom(() => goodAnswer()));

    await run(input, cfg({ into: "answers", full: true }), c.deps);

    expect(JSON.parse(c.out[0] as string)).toEqual({
      askq_line: 1,
      id: 1,
      txt: "synthetic item 1: shipped a 1% improvement in build time",
      answers: { substantive: true, substantive_score: 8 },
    });
  });

  test("a colliding input key is a usage error under --full", async () => {
    const input = jsonl([{ id: 1, txt: "synthetic item 1", substantive: "already here" }]);
    const c = capture(clientFrom(() => goodAnswer()));

    expect(run(input, cfg({ full: true }), c.deps)).rejects.toThrow(UsageError);
  });

  test("the same input is fine by default, the item not being in the record", async () => {
    const input = jsonl([{ id: 1, txt: "synthetic item 1", substantive: "already here" }]);
    const c = capture(clientFrom(() => goodAnswer()));

    const result = await run(input, cfg(), c.deps);

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(c.out[0] as string).substantive).toBe(true);
  });

  test("--into sidesteps a collision under --full", async () => {
    const input = jsonl([{ id: 1, txt: "synthetic item 1: fine", substantive: "already here" }]);
    const c = capture(clientFrom(() => goodAnswer()));

    const result = await run(input, cfg({ into: "answers", full: true }), c.deps);

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(c.out[0] as string).substantive).toBe("already here");
  });
});

describe("runner: --why", () => {
  test("a reason per question lands beside its answer", async () => {
    const input = jsonl(syntheticItems(1));
    const c = capture(
      clientFrom(() =>
        ok({
          substantive: "true",
          substantive_why: "it names a percentage",
          substantive_score: "8",
          substantive_score_why: "a concrete number",
        }),
      ),
    );

    const result = await run(input, cfg({ why: true }), c.deps);

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(c.out[0] as string)).toMatchObject({
      substantive: true,
      substantive_why: "it names a percentage",
      substantive_score: 8,
      substantive_score_why: "a concrete number",
    });
  });

  test("a missing reason fails the item rather than shipping a half answer", async () => {
    const input = jsonl(syntheticItems(1));
    const c = capture(clientFrom(() => ok({ substantive: "true", substantive_score: "8" })));

    const result = await run(input, cfg({ why: true }), c.deps);

    expect(result.exitCode).toBe(1);
    expect(JSON.parse(c.out[0] as string).askq_error).toContain("substantive_why missing");
  });
});

describe("runner: the review band", () => {
  test("a flagged item carries askq_review; an agreeing one carries nothing", async () => {
    const input = jsonl(syntheticItems(2));
    const c = capture(
      clientFrom((prompt) =>
        lineOf(prompt) === 1
          ? ok({ substantive: "true", substantive_score: "5" })
          : ok({ substantive: "true", substantive_score: "9" }),
      ),
    );

    await run(input, cfg(), c.deps);

    expect(JSON.parse(c.out[0] as string).askq_review).toBe("mid-range substantive_score (5)");
    expect(JSON.parse(c.out[1] as string)).not.toHaveProperty("askq_review");
  });

  test("askq_review sits outside --into, being about the record", async () => {
    const input = jsonl(syntheticItems(1));
    const c = capture(clientFrom(() => ok({ substantive: "true", substantive_score: "5" })));

    await run(input, cfg({ into: "answers" }), c.deps);

    const record = JSON.parse(c.out[0] as string);
    expect(record.askq_review).toBeDefined();
    expect(record.answers.askq_review).toBeUndefined();
  });
});

describe("runner: --sample", () => {
  test("only the sampled items are sent, and the rest are not emitted", async () => {
    const input = jsonl(syntheticItems(50));
    let calls = 0;
    const c = capture(
      clientFrom(() => {
        calls++;
        return goodAnswer();
      }),
    );

    const result = await run(input, cfg({ sample: 3 }), c.deps);

    expect(calls).toBe(3);
    expect(c.out).toHaveLength(3);
    expect(result.exitCode).toBe(0);
    expect(c.err.some((l) => l.includes("sample of 3 of 50 items"))).toBe(true);
  });

  test("the exact prompt and the answers are readable on stderr", async () => {
    const input = jsonl(syntheticItems(2));
    const c = capture(clientFrom(() => ok({ substantive: "true", substantive_score: "5" })));

    await run(input, cfg({ sample: 2 }), c.deps);

    const err = c.err.join("\n");
    expect(err).toContain("--- the prompt sent for the first sampled item ---");
    expect(err).toContain("substantive (true/false): Does it report a measurement?");
    expect(err).toContain("[1] substantive=true  substantive_score=5");
    expect(err).toContain("synthetic item 1");
  });
});

describe("runner: the cache", () => {
  test("a cached answer is indistinguishable in the output and visible in the summary", async () => {
    const input = jsonl(syntheticItems(4));
    const cache = memoryCache();

    const first = capture(clientFrom(() => goodAnswer()));
    const cold = await run(input, cfg({ cache }), first.deps);

    let secondRunCalls = 0;
    const second = capture(
      clientFrom(() => {
        secondRunCalls++;
        return goodAnswer();
      }),
    );
    const warm = await run(input, cfg({ cache }), second.deps);

    expect(second.out).toEqual(first.out);
    expect(secondRunCalls).toBe(0);
    expect(warm.exitCode).toBe(cold.exitCode);
    expect(first.err.some((l) => l === "askq: cache 0 hit / 4 miss")).toBe(true);
    expect(second.err.some((l) => l === "askq: cache 4 hit / 0 miss")).toBe(true);
  });

  test("a reworded question misses the cache and asks again", async () => {
    const input = jsonl(syntheticItems(2));
    const cache = memoryCache();

    const first = capture(clientFrom(() => goodAnswer()));
    await run(input, cfg({ cache }), first.deps);

    let calls = 0;
    const second = capture(
      clientFrom(() => {
        calls++;
        return goodAnswer();
      }),
    );
    const reworded: RunConfig["questions"] = [
      { kind: "bool", name: "substantive", text: "Does it report a measurement, really?" },
      questions[1] as RunConfig["questions"][number],
    ];
    await run(input, cfg({ cache, questions: reworded }), second.deps);

    expect(calls).toBe(2);
  });

  test("a changed model misses the cache", async () => {
    const input = jsonl(syntheticItems(2));
    const cache = memoryCache();

    const first = capture(clientFrom(() => goodAnswer()));
    await run(input, cfg({ cache }), first.deps);

    let calls = 0;
    const second = capture(
      clientFrom(() => {
        calls++;
        return goodAnswer();
      }),
    );
    await run(input, cfg({ cache, model: "another-model" }), second.deps);

    expect(calls).toBe(2);
  });

  test("a changed item misses the cache", async () => {
    const cache = memoryCache();
    const first = capture(clientFrom(() => goodAnswer()));
    await run(jsonl(syntheticItems(2)), cfg({ cache }), first.deps);

    let calls = 0;
    const second = capture(
      clientFrom(() => {
        calls++;
        return goodAnswer();
      }),
    );
    await run(jsonl([{ id: 1, txt: "a different item entirely" }]), cfg({ cache }), second.deps);

    expect(calls).toBe(1);
  });

  test("a failed item is not cached, so the next run tries again", async () => {
    const input = jsonl(syntheticItems(1));
    const cache = memoryCache();

    const first = capture(clientFrom(() => itemFailure("http 503 after 4 attempts")));
    await run(input, cfg({ cache }), first.deps);
    expect(cache.size()).toBe(0);

    let calls = 0;
    const second = capture(
      clientFrom(() => {
        calls++;
        return goodAnswer();
      }),
    );
    const result = await run(input, cfg({ cache }), second.deps);

    expect(calls).toBe(1);
    expect(result.exitCode).toBe(0);
  });

  test("the cache keys on content, not on the output shape", async () => {
    const input = jsonl(syntheticItems(3));
    const cache = memoryCache();

    const first = capture(clientFrom(() => goodAnswer()));
    await run(input, cfg({ cache, full: true }), first.deps);

    let calls = 0;
    const second = capture(
      clientFrom(() => {
        calls++;
        return goodAnswer();
      }),
    );
    const warm = await run(input, cfg({ cache, id: ".id" }), second.deps);

    expect(calls).toBe(0);
    expect(warm.cacheHits).toBe(3);
    expect(JSON.parse(second.out[0] as string)).toEqual({
      askq_line: 1,
      askq_id: "1",
      substantive: true,
      substantive_score: 8,
    });
  });

  test("with no cache configured the summary says nothing about one", async () => {
    const c = capture(clientFrom(() => goodAnswer()));
    await run(jsonl(syntheticItems(1)), cfg(), c.deps);

    expect(c.err.some((l) => l.includes("cache"))).toBe(false);
  });
});

describe("runner: an interrupted run still accounts for every item", () => {
  test("abort stops new items, emits a line for each, and exits 130", async () => {
    const input = jsonl(syntheticItems(40));
    const controller = new AbortController();
    let calls = 0;
    const c = capture(
      clientFrom(() => {
        calls++;
        if (calls === 5) controller.abort();
        return goodAnswer();
      }),
    );
    c.deps.abort = controller.signal;

    const result = await run(input, cfg({ concurrency: 2 }), c.deps);

    expect(result.exitCode).toBe(130);
    expect(calls).toBeLessThan(40);
    expect(c.out).toHaveLength(40);
    expect(JSON.parse(c.out[39] as string).askq_error).toBe(
      "interrupted before this item was answered",
    );
    expect(c.err.some((l) => l.includes("interrupted — every item is still accounted for"))).toBe(
      true,
    );
    expect(c.err.some((l) => l.includes("coverage incomplete"))).toBe(true);
    // Unresolved items are the point of an interrupt, not a bug to report as one.
    expect(c.err.some((l) => l.includes("internal:"))).toBe(false);
  });
});

describe("runner: the cost guard", () => {
  test("over the limit: exit 3, and the transport is never called", async () => {
    const input = jsonl(syntheticItems(500));
    let calls = 0;
    const c = capture(
      clientFrom(() => {
        calls++;
        return goodAnswer();
      }),
    );

    const result = await run(
      input,
      cfg({ model: "gemini-3.5-flash-lite", maxCost: 0.000001 }),
      c.deps,
    );

    expect(result.exitCode).toBe(3);
    expect(calls).toBe(0);
    expect(c.out).toHaveLength(0);
    expect(c.err.some((l) => l.includes("over --max-cost"))).toBe(true);
    expect(c.err.some((l) => l.includes("Nothing was sent"))).toBe(true);
  });

  test("--yes runs anyway", async () => {
    const input = jsonl(syntheticItems(5));
    const c = capture(clientFrom(() => goodAnswer()));

    const result = await run(
      input,
      cfg({ model: "gemini-3.5-flash-lite", maxCost: 0.000001, yes: true }),
      c.deps,
    );

    expect(result.exitCode).toBe(0);
    expect(c.out).toHaveLength(5);
  });

  test("under the limit it does not interfere", async () => {
    const input = jsonl(syntheticItems(5));
    const c = capture(clientFrom(() => goodAnswer()));

    const result = await run(input, cfg({ model: "gemini-3.5-flash-lite", maxCost: 1 }), c.deps);

    expect(result.exitCode).toBe(0);
  });

  test("cached items are excluded from the estimate", async () => {
    const input = jsonl(syntheticItems(500));
    const cache = memoryCache();
    const warm = capture(clientFrom(() => goodAnswer()));
    await run(input, cfg({ cache, model: "gemini-3.5-flash-lite", yes: true }), warm.deps);

    const c = capture(clientFrom(() => goodAnswer()));
    const result = await run(
      input,
      cfg({ cache, model: "gemini-3.5-flash-lite", maxCost: 0.000001 }),
      c.deps,
    );

    expect(result.exitCode).toBe(0);
    expect(c.out).toHaveLength(500);
  });

  test("an unpriced model cannot be guarded, and the run proceeds", async () => {
    const input = jsonl(syntheticItems(3));
    const c = capture(clientFrom(() => goodAnswer()));

    const result = await run(input, cfg({ model: "some-new-model", maxCost: 0 }), c.deps);

    expect(result.exitCode).toBe(0);
  });
});

describe("runner: a request-shaped failure aborts instead of burning every item", () => {
  test("a fatal error stops the run and exits 2", async () => {
    const input = jsonl(syntheticItems(30));
    let calls = 0;
    const c = capture(
      clientFrom(() => {
        calls++;
        return fatal("http 400: Invalid value at 'generation_config.thinking_config'");
      }),
    );

    const result = await run(input, cfg({ concurrency: 3 }), c.deps);

    expect(result.exitCode).toBe(2);
    expect(calls).toBeLessThan(30);
    expect(c.err.some((l) => l.includes("aborted:"))).toBe(true);
  });

  test("an aborted run still emits one line per item, named as aborted not as a bug", async () => {
    const input = jsonl(syntheticItems(30));
    const c = capture(clientFrom(() => fatal("http 404: model is no longer available")));

    await run(input, cfg({ concurrency: 3 }), c.deps);

    expect(c.out).toHaveLength(30);
    const last = JSON.parse(c.out[29] as string);
    expect(last.askq_error).toContain("aborted before this item was answered");
    expect(last.askq_error).toContain("404");
    expect(last.askq_error).not.toContain("internal");
  });
});
