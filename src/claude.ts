import { spawn, spawnSync } from "node:child_process";
import { accessSync, constants, mkdirSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { UsageError } from "./errors";
import type { CallResult, Client } from "./gemini";

export const CLAUDE_MODEL = "sonnet";
export const HEDGE_FLOOR_MS = 45_000;
export const HARD_STOP_MS = 150_000;
export const DEFAULT_MAX_CALLS = 100;

export const claudeArgs = (model: string) => [
  "-p",
  "--model",
  model,
  "--output-format",
  "json",
  "--safe-mode",
  "--tools",
  "",
  "--strict-mcp-config",
  "--no-session-persistence",
  "--disable-slash-commands",
  "--setting-sources",
  "",
  "--settings",
  JSON.stringify({ alwaysThinkingEnabled: false }),
  "--system-prompt",
  "You answer the user directly.",
];

const executable = (p: string) => {
  try {
    accessSync(p, constants.X_OK);
    return true;
  } catch {
    return false;
  }
};

export function findClaude(env: NodeJS.ProcessEnv = process.env): string | undefined {
  if (env.ASKQ_CLAUDE_BIN) return executable(env.ASKQ_CLAUDE_BIN) ? env.ASKQ_CLAUDE_BIN : undefined;
  const onPath = (env.PATH ?? "").split(delimiter).filter(Boolean).map((d) => join(d, "claude"));
  const home = env.HOME ?? homedir();
  const known = [join(home, ".local", "bin", "claude"), join(home, ".claude", "local", "claude")];
  return [...onPath, ...known].find(executable);
}

export function checkClaude(env: NodeJS.ProcessEnv = process.env): string {
  const bin = findClaude(env);
  if (!bin) {
    throw new UsageError(
      env.ASKQ_CLAUDE_BIN
        ? `ASKQ_CLAUDE_BIN is ${env.ASKQ_CLAUDE_BIN}, which is not an executable: point it at the claude CLI, ` +
            "or use --backend gemini with GEMINI_API_KEY"
        : "askq runs on Claude Code's claude CLI, and it is not installed: install Claude Code and sign in " +
            "(claude auth login), or use --backend gemini with GEMINI_API_KEY",
    );
  }
  const r = spawnSync(bin, ["auth", "status", "--json"], {
    encoding: "utf8",
    timeout: 30_000,
    cwd: scratchDir(),
  });
  let status: { loggedIn?: unknown } | undefined;
  try {
    status = JSON.parse(r.stdout);
  } catch {
    status = undefined;
  }
  if (status?.loggedIn !== true) {
    throw new UsageError(
      `the claude CLI at ${bin} is not signed in` +
        (status ? "" : ` (claude auth status said: ${(r.stdout || r.stderr || String(r.error ?? "")).trim().slice(0, 160)})`) +
        ": run claude auth login, or use --backend gemini with GEMINI_API_KEY",
    );
  }
  return bin;
}

function scratchDir(): string {
  const dir = join(tmpdir(), "askq-claude");
  mkdirSync(dir, { recursive: true });
  return dir;
}

type Shot =
  | { ok: true; text: string; ms: number; usage: { in: number; out: number }; stop: string }
  | { ok: false; reason: string; limit: boolean; killed: boolean };

const LIMIT = /usage limit|rate limit|limit reached|too many requests|overloaded/i;

function shoot(bin: string, model: string, prompt: string, signal: AbortSignal): Promise<Shot> {
  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn(bin, claudeArgs(model), { cwd: scratchDir(), stdio: ["pipe", "pipe", "pipe"] });
    let out = "";
    let err = "";
    let killed = false;
    const kill = () => {
      killed = true;
      child.kill();
    };
    if (signal.aborted) kill();
    else signal.addEventListener("abort", kill, { once: true });
    child.stdout.setEncoding("utf8").on("data", (d: string) => (out += d));
    child.stderr.setEncoding("utf8").on("data", (d: string) => (err += d));
    child.stdin.on("error", () => {});
    child.stdin.end(prompt);
    child.on("error", (e) => resolve({ ok: false, reason: `could not start claude: ${e.message}`, limit: false, killed }));
    child.on("close", (code) => {
      signal.removeEventListener("abort", kill);
      if (killed) return resolve({ ok: false, reason: "stopped", limit: false, killed: true });
      let events: unknown;
      try {
        events = JSON.parse(out);
      } catch {
        events = undefined;
      }
      const list = (Array.isArray(events) ? events : events ? [events] : []) as Record<string, unknown>[];
      const r = list.find((e) => e.type === "result") as
        | { subtype?: string; is_error?: boolean; result?: unknown; stop_reason?: string; usage?: Record<string, number> }
        | undefined;
      const text = typeof r?.result === "string" ? r.result : "";
      if (code === 0 && r && r.subtype === "success" && !r.is_error) {
        const u = r.usage ?? {};
        return resolve({
          ok: true,
          text,
          ms: Date.now() - started,
          usage: {
            in: (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0),
            out: u.output_tokens ?? 0,
          },
          stop: r.stop_reason ?? "",
        });
      }
      const said = (text || err || out).trim().replace(/\s+/g, " ").slice(0, 200);
      resolve({
        ok: false,
        reason: `claude exited ${code}${r?.subtype ? ` (${r.subtype})` : ""}${said ? `: ${said}` : ""}`,
        limit: LIMIT.test(said),
        killed: false,
      });
    });
  });
}

