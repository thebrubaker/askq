export const PRICES: Record<string, { in: number; out: number }> = {
  "gemini-3.8-flash": { in: 0.75, out: 3.75 },
  "gemini-3.7-flash": { in: 0.75, out: 3.75 },
  "gemini-3.6-flash": { in: 0.75, out: 3.75 },
  "gemini-3.5-flash": { in: 1.5, out: 9.0 },
  "gemini-3.5-flash-lite": { in: 0.3, out: 2.5 },
  "gemini-3.1-flash-lite": { in: 0.25, out: 1.5 },
  "gemini-2.5-flash": { in: 0.3, out: 2.5 },
  "gemini-2.5-flash-lite": { in: 0.1, out: 0.4 },
};

export const CHARS_PER_TOKEN = 2.6;
export const OUT_TOKENS_PER_POINTER = 16;
export const OUT_TOKENS_FIXED = 600;

export type Estimate = { tokensIn: number; tokensOut: number; usd: number | undefined };

export function costOf(tokensIn: number, tokensOut: number, model: string): number | undefined {
  const price = PRICES[model];
  if (price === undefined) return undefined;
  return (tokensIn * price.in + tokensOut * price.out) / 1_000_000;
}

export function estimate(promptChars: number, pointers: number, model: string): Estimate {
  const tokensIn = Math.ceil(promptChars / CHARS_PER_TOKEN);
  const tokensOut = pointers * OUT_TOKENS_PER_POINTER + OUT_TOKENS_FIXED;
  return { tokensIn, tokensOut, usd: costOf(tokensIn, tokensOut, model) };
}

export function formatUsd(usd: number): string {
  if (usd === 0) return "$0";
  if (usd < 0.01) return `$${usd.toFixed(4)}`;
  return `$${usd.toFixed(2)}`;
}
