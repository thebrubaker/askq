import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { PROMPT_VERSION } from "./prompt";
import type { Question } from "./questions";
import { allowedValues } from "./schema";

export type CacheEntry = { answers: Record<string, unknown>; usage: { in: number; out: number } };

export type Cache = {
  get(key: string): CacheEntry | undefined;
  put(key: string, entry: CacheEntry): void;
};

export type KeyInput = {
  model: string;
  questions: Question[];
  why: boolean;
  text: string;
};

/**
 * Everything that can change an answer goes in the key. A cache that can serve an answer
 * for a question that has since been reworded is the quiet-wrong-result failure this tool
 * exists to avoid, so the question text and its allowed values are hashed, not just names.
 */
export function cacheKey(input: KeyInput): string {
  const questions = input.questions.map((q) => [q.kind, q.name, q.text, allowedValues(q)]);
  const material = JSON.stringify([PROMPT_VERSION, input.model, input.why, questions, input.text]);
  return createHash("sha256").update(material).digest("hex");
}

export function defaultCacheDir(env: NodeJS.ProcessEnv = process.env): string {
  const base =
    env.XDG_CACHE_HOME && env.XDG_CACHE_HOME.length > 0
      ? env.XDG_CACHE_HOME
      : join(homedir(), ".cache");
  return join(base, "askq");
}

export function openCache(dir: string): Cache {
  return {
    get(key) {
      try {
        const raw = readFileSync(join(dir, key.slice(0, 2), `${key}.json`), "utf8");
        const parsed = JSON.parse(raw) as CacheEntry;
        if (!parsed || typeof parsed !== "object" || typeof parsed.answers !== "object") {
          return undefined;
        }
        return { answers: parsed.answers, usage: parsed.usage ?? { in: 0, out: 0 } };
      } catch {
        // A missing, unreadable or corrupt entry is a miss. A cache must never break a run.
        return undefined;
      }
    },
    put(key, entry) {
      try {
        const shard = join(dir, key.slice(0, 2));
        mkdirSync(shard, { recursive: true });
        const target = join(shard, `${key}.json`);
        const temp = `${target}.${process.pid}.tmp`;
        // The item text is deliberately not stored: the corpus is third-party content and
        // this directory is shared across every project on the machine.
        writeFileSync(temp, JSON.stringify({ ...entry, ts: Date.now() }));
        renameSync(temp, target);
      } catch {
        // A cache that cannot be written is a slower run, not a failed one.
      }
    },
  };
}
