import { describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkClaude, createClaudeClient, hedgeAfter } from "../src/claude";

const RESULT = (text: string) =>
  JSON.stringify({
    type: "result",
    subtype: "success",
    is_error: false,
    result: text,
    num_turns: 1,
    usage: { input_tokens: 10, output_tokens: 3 },
  });

// A stand-in for the claude CLI: `first` is what its first call does, `later` what every later one does.
type Act = { sleep?: number; fail?: string; text?: string };
function fakeClaude(first: Act, later: Act = { text: "later answer" }, auth = '{"loggedIn": true}') {
  const dir = mkdtempSync(join(tmpdir(), "askq-fake-claude-"));
  const calls = join(dir, "calls");
  writeFileSync(calls, "");
  const act = (a: Act) =>
    [
      a.sleep ? `sleep ${a.sleep}` : "",
      a.fail
        ? `echo '${JSON.stringify({ type: "result", subtype: "error_during_execution", is_error: true, result: a.fail })}'; exit 1`
        : `echo '${RESULT(a.text ?? "first answer")}'`,
    ].join("\n");
  const bin = join(dir, "claude");
  writeFileSync(
    bin,
    [
      "#!/bin/bash",
      `if [ "$1" = auth ]; then echo '${auth}'; exit 0; fi`,
      "cat > /dev/null",
      `echo x >> ${calls}`,
      `if mkdir ${join(dir, "first")} 2>/dev/null; then`,
      act(first),
      "else",
      act(later),
      "fi",
    ].join("\n"),
  );
  chmodSync(bin, 0o755);
  return { bin, spawned: () => readFileSync(calls, "utf8").split("\n").filter(Boolean).length };
}

describe("claude client", () => {
  test("a call that answers in time is sent once", async () => {
    const f = fakeClaude({ text: "one answer" });
    const c = createClaudeClient({ bin: f.bin, hedgeFloorMs: 2_000 });
    const r = await c.call("prompt");
    expect(r.ok && r.text).toBe("one answer");
    expect(c.spawned).toBe(1);
    expect(c.hedges).toBe(0);
  });

  test("a call past the hedge time gets one duplicate, and the first good answer wins", async () => {
    const f = fakeClaude({ sleep: 8, text: "slow" }, { text: "duplicate" });
    const hedged: string[] = [];
    const c = createClaudeClient({ bin: f.bin, hedgeFloorMs: 300, onHedge: (w) => hedged.push(w) });
    const t = Date.now();
    const r = await c.call("prompt");
    expect(r.ok && r.text).toBe("duplicate");
    expect(r.attempts).toBe(2);
    expect(Date.now() - t).toBeLessThan(6_000);
    expect(c.hedges).toBe(1);
    expect(hedged[0]).toContain("sending a duplicate");
  }, 20_000);

  test("a call that fails fast is sent once more", async () => {
    const f = fakeClaude({ fail: "something broke" }, { text: "second try" });
    const c = createClaudeClient({ bin: f.bin, hedgeFloorMs: 2_000 });
    const r = await c.call("prompt");
    expect(r.ok && r.text).toBe("second try");
    expect(f.spawned()).toBe(2);
  });

  test("a usage limit is fatal and not retried", async () => {
    const f = fakeClaude({ fail: "Claude usage limit reached" });
    const c = createClaudeClient({ bin: f.bin, hedgeFloorMs: 2_000 });
    const r = await c.call("prompt");
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.fatal).toBe(true);
      expect(r.reason).toContain("usage limit");
    }
    expect(f.spawned()).toBe(1);
  });

  test("the hard stop fails the call when neither copy answers", async () => {
    const f = fakeClaude({ sleep: 8 }, { sleep: 8 });
    const c = createClaudeClient({ bin: f.bin, hedgeFloorMs: 200, hardStopMs: 800 });
    const t = Date.now();
    const r = await c.call("prompt");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("no answer after 1s");
    expect(Date.now() - t).toBeLessThan(6_000);
  }, 20_000);

  test("the hedge time is twice the median of finished calls, never under the floor", () => {
    expect(hedgeAfter([], 45_000)).toBe(45_000);
    expect(hedgeAfter([10_000, 20_000, 30_000], 45_000)).toBe(45_000);
    expect(hedgeAfter([20_000, 40_000, 30_000], 45_000)).toBe(60_000);
    expect(hedgeAfter([20_000, 30_000, 40_000, 90_000], 45_000)).toBe(60_000);
  });

  test("--max-calls: no call and no duplicate past the cap", async () => {
    const f = fakeClaude({ sleep: 1, text: "slow" }, { text: "never" });
    const c = createClaudeClient({ bin: f.bin, maxCalls: 1, hedgeFloorMs: 100 });
    const r = await c.call("prompt");
    expect(r.ok && r.text).toBe("slow");
    const refused = await c.call("prompt");
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.reason).toBe("the --max-calls cap of 1 was reached");
    expect(f.spawned()).toBe(1);
  });
});

describe("claude CLI check", () => {
  test("a missing CLI says so and names the way out", () => {
    expect(() => checkClaude({ PATH: "/nonexistent", HOME: "/nonexistent" })).toThrow(
      "not installed: install Claude Code and sign in (claude auth login), or use --backend gemini",
    );
    expect(() => checkClaude({ ASKQ_CLAUDE_BIN: "/nonexistent/claude" })).toThrow(
      "ASKQ_CLAUDE_BIN is /nonexistent/claude, which is not an executable",
    );
  });

  test("a CLI that is not signed in says so", () => {
    const f = fakeClaude({}, {}, '{"loggedIn": false}');
    expect(() => checkClaude({ ASKQ_CLAUDE_BIN: f.bin })).toThrow(
      `the claude CLI at ${f.bin} is not signed in: run claude auth login`,
    );
  });

  test("a signed-in CLI passes and is the one askq uses", () => {
    const f = fakeClaude({});
    expect(checkClaude({ ASKQ_CLAUDE_BIN: f.bin })).toBe(f.bin);
  });
});
