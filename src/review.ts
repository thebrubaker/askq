import type { Question } from "./questions";

/**
 * The review band: which items not to take askq's word on.
 *
 * Both signals are observations about answers askq already has — never a confidence the
 * model reported about itself, which is known to be poorly calibrated.
 *
 *  (a) an anchored score answered mid-range. The prompt defines the middle as "genuinely
 *      borderline", so a 5 is the answer to the question asked.
 *  (b) a bool and its paired score contradict each other. Two independently decoded answers
 *      about the same thing disagree.
 *
 * This whole file is a hypothesis until stage 5 measures it against hand labels. Deleting it
 * is this file, the `askq_review` line in runner.ts, and the review block in report.ts.
 */

export const MID_RANGE = [4, 5, 6];
export const LOW_SCORE = 3;
export const HIGH_SCORE = 7;

export type ReviewReason = {
  kind: "mid" | "disagree";
  question: string;
  /** What goes in askq_review: names the values, so a reader can judge it. */
  text: string;
  /** What the summary counts: the same shape for every item that fired this way. */
  label: string;
};

/** A score named `<X>_score` is the graded version of the bool or choice named `<X>`. */
export function pairedBaseName(scoreName: string): string | undefined {
  return scoreName.endsWith("_score") ? scoreName.slice(0, -"_score".length) : undefined;
}

export function unpairedScores(questions: Question[]): string[] {
  const names = new Set(questions.map((q) => q.name));
  return questions
    .filter((q) => q.kind === "score")
    .map((q) => q.name)
    .filter((name) => {
      const base = pairedBaseName(name);
      return base !== undefined && !names.has(base);
    });
}

export function hasBand(questions: Question[]): boolean {
  return questions.some((q) => q.kind === "score");
}

export function reviewReasons(
  questions: Question[],
  answers: Record<string, unknown>,
): ReviewReason[] {
  const byName = new Map(questions.map((q) => [q.name, q]));
  const reasons: ReviewReason[] = [];

  for (const q of questions) {
    if (q.kind !== "score") continue;
    const score = answers[q.name];
    if (typeof score !== "number") continue;

    const baseName = pairedBaseName(q.name);
    const base = baseName === undefined ? undefined : byName.get(baseName);
    const baseAnswer = base === undefined ? undefined : answers[base.name];

    if (base?.kind === "bool" && typeof baseAnswer === "boolean") {
      const contradicts =
        (baseAnswer && score <= LOW_SCORE) || (!baseAnswer && score >= HIGH_SCORE);
      if (contradicts) {
        reasons.push({
          kind: "disagree",
          question: q.name,
          text: `${base.name}=${baseAnswer} disagrees with ${q.name}=${score}`,
          label: `\`${base.name}\` disagrees with \`${q.name}\``,
        });
        continue;
      }
    }

    if (MID_RANGE.includes(score)) {
      reasons.push({
        kind: "mid",
        question: q.name,
        text: `mid-range ${q.name} (${score})`,
        label: `mid-range \`${q.name}\``,
      });
    }
  }

  return reasons;
}

export function reviewMarker(
  questions: Question[],
  answers: Record<string, unknown>,
): string | undefined {
  const reasons = reviewReasons(questions, answers);
  return reasons.length === 0 ? undefined : reasons.map((r) => r.text).join("; ");
}
