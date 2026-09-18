import { describe, expect, test } from "bun:test";
import type { Question } from "../src/questions";
import {
  hasBand,
  pairedBaseName,
  reviewMarker,
  reviewReasons,
  unpairedScores,
} from "../src/review";

const paired: Question[] = [
  { kind: "bool", name: "substantive", text: "does it report a measurement?" },
  { kind: "score", name: "substantive_score", text: "0 = none, 10 = a hard number." },
];

describe("pairing is declared by the name", () => {
  test("a score named <X>_score pairs with <X>", () => {
    expect(pairedBaseName("substantive_score")).toBe("substantive");
    expect(pairedBaseName("quality")).toBeUndefined();
  });

  test("a score whose base question does not exist is reported, not silently unpaired", () => {
    expect(unpairedScores([paired[1] as Question])).toEqual(["substantive_score"]);
    expect(unpairedScores(paired)).toEqual([]);
  });

  test("a band needs a score question", () => {
    expect(hasBand(paired)).toBe(true);
    expect(hasBand([paired[0] as Question])).toBe(false);
  });
});

describe("signal (a): a mid-range score", () => {
  test.each([4, 5, 6])("%d is flagged", (score) => {
    expect(reviewMarker(paired, { substantive: true, substantive_score: score })).toBe(
      `mid-range substantive_score (${score})`,
    );
  });

  test.each([0, 1, 2, 3, 7, 8, 9, 10])("%d is not flagged when the bool agrees", (score) => {
    const answers = { substantive: score >= 7, substantive_score: score };
    expect(reviewMarker(paired, answers)).toBeUndefined();
  });
});

describe("signal (b): the bool and its score contradict each other", () => {
  test("true with a low score", () => {
    expect(reviewMarker(paired, { substantive: true, substantive_score: 2 })).toBe(
      "substantive=true disagrees with substantive_score=2",
    );
  });

  test("false with a high score", () => {
    expect(reviewMarker(paired, { substantive: false, substantive_score: 9 })).toBe(
      "substantive=false disagrees with substantive_score=9",
    );
  });

  test("a contradiction is reported once, not also as mid-range", () => {
    const reasons = reviewReasons(paired, { substantive: true, substantive_score: 3 });
    expect(reasons).toHaveLength(1);
    expect(reasons[0]?.kind).toBe("disagree");
  });

  test("an unpaired score gets signal (a) only", () => {
    const unpaired: Question[] = [
      { kind: "bool", name: "substantive", text: "?" },
      { kind: "score", name: "quality", text: "0 = none, 10 = lots." },
    ];
    expect(reviewMarker(unpaired, { substantive: true, quality: 1 })).toBeUndefined();
    expect(reviewMarker(unpaired, { substantive: true, quality: 5 })).toBe("mid-range quality (5)");
  });

  test("a choice never produces a disagreement, having no order on its values", () => {
    const withChoice: Question[] = [
      { kind: "choice", name: "stance", text: "?", values: ["positive", "negative"] },
      { kind: "score", name: "stance_score", text: "0 = none, 10 = lots." },
    ];
    expect(reviewMarker(withChoice, { stance: "positive", stance_score: 0 })).toBeUndefined();
  });
});

describe("the band says nothing when it has nothing to say", () => {
  test("no score question means no marker at all", () => {
    expect(reviewMarker([paired[0] as Question], { substantive: true })).toBeUndefined();
  });

  test("a failed or missing answer is not flagged", () => {
    expect(reviewMarker(paired, {})).toBeUndefined();
  });
});
