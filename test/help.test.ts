import { describe, expect, test } from "bun:test";
import { HELP } from "../src/cli";

describe("help text", () => {
  test("every jq example guards against items that failed and have no score", () => {
    // Verified by running them: `sort_by(-.score)` dies with "null (null) cannot be negated"
    // the moment one item failed, which is the normal case, not the edge case.
    const sorts = HELP.split("\n").filter((l) => l.includes("sort_by(-"));
    expect(sorts.length).toBeGreaterThan(0);
    for (const line of sorts) {
      expect(line).toContain("map(select(");
    }
  });

  test("leads with --score, which is what orders the reading", () => {
    const score = HELP.indexOf("--score");
    const bool = HELP.indexOf("--bool");
    expect(score).toBeGreaterThan(-1);
    expect(score).toBeLessThan(bool);
  });

  test("never calls a score a probability or a confidence", () => {
    expect(HELP).toMatch(/not a probability and not a confidence/);
    expect(HELP).not.toMatch(/confidence (score|level|that)/i);
  });
});
