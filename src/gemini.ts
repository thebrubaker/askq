export type Usage = { in: number; out: number; thoughts: number };

export type CallResult =
  | { ok: true; text: string; finishReason: string; usage: Usage; attempts: number; ms: number }
  | { ok: false; fatal: boolean; reason: string; attempts: number };

export type Client = {
  readonly model: string;
  readonly thinking: Record<string, unknown> | undefined;
  call(prompt: string, signal?: AbortSignal): Promise<CallResult>;
};

export type ClientOptions = {
  apiKey: string;
  model: string;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
  now?: () => number;
  maxAttempts?: number;
  baseUrl?: string;
  timeoutMs?: number;
  maxOutputTokens?: number;
  onRetry?: (reason: string) => void;
};

const RETRYABLE_STATUS = new Set([408, 429, 500, 502, 503, 504]);
const DEFAULT_BASE = "https://generativelanguage.googleapis.com/v1beta/models";

const THINKING: Record<string, Record<string, unknown>> = {
  "gemini-3.8-flash": { thinkingBudget: 0 },
  "gemini-3.5-flash-lite": { thinkingLevel: "minimal" },
  "gemini-2.5-flash": { thinkingBudget: 0 },
  "gemini-2.5-flash-lite": { thinkingBudget: 0 },
};

export function thinkingConfigFor(model: string): Record<string, unknown> | undefined {
  return THINKING[model];
}

type Raw =
  | { kind: "http"; status: number; body: unknown; retryAfterMs?: number | undefined }
  | { kind: "network"; reason: string }
  | { kind: "aborted" };

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

function linked(
  signal: AbortSignal | undefined,
  timeoutMs: number,
): { signal: AbortSignal; done: () => void } {
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(new Error(`no answer after ${timeoutMs / 1000}s`)),
    timeoutMs,
  );
  const onAbort = () => controller.abort(signal?.reason);
  if (signal?.aborted) controller.abort(signal.reason);
  else signal?.addEventListener("abort", onAbort, { once: true });
  return {
    signal: controller.signal,
    done: () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    },
  };
}

export function createClient(options: ClientOptions): Client {
  const {
    apiKey,
    model,
    fetchImpl = fetch,
    sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms)),
    random = Math.random,
    now = () => Date.now(),
    maxAttempts = 3,
    baseUrl = DEFAULT_BASE,
    timeoutMs = 300_000,
    maxOutputTokens = 32_768,
    onRetry = () => {},
  } = options;

  const thinking = thinkingConfigFor(model);
  const url = `${baseUrl}/${model}:generateContent`;

  async function post(prompt: string, outer: AbortSignal | undefined): Promise<Raw> {
    const body = {
      contents: [{ role: "user", parts: [{ text: prompt }] }],
      generationConfig: {
        temperature: 0,
        maxOutputTokens,
        responseMimeType: "text/plain",
        ...(thinking ? { thinkingConfig: thinking } : {}),
      },
    };
    const { signal, done } = linked(outer, timeoutMs);
    try {
      const res = await fetchImpl(url, {
        method: "POST",
        headers: { "x-goog-api-key": apiKey, "content-type": "application/json" },
        body: JSON.stringify(body),
        signal,
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
      if (outer?.aborted) return { kind: "aborted" };
      if (signal.aborted)
        return { kind: "network", reason: String((signal.reason as Error)?.message ?? "timeout") };
      const cause = (e as { cause?: { code?: string } }).cause?.code;
      return { kind: "network", reason: cause ?? (e as Error).message ?? "network error" };
    } finally {
      done();
    }
  }

  function readText(body: unknown): { text: string; finishReason: string } {
    const candidate = (body as { candidates?: unknown[] } | null)?.candidates?.[0] as
      | { content?: { parts?: { text?: unknown; thought?: unknown }[] }; finishReason?: unknown }
      | undefined;
    const text = (candidate?.content?.parts ?? [])
      .filter((p) => p.thought !== true)
      .map((p) => (typeof p.text === "string" ? p.text : ""))
      .join("");
    return { text, finishReason: String(candidate?.finishReason ?? "none") };
  }

  function usageOf(body: unknown): Usage {
    const u = (body as { usageMetadata?: Record<string, unknown> } | null)?.usageMetadata ?? {};
    const num = (v: unknown) => (typeof v === "number" ? v : 0);
    return {
      in: num(u.promptTokenCount),
      out: num(u.candidatesTokenCount),
      thoughts: num(u.thoughtsTokenCount),
    };
  }

  async function backoff(attempt: number, retryAfterMs: number | undefined): Promise<void> {
    if (retryAfterMs !== undefined) return sleep(retryAfterMs);
    const base = Math.min(1000 * 2 ** (attempt - 1), 8000);
    await sleep(Math.round(base * (0.8 + 0.4 * random())));
  }

  return {
    model,
    thinking,
    async call(prompt, signal) {
      let attempts = 0;
      let last = "unknown error";
      const started = now();
      while (attempts < maxAttempts) {
        attempts++;
        const raw = await post(prompt, signal);
        if (raw.kind === "aborted")
          return { ok: false, fatal: false, reason: "interrupted", attempts };
        if (raw.kind === "network") {
          last = `network: ${raw.reason}`;
        } else if (raw.status === 200) {
          const read = readText(raw.body);
          if (read.text.trim().length > 0) {
            return { ok: true, ...read, usage: usageOf(raw.body), attempts, ms: now() - started };
          }
          last = `empty answer (finishReason ${read.finishReason})`;
        } else if (RETRYABLE_STATUS.has(raw.status)) {
          last = `http ${raw.status}${messageOf(raw.body) ? `: ${messageOf(raw.body)}` : ""}`;
          if (attempts < maxAttempts) {
            onRetry(last);
            await backoff(attempts, raw.retryAfterMs);
          }
          continue;
        } else {
          const message = messageOf(raw.body) || `http ${raw.status}`;
          const hint = thinking
            ? ` (sent thinkingConfig ${JSON.stringify(thinking)} for ${model})`
            : "";
          return {
            ok: false,
            fatal: true,
            reason: `http ${raw.status}: ${message}${hint}`,
            attempts,
          };
        }
        if (attempts < maxAttempts) {
          onRetry(last);
          await backoff(attempts, undefined);
        }
      }
      return { ok: false, fatal: false, reason: `${last}, after ${attempts} attempts`, attempts };
    },
  };
}