export type ClaudeOptions = {
  bin: string;
  model?: string;
  maxCalls?: number;
  hedgeFloorMs?: number;
  hardStopMs?: number;
  onHedge?: (why: string) => void;
};

export type ClaudeClient = Client & { readonly spawned: number; readonly hedges: number };

export function hedgeAfter(finished: readonly number[], floor = HEDGE_FLOOR_MS): number {
  const s = [...finished].sort((a, b) => a - b);
  const median = s.length === 0 ? 0 : s[Math.floor((s.length - 1) / 2)]!;
  return Math.max(floor, 2 * median);
}

export function createClaudeClient(o: ClaudeOptions): ClaudeClient {
  const model = o.model ?? CLAUDE_MODEL;
  const maxCalls = o.maxCalls ?? DEFAULT_MAX_CALLS;
  const floor = o.hedgeFloorMs ?? HEDGE_FLOOR_MS;
  const hardStop = o.hardStopMs ?? HARD_STOP_MS;
  const finished: number[] = [];
  let spawned = 0;
  let hedges = 0;

  const wait = (ms: number) =>
    new Promise<"late">((r) => {
      const t = setTimeout(() => r("late"), ms);
      t.unref?.();
    });

  const call = async (prompt: string, signal?: AbortSignal): Promise<CallResult> => {
    if (signal?.aborted) return { ok: false, fatal: false, reason: "interrupted", attempts: 0 };
    if (spawned >= maxCalls) {
      return { ok: false, fatal: false, reason: `the --max-calls cap of ${maxCalls} was reached`, attempts: 0 };
    }
    const started = Date.now();
    const controls: AbortController[] = [];
    const onOuter = () => controls.forEach((c) => c.abort());
    signal?.addEventListener("abort", onOuter, { once: true });
    const launch = (k: number) => {
      const c = new AbortController();
      controls.push(c);
      spawned++;
      return shoot(o.bin, model, prompt, c.signal).then((s) => ({ k, s }));
    };
    const done = (s: Shot, attempts: number): CallResult => {
      signal?.removeEventListener("abort", onOuter);
      controls.forEach((c) => c.abort());
      if (s.ok) {
        finished.push(s.ms);
        return {
          ok: true,
          text: s.text,
          finishReason: s.stop,
          usage: { in: s.usage.in, out: s.usage.out, thoughts: 0 },
          attempts,
          ms: Date.now() - started,
        };
      }
      if (signal?.aborted) return { ok: false, fatal: false, reason: "interrupted", attempts };
      return { ok: false, fatal: s.limit, reason: s.reason, attempts };
    };

    const hedgeAt = hedgeAfter(finished, floor);
    const first = launch(0);
    const r0 = await Promise.race([first, wait(hedgeAt)]);
    const left = () => Math.max(0, hardStop - (Date.now() - started));
    const canSpawn = () => spawned < maxCalls && !signal?.aborted;
    const timedOut: Shot = {
      ok: false,
      reason: `no answer after ${Math.round(hardStop / 1000)}s`,
      limit: false,
      killed: false,
    };

    if (r0 !== "late" && (r0.s.ok || r0.s.limit || !canSpawn())) return done(r0.s, 1);
    if (r0 !== "late" && !r0.s.ok) {
      hedges++;
      o.onHedge?.(`retrying a failed call: ${r0.s.reason}`);
      const r1 = await Promise.race([launch(1), wait(left())]);
      return done(r1 === "late" ? timedOut : r1.s, 2);
    }
    if (!canSpawn()) {
      const r = await Promise.race([first, wait(left())]);
      return done(r === "late" ? timedOut : r.s, 1);
    }
    hedges++;
    o.onHedge?.(`a call passed ${Math.round(hedgeAt / 1000)}s; sending a duplicate and taking whichever answers first`);
    const pending = new Map([
      [0, first],
      [1, launch(1)],
    ]);
    let last: Shot = timedOut;
    const deadline = wait(left());
    while (pending.size > 0) {
      const r = await Promise.race([...pending.values(), deadline]);
      if (r === "late") return done(timedOut, 2);
      pending.delete(r.k);
      last = r.s;
      if (r.s.ok) return done(r.s, 2);
    }
    return done(last, 2);
  };

  return {
    model,
    thinking: { alwaysThinkingEnabled: false },
    call,
    get spawned() {
      return spawned;
    },
    get hedges() {
      return hedges;
    },
  };
}
