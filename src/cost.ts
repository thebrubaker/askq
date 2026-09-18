import type { Question } from "./questions";

/**
 * USD per million tokens, from ai.google.dev/gemini-api/docs/pricing, read 2026-09-18.
 * The 3.x Flash line steps up on 2027-01-01 ($0.75/$3.75 becomes $1.50/$7.50).
 */
export const PRICES: Record<string, { in: number; out: number }> = {
  "gemini-3.5-flash-lite": { in: 0.3, out: 2.5 },
  "gemini-3.1-flash-lite": { in: 0.25, out: 1.5 },
  "gemini-2.5-flash-lite": { in: 0.1, out: 0.4 },
  "gemini-3.5-flash": { in: 1.5, out: 9.0 },
  "gemini-3.8-flash": { in: 0.75, out: 3.75 },
  "gemini-3.7-flash": { in: 0.75, out: 3.75 },
  "gemini-3.6-flash": { in: 0.75, out: 3.75 },
  "gemini-2.5-flash": { in: 0.3, out: 2.5 },
};

/**
 * Calibrated against the 67-item run of 2026-09-18: 43,106 prompt characters produced
 * 10,711 prompt tokens (4.02 chars per token), and three questions produced 33.4 output
 * tokens per item. A reason adds roughly a 15-word sentence.
 */
export const CHARS_PER_TOKEN = 4;
export const TOKENS_PER_ANSWER = 11;
export const TOKENS_PER_REASON = 23;
export const TOKENS_PER_RECORD = 4;

export type Estimate = { tokensIn: number; tokensOut: number; usd: number | undefined };

export function costOf(tokensIn: number, tokensOut: number, model: string): number | undefined {
  const price = PRICES[model];
  if (price === undefined) return undefined;
  return (tokensIn * price.in) / 1_000_000 + (tokensOut * price.out) / 1_000_000;
}

export function estimate(
  promptChars: number[],
  questions: Question[],
  why: boolean,
  model: string,
): Estimate {
  const tokensIn = promptChars.reduce((sum, chars) => sum + Math.ceil(chars / CHARS_PER_TOKEN), 0);
  const perItem =
    questions.length * (TOKENS_PER_ANSWER + (why ? TOKENS_PER_REASON : 0)) + TOKENS_PER_RECORD;
  const tokensOut = promptChars.length * perItem;
  return { tokensIn, tokensOut, usd: costOf(tokensIn, tokensOut, model) };
}
