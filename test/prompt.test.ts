import { describe, expect, test } from "bun:test";
import { buildPrompt } from "../src/prompt";
import type { Question } from "../src/questions";
import { buildSchema, coerceAnswer } from "../src/schema";

const questions: Question[] = [
  { kind: "bool", name: "substantive", text: "Reports a measurement; not promotion." },
  {
    kind: "choice",
    name: "stance",
    text: "the author's stance toward the tool",
    values: ["positive", "skeptical", "neutral"],
  },
  {
    kind: "score",
    name: "substantive_score",
    text: "0 = pure promotion, 10 = a falsifiable claim.",
  },
];

describe("prompt", () => {
  test("one item, every question, in declaration order", () => {
    expect(buildPrompt("shipped a 12% win", questions)).toBe(
      [
        "Item:",
        '"""',
        "shipped a 12% win",
        '"""',
        "",
        "Answer each question about the item above, and only about it.",
        "",
        "substantive (true/false): Reports a measurement; not promotion.",
        "stance (one of: positive, skeptical, neutral): the author's stance toward the tool",
        "substantive_score (answer 0-10): 0 = pure promotion, 10 = a falsifiable claim. Use the middle of the range for genuinely borderline items.",
      ].join("\n"),
    );
  });

  test("the item text is passed through verbatim", () => {
    const text = 'has "quotes" and\nnewlines';
    expect(buildPrompt(text, questions)).toContain(text);
  });
});

describe("schema", () => {
  test("every question is a required enum property in declaration order", () => {
    expect(buildSchema(questions)).toEqual({
      type: "OBJECT",
      properties: {
        substantive: { type: "STRING", enum: ["true", "false"] },
        stance: { type: "STRING", enum: ["positive", "skeptical", "neutral"] },
        substantive_score: {
          type: "STRING",
          enum: ["0", "1", "2", "3", "4", "5", "6", "7", "8", "9", "10"],
        },
      },
      required: ["substantive", "stance", "substantive_score"],
      propertyOrdering: ["substantive", "stance", "substantive_score"],
    });
  });

  test("answers are coerced to real JSON types", () => {
    expect(coerceAnswer(questions[0] as Question, "true")).toEqual({ ok: true, value: true });
    expect(coerceAnswer(questions[1] as Question, "skeptical")).toEqual({
      ok: true,
      value: "skeptical",
    });
    expect(coerceAnswer(questions[2] as Question, "7")).toEqual({ ok: true, value: 7 });
  });

  test("a value outside the enum is refused rather than passed through", () => {
    expect(coerceAnswer(questions[0] as Question, "yes")).toMatchObject({ ok: false });
    expect(coerceAnswer(questions[2] as Question, "11")).toMatchObject({ ok: false });
    expect(coerceAnswer(questions[0] as Question, undefined)).toMatchObject({ ok: false });
  });
});
