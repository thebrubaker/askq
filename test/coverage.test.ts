import { describe, expect, test } from "bun:test";
import { Coverage, INTERNAL_REASON, type FinishReport } from "../src/coverage";

/**
 * The assertion the coverage guarantee rests on, written once so it can be pointed at both
 * the real implementation and a deliberately weakened one.
 */
function assertHoleIsLoud(report: FinishReport, index: number): void {
  expect(report.unresolved).toContain(index);
  expect(report.answered).toBeLessThan(report.total);
  expect(report.answered + report.failed).toBe(report.total);
}

describe("coverage", () => {
  test("an unfilled slot is reported, counted as failed, and never silently dropped", () => {
    const coverage = new Coverage(10);
    for (let i = 0; i < 10; i++) if (i !== 7) coverage.answer(i, { a: true });

    const report = coverage.finish();

    assertHoleIsLoud(report, 7);
    expect(report.answered).toBe(9);
    expect(report.failed).toBe(1);
    expect(coverage.get(7)).toEqual({ state: "failed", reason: INTERNAL_REASON });
  });

  test("negative control: the same assertion fails against a coverage that ignores holes", () => {
    // A coverage implementation that reports a clean run while slot 7 was never filled —
    // exactly the bug the real one must make impossible.
    const weakened: FinishReport = { total: 10, answered: 10, failed: 0, unresolved: [] };

    expect(() => assertHoleIsLoud(weakened, 7)).toThrow();
  });

  test("answered + failed always equals total on a clean run", () => {
    const coverage = new Coverage(4);
    coverage.answer(0, {});
    coverage.fail(1, "http 503");
    coverage.answer(2, {});
    coverage.answer(3, {});

    const report = coverage.finish();

    expect(report.unresolved).toEqual([]);
    expect(report.answered).toBe(3);
    expect(report.failed).toBe(1);
    expect(report.answered + report.failed).toBe(report.total);
  });

  test("settling the same slot twice throws instead of overwriting", () => {
    const coverage = new Coverage(2);
    coverage.answer(0, {});
    expect(() => coverage.answer(0, {})).toThrow(/already settled/);
    expect(() => coverage.fail(0, "late failure")).toThrow(/already settled/);
  });

  test("an out-of-range index throws", () => {
    const coverage = new Coverage(2);
    expect(() => coverage.answer(5, {})).toThrow(/outside/);
  });
});
