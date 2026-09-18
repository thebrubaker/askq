import { describe, expect, test } from "bun:test";
import type { Slot } from "../src/coverage";
import type { Question } from "../src/questions";
import { borderlineIndices, snippet, spotCheck, topByScore } from "../src/triage";

const answered = (a: Record<string, unknown>): Slot => ({ state: "answered", answers: a });

const scored: Question[] = [
  { kind: "bool", name: "substantive", text: "?" },
  { kind: "score", name: "substantive_score", text: "0 = none, 10 = a hard number." },
];

/** 20 items scoring 0,1,2,…,10,0,1,… with the bool agreeing, so nothing is borderline. */
const corpus = (n: number): { slots: Slot[]; texts: string[] } => {
  const slots: Slot[] = [];
  const texts: string[] = [];
  for (let i = 0; i < n; i++) {
    const score = i % 11;
    slots.push(answered({ substantive: score >= 7, substantive_score: score }));
    texts.push(`item ${i + 1} with score ${score}`);
  }
  return { slots, texts };
};

describe("read from the top", () => {
  test("highest score first, ties broken by line order", () => {
    const { slots } = corpus(25);
    const top = topByScore(scored, slots, 5);

    expect(top).toEqual([10, 21, 9, 20, 8]);
  });

  test("a run with no score question has no ranking", () => {
    const { slots } = corpus(5);
    expect(topByScore([scored[0] as Question], slots, 5)).toEqual([]);
  });

  test("failed items are never ranked", () => {
    const slots: Slot[] = [
      answered({ substantive: true, substantive_score: 9 }),
      { state: "failed", reason: "http 503" },
    ];
    expect(topByScore(scored, slots, 5)).toEqual([0]);
  });
});

describe("spot-check: with a score it samples the low band only", () => {
  test("every picked item scored at or below the low threshold", () => {
    const { slots, texts } = corpus(40);
    const check = spotCheck(scored, slots, texts, 5, new Set());

    expect(check.kind).toBe("picked");
    if (check.kind !== "picked") return;
    for (const i of check.indices) {
      const slot = slots[i];
      expect(
        slot?.state === "answered" && (slot.answers.substantive_score as number),
      ).toBeLessThanOrEqual(3);
    }
    expect(check.label).toContain("scored 3 or below");
  });

  test("it never reaches for the merely-unshown middle", () => {
    const slots: Slot[] = [
      answered({ substantive: true, substantive_score: 10 }),
      answered({ substantive: true, substantive_score: 7 }),
      answered({ substantive: true, substantive_score: 7 }),
      answered({ substantive: false, substantive_score: 2 }),
    ];
    const texts = ["a", "b", "c", "d"];

    const check = spotCheck(scored, slots, texts, 5, new Set([0]));

    expect(check.kind === "picked" && check.indices).toEqual([3]);
  });

  test("an empty low band says so instead of sampling elsewhere", () => {
    const slots: Slot[] = [
      answered({ substantive: true, substantive_score: 9 }),
      answered({ substantive: true, substantive_score: 7 }),
    ];
    const check = spotCheck(scored, slots, ["a", "b"], 5, new Set());

    expect(check.kind).toBe("empty");
    expect(check.kind === "empty" && check.label).toContain("nothing scored 3 or below");
  });

  test("a low band smaller than the limit shows what there is", () => {
    const slots: Slot[] = [
      answered({ substantive: true, substantive_score: 9 }),
      answered({ substantive: false, substantive_score: 1 }),
    ];
    const check = spotCheck(scored, slots, ["a", "b"], 5, new Set());

    expect(check.kind === "picked" && check.indices).toEqual([1]);
  });

  test("the picks are stable across runs and independent of the limit's order", () => {
    const { slots, texts } = corpus(40);
    const a = spotCheck(scored, slots, texts, 5, new Set());
    const b = spotCheck(scored, slots, texts, 5, new Set());

    expect(a).toEqual(b);
  });

  test("the picks are content-seeded, so different text picks differently", () => {
    const { slots, texts } = corpus(40);
    const other = texts.map((t) => `${t} (reworded corpus)`);

    const a = spotCheck(scored, slots, texts, 5, new Set());
    const b = spotCheck(scored, slots, other, 5, new Set());

    expect(a).not.toEqual(b);
  });

  test("picked lines are shown in line order", () => {
    const { slots, texts } = corpus(40);
    const check = spotCheck(scored, slots, texts, 5, new Set());

    if (check.kind !== "picked") throw new Error("expected picks");
    expect([...check.indices].sort((x, y) => x - y)).toEqual(check.indices);
  });
});

describe("spot-check: without a score", () => {
  const boolOnly: Question[] = [{ kind: "bool", name: "substantive", text: "?" }];
  const choiceOnly: Question[] = [
    { kind: "choice", name: "stance", text: "?", values: ["positive", "skeptical", "neutral"] },
  ];

  test("a bool-only run samples the items answered false", () => {
    const slots: Slot[] = [
      answered({ substantive: true }),
      answered({ substantive: false }),
      answered({ substantive: false }),
    ];
    const check = spotCheck(boolOnly, slots, ["a", "b", "c"], 5, new Set());

    expect(check.kind === "picked" && check.indices).toEqual([1, 2]);
    expect(check.kind === "picked" && check.label).toContain("answered substantive=false");
  });

  test("a bool-only run with nothing false says so", () => {
    const slots: Slot[] = [answered({ substantive: true })];
    const check = spotCheck(boolOnly, slots, ["a"], 5, new Set());

    expect(check.kind === "empty" && check.label).toContain(
      "nothing was answered substantive=false",
    );
  });

  test("a choice-only run samples the largest class and names it", () => {
    const slots: Slot[] = [
      answered({ stance: "positive" }),
      answered({ stance: "positive" }),
      answered({ stance: "positive" }),
      answered({ stance: "skeptical" }),
    ];
    const check = spotCheck(choiceOnly, slots, ["a", "b", "c", "d"], 5, new Set());

    expect(check.kind === "picked" && check.indices).toEqual([0, 1, 2]);
    expect(check.kind === "picked" && check.label).toContain("stance=positive (the largest class)");
  });
});

describe("borderline indices and snippets", () => {
  test("borderline is exactly what carries a review marker", () => {
    const slots: Slot[] = [
      answered({ substantive: true, substantive_score: 9 }),
      answered({ substantive: true, substantive_score: 5 }),
      answered({ substantive: true, substantive_score: 1 }),
    ];
    expect(borderlineIndices(scored, slots)).toEqual([1, 2]);
  });

  test("a snippet is one line and bounded", () => {
    expect(snippet("a\n  b\tc  ", 80)).toBe("a b c");
    expect(snippet("x".repeat(200), 10)).toHaveLength(10);
    expect(snippet(undefined, 10)).toBe("");
  });
});
