import { describe, expect, test } from "bun:test";
import { createClient, thinkingConfigFor } from "../src/gemini";
import { buildSchema } from "../src/schema";

const schema = buildSchema([{ kind: "bool", name: "substantive", text: "is it?" }]);

type Sent = { body: Record<string, unknown> };

function harness(responses: (() => Response | Promise<Response>)[]) {
  const sent: Sent[] = [];
  const sleeps: number[] = [];
  let i = 0;
  const fetchImpl = (async (_url: string, init: RequestInit) => {
    sent.push({ body: JSON.parse(String(init.body)) as Record<string, unknown> });
    const next = responses[Math.min(i, responses.length - 1)];
    i++;
    if (!next) throw new Error("no response configured");
    return next();
  }) as unknown as typeof fetch;
  const warnings: string[] = [];
  let rateLimits = 0;
  const client = createClient({
    apiKey: "test-key-not-real",
    model: "gemini-3.5-flash-lite",
    fetchImpl,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    random: () => 0.5,
    onWarn: (m) => warnings.push(m),
    onRateLimit: () => rateLimits++,
  });
  return { client, sent, sleeps, warnings, rateLimits: () => rateLimits };
}

const answer = (text: string, usage = { promptTokenCount: 20, candidatesTokenCount: 4 }) =>
  new Response(
    JSON.stringify({
      candidates: [{ content: { parts: [{ text }] }, finishReason: "STOP" }],
      usageMetadata: usage,
    }),
    { status: 200 },
  );

const error = (status: number, message: string, extra: Record<string, unknown> = {}) =>
  new Response(JSON.stringify({ error: { code: status, message, ...extra } }), { status });

describe("thinking control", () => {
  test("the field differs per model family, as measured", () => {
    expect(thinkingConfigFor("gemini-3.5-flash-lite")).toEqual({ thinkingLevel: "minimal" });
    expect(thinkingConfigFor("gemini-3.8-flash")).toEqual({ thinkingLevel: "minimal" });
    expect(thinkingConfigFor("gemini-flash-lite-latest")).toEqual({ thinkingLevel: "minimal" });
    expect(thinkingConfigFor("gemini-2.5-flash-lite")).toEqual({ thinkingBudget: 0 });
    expect(thinkingConfigFor("some-other-model")).toBeUndefined();
  });

  test("the measured nameless 400 still drops the thinking field and retries", async () => {
    // Verbatim message returned by gemini-3.5-flash-lite for thinkingBudget:0 on 2026-09-18.
    // It names nothing, so message matching would have missed the case that actually happens.
    let n = 0;
    const h = harness([
      () => {
        n++;
        return n === 1
          ? error(400, "Request contains an invalid argument.")
          : answer('{"substantive":"true"}');
      },
    ]);

    const result = await h.client.call("q", schema);

    expect(result.ok).toBe(true);
    expect(h.warnings).toHaveLength(1);
    expect(h.sent[0]?.body.generationConfig).toMatchObject({
      thinkingConfig: { thinkingLevel: "minimal" },
    });
    expect(h.sent[1]?.body.generationConfig).not.toHaveProperty("thinkingConfig");

    // The warning is printed once per run, not once per item.
    await h.client.call("q", schema);
    expect(h.warnings).toHaveLength(1);
  });

  test("a 400 that survives dropping the thinking field is fatal, with the clearer message", async () => {
    const h = harness([
      () => error(400, "Request contains an invalid argument."),
      () => error(400, "Invalid JSON payload received. Unknown name 'responseSchemaX'"),
    ]);

    const result = await h.client.call("q", schema);

    expect(result).toMatchObject({ ok: false, kind: "fatal" });
    expect(result.ok === false && result.reason).toContain("responseSchemaX");
    expect(h.sent).toHaveLength(2);
  });
});

