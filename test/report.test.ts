import { describe, expect, test } from "bun:test";
import type { FinishReport, Slot } from "../src/coverage";
import type { Question } from "../src/questions";
import { report } from "../src/report";

const questions: Question[] = [
  { kind: "bool", name: "substantive", text: "?" },
  { kind: "choice", name: "stance", text: "?", values: ["positive", "skeptical", "neutral"] },
  { kind: "score", name: "substantive_score", text: "0 = none, 10 = a hard number." },
];

const answered = (a: Record<string, unknown>): Slot => ({ state: "answered", answers: a });

function run(
  slots: Slot[],
  over: Partial<FinishReport> = {},
  extra: { texts?: string[]; sample?: boolean; hasId?: boolean; full?: boolean } = {},
): string[] {
  const lines: string[] = [];
  const answeredCount = slots.filter((s) => s.state === "answered").length;
  const failed = slots.filter((s) => s.state === "failed").length;
  report({
    questions,
    slots,
    texts: extra.texts ?? slots.map((_, i) => `synthetic item ${i + 1}`),
    finish: {
      total: slots.length,
      answered: answeredCount,
      failed,
      unresolved: [],
      ...over,
    },
    calls: slots.length,
    tokensIn: 1000,
    tokensOut: 200,
    elapsedMs: 2300,
    sample: extra.sample,
    hasId: extra.hasId,
    full: extra.full,
    stderr: (l) => lines.push(l),
  });
  return lines;
}

const spread = (n: number): Slot[] =>
  Array.from({ length: n }, (_, i) =>
    answered({
      substantive: i % 3 !== 0,
      stance: ["positive", "skeptical", "neutral"][i % 3] as string,
      substantive_score: i % 11,
    }),
  );

describe("the header and the distributions", () => {
  test("counts, time, calls and tokens on one line", () => {
    const lines = run(spread(30));
    expect(lines[0]).toBe(
      "askq: 30 items · 30 answered · 0 failed · 2.3s · 30 calls · 1,000 in + 200 out tokens",
    );
  });

  test("every question gets a distribution line, including classes that never fired", () => {
    const lines = run([answered({ substantive: true, stance: "positive", substantive_score: 9 })]);
    expect(lines.find((l) => l.includes("substantive "))).toContain("true 1 (100.0%)");
    expect(lines.find((l) => l.includes("stance"))).toContain("skeptical 0 (0.0%)");
    expect(lines.find((l) => l.includes("substantive_score"))).toContain("7-10 1");
    expect(lines.find((l) => l.includes("substantive_score"))).toContain("distinct 1");
  });

  test("a clean run still says so", () => {
    expect(run(spread(5)).at(-1)).toBe("askq: coverage complete: 5/5 answered");
  });
});

describe("the one-class warning", () => {
  test("fires when a question puts everything in one class", () => {
    const slots = Array.from({ length: 25 }, () =>
      answered({ substantive: true, stance: "positive", substantive_score: 8 }),
    );
    const lines = run(slots);
    expect(lines.some((l) => l.includes('`substantive` answered "true" for every item'))).toBe(
      true,
    );
    expect(lines.some((l) => l.includes('`stance` answered "positive" for every item'))).toBe(true);
  });

  const oneClassFired = (lines: string[]): boolean =>
    lines.some((l) => l.includes("looks exactly like this"));

  test("does NOT fire on a healthy distribution — the control", () => {
    expect(oneClassFired(run(spread(30)))).toBe(false);
  });

  test("does not fire below the item threshold, where one class means nothing", () => {
    const slots = Array.from({ length: 19 }, () =>
      answered({ substantive: true, stance: "positive", substantive_score: 8 }),
    );
    expect(oneClassFired(run(slots))).toBe(false);
  });

  test("a near-miss at 96% stays quiet", () => {
    const slots = Array.from({ length: 25 }, (_, i) =>
      answered({
        substantive: i > 0,
        stance: i > 0 ? "positive" : "neutral",
        substantive_score: i % 11,
      }),
    );
    expect(oneClassFired(run(slots))).toBe(false);
  });

  test("a degenerate score is called out by its distinct count", () => {
    const slots = Array.from({ length: 25 }, (_, i) =>
      answered({
        substantive: i % 2 === 0,
        stance: i % 2 === 0 ? "positive" : "neutral",
        substantive_score: 10,
      }),
    );
    const lines = run(slots);
    expect(lines.some((l) => l.includes("`substantive_score` used only 1 distinct value"))).toBe(
      true,
    );
  });
});

