import { describe, expect, test } from "bun:test";
import { parseQuestions, UsageError } from "../src/questions";

const parse = (kind: "bool" | "choice" | "score", spec: string) =>
  parseQuestions([{ kind, spec }])[0];

describe("question specs", () => {
  test("--bool takes NAME=QUESTION", () => {
    expect(parse("bool", "substantive=Reports a measurement; not promotion")).toEqual({
      kind: "bool",
      name: "substantive",
      text: "Reports a measurement; not promotion",
    });
  });

  test("--choice splits the values off the question at the first ': '", () => {
    expect(parse("choice", "stance=positive|skeptical|neutral: the author's stance")).toEqual({
      kind: "choice",
      name: "stance",
      text: "the author's stance",
      values: ["positive", "skeptical", "neutral"],
    });
  });

  test("--choice keeps later colons inside the question text", () => {
    const q = parse("choice", "kind=a|b: is it this: or that?");
    expect(q).toMatchObject({ text: "is it this: or that?", values: ["a", "b"] });
  });

  test("--choice without a question is allowed", () => {
    expect(parse("choice", "stance=positive|negative")).toMatchObject({
      values: ["positive", "negative"],
      text: "",
    });
  });

  test("declaration order across different flags is preserved", () => {
    const questions = parseQuestions([
      { kind: "bool", spec: "a=first" },
      { kind: "score", spec: "b=second" },
      { kind: "bool", spec: "c=third" },
    ]);
    expect(questions.map((q) => q.name)).toEqual(["a", "b", "c"]);
  });

  test.each([
    ["no equals sign", "bool", "substantive"],
    ["empty name", "bool", "=a question"],
    ["invalid name", "bool", "has-a-dash=a question"],
    ["reserved name", "bool", "askq_error=a question"],
    ["empty question", "bool", "substantive="],
    ["one choice value", "choice", "stance=positive: only one"],
    ["duplicate choice values", "choice", "stance=a|a: two the same"],
  ])("%s is a usage error", (_label, kind, spec) => {
    expect(() => parse(kind as "bool" | "choice", spec)).toThrow(UsageError);
  });

  test("a duplicate question name is a usage error", () => {
    expect(() =>
      parseQuestions([
        { kind: "bool", spec: "x=one" },
        { kind: "score", spec: "x=two" },
      ]),
    ).toThrow(/duplicate/);
  });

  test("no questions at all is a usage error", () => {
    expect(() => parseQuestions([])).toThrow(UsageError);
  });
});
