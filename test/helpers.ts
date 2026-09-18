import type { Cache, CacheEntry } from "../src/cache";
import type { CallResult, Client } from "../src/gemini";
import type { RunDeps } from "../src/runner";

export function clientFrom(fn: (prompt: string, index: number) => unknown): Client {
  let index = 0;
  return {
    call: async (prompt) => {
      const result = await fn(prompt, index++);
      return result as CallResult;
    },
  };
}

export function ok(answers: Record<string, unknown>, tokens = { in: 10, out: 5 }): CallResult {
  return { ok: true, answers, usage: tokens, attempts: 1 };
}

export function itemFailure(reason: string): CallResult {
  return { ok: false, kind: "item", reason, attempts: 4 };
}

export function fatal(reason: string): CallResult {
  return { ok: false, kind: "fatal", reason, attempts: 1 };
}

export type Captured = {
  out: string[];
  err: string[];
  deps: RunDeps;
};

export function capture(client: Client): Captured {
  const out: string[] = [];
  const err: string[] = [];
  let clock = 0;
  return {
    out,
    err,
    deps: {
      client,
      stdout: (line) => {
        out.push(line);
      },
      stderr: (line) => {
        err.push(line);
      },
      now: () => (clock += 1000),
    },
  };
}

export function jsonl(items: Record<string, unknown>[]): string {
  return items.map((i) => JSON.stringify(i)).join("\n") + "\n";
}

export function memoryCache(): { get: Cache["get"]; put: Cache["put"]; size: () => number } {
  const store = new Map<string, CacheEntry>();
  return {
    get: (key) => store.get(key),
    put: (key, entry) => {
      store.set(key, entry);
    },
    size: () => store.size,
  };
}

/** Synthetic items only: no scraped third-party text may enter this repository. */
export function syntheticItems(n: number): Record<string, unknown>[] {
  return Array.from({ length: n }, (_, i) => ({
    id: i + 1,
    txt: `synthetic item ${i + 1}: shipped a ${i + 1}% improvement in build time`,
  }));
}
