import { describe, expect, test } from "bun:test";
import { costOf, estimate, PRICES } from "../src/cost";
import type { Question } from "../src/questions";

const questions: Question[] = [
  { kind: "bool", name: "a", text: "?" },
  { kind: "choice", name: "b", text: "?", values: ["x", "y"] },
  { kind: "score", name: "c", text: "0 = none, 10 = lots." },
];

describe("estimate", () => {
  test("input tokens come from the prompt length, output from the question count", () => {
    const e = estimate([400, 800], questions, false, "gemini-3.5-flash-lite");

    expect(e.tokensIn).toBe(100 + 200);
    expect(e.tokensOut).toBe(2 * (3 * 11 + 4));
  });

  test("--why raises the output estimate, not the input", () => {
    const plain = estimate([400], questions, false, "gemini-3.5-flash-lite");
    const withWhy = estimate([400], questions, true, "gemini-3.5-flash-lite");

    expect(withWhy.tokensIn).toBe(plain.tokensIn);
    expect(withWhy.tokensOut).toBeGreaterThan(plain.tokensOut);
  });

  test("it lands close to the real 67-item run it was calibrated on", () => {
    // Measured 2026-09-18: 43,106 prompt characters over 66 items produced 10,711 prompt
    // tokens and 2,203 output tokens for three questions.
    const e = estimate(new Array(66).fill(43106 / 66), questions, false, "gemini-3.5-flash-lite");

    expect(e.tokensIn).toBeGreaterThan(10_000);
    expect(e.tokensIn).toBeLessThan(11_500);
    expect(e.tokensOut).toBeGreaterThan(1_800);
    expect(e.tokensOut).toBeLessThan(2_800);
  });

  test("an unknown model gives token counts but no price", () => {
    const e = estimate([400], questions, false, "some-new-model");

    expect(e.tokensIn).toBe(100);
    expect(e.usd).toBeUndefined();
  });
});

describe("prices", () => {
  test("the default model is priced", () => {
    expect(PRICES["gemini-3.5-flash-lite"]).toEqual({ in: 0.3, out: 2.5 });
  });

  test("cost is per million tokens", () => {
    expect(costOf(1_000_000, 0, "gemini-3.5-flash-lite")).toBeCloseTo(0.3, 6);
    expect(costOf(0, 1_000_000, "gemini-3.5-flash-lite")).toBeCloseTo(2.5, 6);
  });

  test("a thousand tweet-sized items cost cents, not dollars", () => {
    const e = estimate(new Array(1000).fill(650), questions, false, "gemini-3.5-flash-lite");
    expect(e.usd).toBeLessThan(0.2);
  });
});