describe("the review band", () => {
  test("names the lines to read and how to select them", () => {
    const slots: Slot[] = [
      answered({ substantive: true, stance: "positive", substantive_score: 9 }),
      answered({ substantive: true, stance: "positive", substantive_score: 5 }),
      answered({ substantive: true, stance: "neutral", substantive_score: 1 }),
    ];
    const lines = run(slots);

    expect(
      lines.some((l) =>
        l.includes("borderline — 2 of 3 worth reading yourself (66.7%): lines 2 3"),
      ),
    ).toBe(true);
    expect(lines.some((l) => l.includes("1 mid-range `substantive_score`"))).toBe(true);
    expect(lines.some((l) => l.includes("jq -c 'select(.askq_review)'"))).toBe(true);
  });

  test("makes no claim about finding askq's own mistakes", () => {
    const slots: Slot[] = [
      answered({ substantive: true, stance: "positive", substantive_score: 5 }),
    ];
    const lines = run(slots).join("\n");
    expect(lines).not.toMatch(/mistake|wrong|error/i);
  });

  test("says plainly when nothing was flagged", () => {
    const slots = [answered({ substantive: true, stance: "positive", substantive_score: 9 })];
    expect(
      run(slots).some((l) => l.includes("none of the 1 answered items landed in between")),
    ).toBe(true);
  });

  test("a band that swallows a third of the run warns that the question is blunt", () => {
    const slots = Array.from({ length: 30 }, (_, i) =>
      answered({
        substantive: i % 2 === 0,
        stance: i % 2 === 0 ? "positive" : "neutral",
        substantive_score: i % 3 === 0 ? 5 : i % 3 === 1 ? 9 : 1,
      }),
    );
    const lines = run(slots);
    expect(lines.some((l) => l.includes("of answered items are in the review band"))).toBe(true);
  });

  test("a narrow band does not warn — the control", () => {
    const slots = Array.from({ length: 30 }, (_, i) =>
      answered({
        substantive: i % 2 === 0,
        stance: i % 2 === 0 ? "positive" : "neutral",
        substantive_score: i === 0 ? 5 : i % 2 === 0 ? 9 : 1,
      }),
    );
    expect(run(slots).some((l) => l.includes("review band — too many"))).toBe(false);
  });
});

describe("the readout an agent acts on without opening the file", () => {
  test("the top block shows five with snippets, names the rest, and says how to read on", () => {
    const lines = run(spread(30));

    expect(
      lines.some((l) => l === "askq: read from the top — highest substantive_score first:"),
    ).toBe(true);
    const rows = lines.filter((l) => /^askq:   \[\s*\d+\]\s+\d+\s+\S/.test(l));
    expect(rows.length).toBeGreaterThanOrEqual(5);
    expect(rows[0]).toContain("synthetic item");
    expect(lines.some((l) => l.includes("… 5 more, lines "))).toBe(true);
    expect(
      lines.some((l) =>
        l.includes(
          "read on: jq -sc 'map(select(.substantive_score!=null))|sort_by(-.substantive_score)|.[10:][]'",
        ),
      ),
    ).toBe(true);
  });

  test("the spot-check prints its items and says what to do if one looks interesting", () => {
    const lines = run(spread(30));

    expect(lines.some((l) => l.includes("spot-check — ") && l.includes("scored 3 or below"))).toBe(
      true,
    );
    expect(lines.some((l) => l.includes("the question is wrong — reword it"))).toBe(true);
    expect(lines.some((l) => l.includes("what you read first, not what you skip"))).toBe(true);
  });

  test("the spot-check is skipped when nothing was hidden from the reader", () => {
    const lines = run(spread(9));
    expect(lines.some((l) => l.includes("spot-check"))).toBe(false);
  });

  test("a sample run skips both blocks, printing its items in full already", () => {
    const lines = run(spread(30), {}, { sample: true });
    expect(lines.some((l) => l.includes("read from the top"))).toBe(false);
    expect(lines.some((l) => l.includes("spot-check"))).toBe(false);
  });

  test("a pointer run without --id says how to get a joinable pointer", () => {
    expect(run(spread(3)).some((l) => l.includes("pass --id <path>"))).toBe(true);
  });

  test("the hint is silent when it has nothing to add", () => {
    expect(run(spread(3), {}, { hasId: true }).some((l) => l.includes("pass --id"))).toBe(false);
    expect(run(spread(3), {}, { full: true }).some((l) => l.includes("pass --id"))).toBe(false);
  });
});

describe("failures", () => {
  test("each failed item is named by line, and the coverage line says incomplete", () => {
    const slots: Slot[] = [
      answered({ substantive: true, stance: "positive", substantive_score: 9 }),
      { state: "failed", reason: "http 503 after 4 attempts" },
    ];
    const lines = run(slots);

    expect(lines.some((l) => l === "askq:   line 2 — http 503 after 4 attempts")).toBe(true);
    expect(lines.at(-1)).toBe("askq: coverage incomplete: 1/2 answered");
  });

  test("an internal hole is reported separately from an ordinary failure", () => {
    const slots: Slot[] = [{ state: "failed", reason: "internal: item never resolved" }];
    const lines = run(slots, { unresolved: [0] });

    expect(lines.some((l) => l.includes("internal: 1 items never resolved: lines 1"))).toBe(true);
  });
});