describe("error classification", () => {
  test("a 400 is fatal after at most one thinking-drop retry — never the whole budget", async () => {
    const h = harness([() => error(400, "Logprobs is not enabled for this model")]);

    const result = await h.client.call("q", schema);

    expect(result).toMatchObject({ ok: false, kind: "fatal", attempts: 2 });
    expect(h.sent).toHaveLength(2);
  });

  test("a 503 is retried with backoff and can still succeed", async () => {
    let n = 0;
    const h = harness([
      () => {
        n++;
        return n <= 2 ? error(503, "overloaded") : answer('{"substantive":"true"}');
      },
    ]);

    const result = await h.client.call("q", schema);

    expect(result.ok).toBe(true);
    expect(result.attempts).toBe(3);
    expect(h.sleeps).toEqual([500, 1000]);
  });

  test("a permanent 503 becomes a named item failure after the attempt budget", async () => {
    const h = harness([() => error(503, "overloaded")]);

    const result = await h.client.call("q", schema);

    expect(result).toMatchObject({ ok: false, kind: "item" });
    expect(result.ok === false && result.reason).toBe("http 503 after 4 attempts");
    expect(h.sent).toHaveLength(4);
  });

  test("a 429 reports the rate limit and honors the server's retry delay", async () => {
    let n = 0;
    const h = harness([
      () => {
        n++;
        return n === 1
          ? error(429, "quota", { details: [{ retryDelay: "7s" }] })
          : answer('{"substantive":"true"}');
      },
    ]);

    const result = await h.client.call("q", schema);

    expect(result.ok).toBe(true);
    expect(h.rateLimits()).toBe(1);
    expect(h.sleeps).toEqual([7000]);
  });

  test("a network throw is retried, then reported as a failure rather than crashing", async () => {
    const h = harness([
      () => {
        const e = new Error("fetch failed");
        (e as Error & { cause?: unknown }).cause = { code: "ECONNRESET" };
        throw e;
      },
    ]);

    const result = await h.client.call("q", schema);

    expect(result).toMatchObject({ ok: false, kind: "item" });
    expect(result.ok === false && result.reason).toContain("ECONNRESET");
    expect(h.sent).toHaveLength(4);
  });

  test("a blocked candidate is an item failure naming the finish reason", async () => {
    const h = harness([
      () =>
        new Response(JSON.stringify({ candidates: [{ finishReason: "SAFETY" }] }), { status: 200 }),
    ]);

    const result = await h.client.call("q", schema);

    expect(result.ok === false && result.reason).toContain("finishReason SAFETY");
  });

  test("an unparsable body is retried once, then fails the item", async () => {
    const h = harness([() => answer("not json")]);

    const result = await h.client.call("q", schema);

    expect(result.ok === false && result.reason).toBe("answer was not JSON");
    expect(h.sent).toHaveLength(2);
  });
});

describe("the wire", () => {
  test("a success carries the answers and the token usage", async () => {
    const h = harness([() => answer('{"substantive":"true"}')]);

    const result = await h.client.call("q", schema);

    expect(result).toMatchObject({
      ok: true,
      answers: { substantive: "true" },
      usage: { in: 20, out: 4 },
      attempts: 1,
    });
  });

  test("the request pins temperature 0 and the response schema", async () => {
    const h = harness([() => answer('{"substantive":"true"}')]);

    await h.client.call("prompt text", schema);

    expect(h.sent[0]?.body.generationConfig).toMatchObject({
      temperature: 0,
      responseMimeType: "application/json",
      responseSchema: schema,
    });
  });

  test("a thoughtSignature part alongside the text does not break parsing", async () => {
    // Shape recorded from the real API on 2026-09-18 (.scratch/logprobs-spike.md §3).
    const h = harness([
      () =>
        new Response(
          JSON.stringify({
            candidates: [
              {
                content: {
                  parts: [{ text: '{"substantive":"true"}', thoughtSignature: "El4KXAFpFH0T" }],
                  role: "model",
                },
                finishReason: "STOP",
                index: 0,
              },
            ],
            usageMetadata: { promptTokenCount: 20, candidatesTokenCount: 1 },
            modelVersion: "gemini-3.5-flash-lite",
          }),
          { status: 200 },
        ),
    ]);

    const result = await h.client.call("q", schema);

    expect(result).toMatchObject({ ok: true, answers: { substantive: "true" } });
  });
});
