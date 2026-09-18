import type { ResponseSchema } from "./schema";

export type Usage = { in: number; out: number };

export type CallResult =
  | { ok: true; answers: Record<string, unknown>; usage: Usage; attempts: number }
  | { ok: false; kind: "item" | "fatal"; reason: string; attempts: number };

export type Client = {
  call(prompt: string, schema: ResponseSchema): Promise<CallResult>;
};

export type ClientOptions = {
  apiKey: string;
  model: string;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
  maxAttempts?: number;
  baseUrl?: string;
  onWarn?: (message: string) => void;
  onRateLimit?: () => void;
};

const RETRYABLE_STATUS = new Set([408, 429, 500, 502, 503, 504]);
const DEFAULT_BASE = "https://generativelanguage.googleapis.com/v1beta/models";

// Measured 2026-09-18: 3.x rejects thinkingBudget, 2.x rejects thinkingLevel. See
// .scratch/v1-plan.md §4.2 — a wrong field here is a 400 on every item, not a slow run.
export function thinkingConfigFor(model: string): Record<string, unknown> | undefined {
  if (/^gemini-2/.test(model)) return { thinkingBudget: 0 };
  if (/^gemini-(3|flash|pro)/.test(model)) return { thinkingLevel: "minimal" };
  return undefined;
}

type Raw =
  | { kind: "http"; status: number; body: unknown; retryAfterMs?: number }
  | { kind: "network"; reason: string };

function messageOf(body: unknown): string {
  const err = (body as { error?: { message?: unknown } } | null)?.error;
  return typeof err?.message === "string" ? err.message : "";
}

function retryAfterFrom(headers: Headers, body: unknown): number | undefined {
  const header = headers.get("retry-after");
  if (header && /^\d+$/.test(header.trim())) return Number(header.trim()) * 1000;
  const details = (body as { error?: { details?: unknown } } | null)?.error?.details;
  if (Array.isArray(details)) {
    for (const d of details) {
      const delay = (d as { retryDelay?: unknown }).retryDelay;
      if (typeof delay === "string") {
        const m = /^([\d.]+)s$/.exec(delay);
        if (m?.[1]) return Math.round(Number(m[1]) * 1000);
      }
    }
  }
  return undefined;
}

export function createClient(options: ClientOptions): Client {
  const {
    apiKey,
    model,
    fetchImpl = fetch,
    sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms)),
    random = Math.random,
    maxAttempts = 4,
    baseUrl = DEFAULT_BASE,
    onWarn = () => {},
    onRateLimit = () => {},
  } = options;

  let thinking = thinkingConfigFor(model);
  let thinkingWarned = false;
  const url = `${baseUrl}/${model}:generateContent`;

  async function post(prompt: string, schema: ResponseSchema): Promise<Raw> {
    const body = {
      contents: [{ role: "user", parts: [{ text: prompt }] }],
      generationConfig: {
        temperature: 0,
        responseMimeType: "application/json",
        responseSchema: schema,
        ...(thinking ? { thinkingConfig: thinking } : {}),
      },
    };
    try {
      const res = await fetchImpl(url, {
        method: "POST",
        headers: { "x-goog-api-key": apiKey, "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      let parsed: unknown = null;
      try {
        parsed = await res.json();
      } catch {
        parsed = null;
      }
      return {
        kind: "http",
        status: res.status,
        body: parsed,
        retryAfterMs: retryAfterFrom(res.headers, parsed),
      };
    } catch (e) {
      const cause = (e as { cause?: { code?: string } }).cause?.code;
      return { kind: "network", reason: cause ?? (e as Error).message ?? "network error" };
    }
  }

  function readAnswers(
    body: unknown,
  ): { ok: true; answers: Record<string, unknown> } | { ok: false; reason: string } {
    const candidate = (body as { candidates?: unknown[] } | null)?.candidates?.[0] as
      { content?: { parts?: { text?: unknown }[] }; finishReason?: unknown } | undefined;
    if (!candidate) return { ok: false, reason: "no candidate in the response" };
    if (candidate.finishReason !== undefined && candidate.finishReason !== "STOP") {
      return { ok: false, reason: `finishReason ${String(candidate.finishReason)}` };
    }
    const text = (candidate.content?.parts ?? [])
      .map((p) => (typeof p.text === "string" ? p.text : ""))
      .join("");
    if (text.trim().length === 0) return { ok: false, reason: "empty answer" };
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return { ok: false, reason: "answer was not JSON" };
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return { ok: false, reason: "answer was not a JSON object" };
    }
    return { ok: true, answers: parsed as Record<string, unknown> };
  }

  function usageOf(body: unknown): Usage {
    const u = (body as { usageMetadata?: Record<string, unknown> } | null)?.usageMetadata ?? {};
    const num = (v: unknown) => (typeof v === "number" ? v : 0);
    return { in: num(u.promptTokenCount), out: num(u.candidatesTokenCount) };
  }

  async function backoff(attempt: number, retryAfterMs: number | undefined): Promise<void> {
    if (retryAfterMs !== undefined) return sleep(retryAfterMs);
    const base = Math.min(500 * 2 ** (attempt - 1), 8000);
    await sleep(Math.round(base * (0.8 + 0.4 * random())));
  }

  return {
    async call(prompt, schema) {
      let attempts = 0;
      let itemRetried = false;
      let last = "unknown error";

      while (attempts < maxAttempts) {
        attempts++;
        const raw = await post(prompt, schema);

        if (raw.kind === "network") {
          last = `network ${raw.reason}`;
          if (attempts < maxAttempts) {
            await backoff(attempts, undefined);
            continue;
          }
          break;
        }

        if (raw.status === 200) {
          const read = readAnswers(raw.body);
          if (read.ok) {
            return { ok: true, answers: read.answers, usage: usageOf(raw.body), attempts };
          }
          last = read.reason;
          if (!itemRetried && attempts < maxAttempts) {
            itemRetried = true;
            await backoff(attempts, undefined);
            continue;
          }
          return { ok: false, kind: "item", reason: last, attempts };
        }

        const message = messageOf(raw.body) || `http ${raw.status}`;

        // Measured 2026-09-18: gemini-3.5-flash-lite rejects a wrong thinking field with only
        // "Request contains an invalid argument." — the message names nothing. So any 400 with
        // a thinking control set buys one retry without it; a real request error still fails,
        // one ~100ms call later, with the clearer message.
        if (raw.status === 400 && thinking) {
          if (!thinkingWarned) {
            thinkingWarned = true;
            onWarn(
              `${model} rejected the request with a thinking control set (${message}); ` +
                `retrying without it`,
            );
          }
          thinking = undefined;
          continue;
        }

        if (RETRYABLE_STATUS.has(raw.status)) {
          if (raw.status === 429) onRateLimit();
          last = `http ${raw.status}`;
          if (attempts < maxAttempts) {
            await backoff(attempts, raw.retryAfterMs);
            continue;
          }
          break;
        }

        return { ok: false, kind: "fatal", reason: `http ${raw.status}: ${message}`, attempts };
      }

      return { ok: false, kind: "item", reason: `${last} after ${attempts} attempts`, attempts };
    },
  };
}
