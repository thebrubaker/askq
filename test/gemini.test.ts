import { describe, expect, test } from "bun:test";
import { createClient, thinkingConfigFor } from "../src/gemini";

function harness(model: string, responses: (() => Response)[]) {
  const sent: Record<string, unknown>[] = [];
  let i = 0;
  const fetchImpl = (async (_url: string, init: RequestInit) => {
    sent.push(JSON.parse(String(init.body)) as Record<string, unknown>);
    const next = responses[Math.min(i++, responses.length - 1)]!;
    return next();
  }) as unknown as typeof fetch;
  const client = createClient({
    apiKey: "test-key-not-real",
    model,
    fetchImpl,
    sleep: async () => {},
    random: () => 0.5,
  });
  return { client, sent };
}

const answer =
  (parts: { text: string; thought?: boolean }[], usage: Record<string, number> = {}) =>
  () =>
    new Response(
      JSON.stringify({
        candidates: [{ content: { parts }, finishReason: "STOP" }],
        usageMetadata: usage,
      }),
      { status: 200 },
    );
const error = (status: number, message: string) => () =>
  new Response(JSON.stringify({ error: { code: status, message } }), { status });

describe("gemini transport", () => {
  test("3.8 Flash gets thinkingBudget 0, plain text, temperature 0", async () => {
    expect(thinkingConfigFor("gemini-3.8-flash")).toEqual({ thinkingBudget: 0 });
    const { client, sent } = harness("gemini-3.8-flash", [answer([{ text: "ITEMS" }])]);
    await client.call("p");
    expect(sent[0]!.generationConfig).toMatchObject({
      temperature: 0,
      responseMimeType: "text/plain",
      thinkingConfig: { thinkingBudget: 0 },
    });
  });

  test("a 400 is fatal and not retried without the thinking setting", async () => {
    const { client, sent } = harness("gemini-3.8-flash", [
      error(400, "Thinking level MINIMAL is not supported for this model."),
    ]);
    const r = await client.call("p");
    expect(r).toMatchObject({ ok: false, fatal: true });
    expect(sent).toHaveLength(1);
    if (!r.ok) expect(r.reason).toContain('thinkingConfig {"thinkingBudget":0}');
  });

  test("an unknown model is sent no thinking setting at all", async () => {
    const { client, sent } = harness("gemini-9-mystery", [answer([{ text: "ok" }])]);
    await client.call("p");
    expect((sent[0]!.generationConfig as Record<string, unknown>).thinkingConfig).toBeUndefined();
    expect(client.thinking).toBeUndefined();
  });

  test("a 503 is retried; thought parts are not answer text; thought tokens are counted", async () => {
    const { client, sent } = harness("gemini-3.8-flash", [
      error(503, "overloaded"),
      answer([{ text: "thinking...", thought: true }, { text: "ITEMS\ni001 r x: y" }], {
        promptTokenCount: 10,
        candidatesTokenCount: 5,
        thoughtsTokenCount: 7,
      }),
    ]);
    const r = await client.call("p");
    expect(sent).toHaveLength(2);
    expect(r).toMatchObject({
      ok: true,
      text: "ITEMS\ni001 r x: y",
      attempts: 2,
      usage: { in: 10, out: 5, thoughts: 7 },
    });
  });

  test("an aborted call reports interrupted, not an error to retry", async () => {
    const controller = new AbortController();
    const fetchImpl = ((_u: string, init: RequestInit) =>
      new Promise((_resolve, reject) => {
        init.signal?.addEventListener("abort", () => reject(new Error("aborted")));
        controller.abort();
      })) as unknown as typeof fetch;
    const client = createClient({
      apiKey: "k",
      model: "gemini-3.8-flash",
      fetchImpl,
      sleep: async () => {},
    });
    expect(await client.call("p", controller.signal)).toMatchObject({
      ok: false,
      fatal: false,
      reason: "interrupted",
    });
  });
});
