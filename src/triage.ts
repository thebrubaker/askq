import { createHash } from "node:crypto";
import type { Slot } from "./coverage";
import type { Question } from "./questions";
import { LOW_SCORE, reviewReasons } from "./review";

/**
 * What the readout shows an agent that knows nothing about askq: what to read first, and a
 * handful of the items it decided were not worth reading. The second one is the point — a
 * badly worded question returns healthy-looking answers, and the only cheap way to catch
 * that is to put a few of the discards in front of the reader.
 */

const SPOT_CHECK_SALT = "askq-spot-check";

export function scoreQuestion(questions: Question[]): Question | undefined {
  return questions.find((q) => q.kind === "score");
}

export function answeredIndices(slots: readonly Slot[]): number[] {
  const out: number[] = [];
  for (let i = 0; i < slots.length; i++) if (slots[i]?.state === "answered") out.push(i);
  return out;
}

function answerOf(slots: readonly Slot[], index: number, name: string): unknown {
  const slot = slots[index];
  return slot?.state === "answered" ? slot.answers[name] : undefined;
}

/** Highest score first, ties broken by line order so a rerun prints the same list. */
export function topByScore(questions: Question[], slots: readonly Slot[], limit: number): number[] {
  const q = scoreQuestion(questions);
  if (!q) return [];
  return answeredIndices(slots)
    .filter((i) => typeof answerOf(slots, i, q.name) === "number")
    .sort((a, b) => {
      const sa = answerOf(slots, a, q.name) as number;
      const sb = answerOf(slots, b, q.name) as number;
      return sb - sa || a - b;
    })
    .slice(0, limit);
}

export function borderlineIndices(questions: Question[], slots: readonly Slot[]): number[] {
  return answeredIndices(slots).filter((i) => {
    const slot = slots[i];
    return slot?.state === "answered" && reviewReasons(questions, slot.answers).length > 0;
  });
}

export type SpotCheck =
  | { kind: "picked"; label: string; pool: number; indices: number[] }
  | { kind: "empty"; label: string };

/**
 * Chosen by hashing the item text, so the same corpus shows the same items on every rerun,
 * at any concurrency, without a seed to pass around.
 */
function pick(indices: number[], texts: readonly (string | undefined)[], limit: number): number[] {
  return indices
    .map((i) => ({
      i,
      h: createHash("sha256")
        .update(SPOT_CHECK_SALT + (texts[i] ?? String(i)))
        .digest("hex"),
    }))
    .sort((a, b) => (a.h < b.h ? -1 : a.h > b.h ? 1 : a.i - b.i))
    .slice(0, limit)
    .map((x) => x.i)
    .sort((a, b) => a - b);
}

/**
 * A false negative lives at the bottom of the ranking, so with a score this samples the low
 * band only and never the merely-unshown middle: the five slots are scarce and the header
 * has to be true as written.
 */
export function spotCheck(
  questions: Question[],
  slots: readonly Slot[],
  texts: readonly (string | undefined)[],
  limit: number,
  exclude: ReadonlySet<number>,
): SpotCheck {
  const eligible = answeredIndices(slots).filter((i) => !exclude.has(i));

  const score = scoreQuestion(questions);
  if (score) {
    const low = eligible.filter((i) => {
      const value = answerOf(slots, i, score.name);
      return typeof value === "number" && value <= LOW_SCORE;
    });
    if (low.length === 0) {
      return {
        kind: "empty",
        label: `nothing scored ${LOW_SCORE} or below — read on from the top instead`,
      };
    }
    const indices = pick(low, texts, limit);
    return {
      kind: "picked",
      pool: low.length,
      indices,
      label: `${indices.length} of the ${low.length} items askq scored ${LOW_SCORE} or below`,
    };
  }

  const bool = questions.find((q) => q.kind === "bool");
  if (bool) {
    const no = eligible.filter((i) => answerOf(slots, i, bool.name) === false);
    if (no.length === 0) {
      return { kind: "empty", label: `nothing was answered ${bool.name}=false` };
    }
    const indices = pick(no, texts, limit);
    return {
      kind: "picked",
      pool: no.length,
      indices,
      label: `${indices.length} of the ${no.length} items askq answered ${bool.name}=false`,
    };
  }

  const choice = questions.find((q) => q.kind === "choice");
  if (choice) {
    // askq cannot know which class the caller cares about, so it samples the biggest one —
    // the likeliest dumping ground — and names it so the reader can judge the choice.
    let best: { value: string; members: number[] } | undefined;
    for (const value of choice.values) {
      const members = eligible.filter((i) => answerOf(slots, i, choice.name) === value);
      if (!best || members.length > best.members.length) best = { value, members };
    }
    if (!best || best.members.length === 0) {
      return { kind: "empty", label: `no class of ${choice.name} has anything in it` };
    }
    const indices = pick(best.members, texts, limit);
    return {
      kind: "picked",
      pool: best.members.length,
      indices,
      label:
        `${indices.length} of the ${best.members.length} items answered ` +
        `${choice.name}=${best.value} (the largest class)`,
    };
  }

  return { kind: "empty", label: "no questions to sample from" };
}

export function snippet(text: string | undefined, width: number): string {
  if (text === undefined) return "";
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= width ? flat : flat.slice(0, width);
}
