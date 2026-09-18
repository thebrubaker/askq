import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cacheKey, defaultCacheDir, openCache } from "../src/cache";
import type { Question } from "../src/questions";

const questions: Question[] = [
  { kind: "bool", name: "substantive", text: "Reports a measurement?" },
  { kind: "score", name: "substantive_score", text: "0 = none, 10 = a hard number." },
];

const base = { model: "gemini-3.5-flash-lite", questions, why: false, text: "an item" };

const dirs: string[] = [];
const tempDir = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "askq-cache-"));
  dirs.push(dir);
  return dir;
};
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

describe("the key misses on anything that could change the answer", () => {
  test("the same inputs hit", () => {
    expect(cacheKey(base)).toBe(cacheKey({ ...base, questions: [...questions] }));
  });

  test("a changed question wording misses", () => {
    const reworded: Question[] = [
      { kind: "bool", name: "substantive", text: "Reports a measurement, or promotion?" },
      questions[1] as Question,
    ];
    expect(cacheKey({ ...base, questions: reworded })).not.toBe(cacheKey(base));
  });

  test("a changed model misses", () => {
    expect(cacheKey({ ...base, model: "gemini-2.5-flash-lite" })).not.toBe(cacheKey(base));
  });

  test("a changed item misses", () => {
    expect(cacheKey({ ...base, text: "a different item" })).not.toBe(cacheKey(base));
  });

  test("changed choice values miss even when the wording is identical", () => {
    const a: Question[] = [{ kind: "choice", name: "stance", text: "?", values: ["a", "b"] }];
    const b: Question[] = [{ kind: "choice", name: "stance", text: "?", values: ["a", "c"] }];
    expect(cacheKey({ ...base, questions: a })).not.toBe(cacheKey({ ...base, questions: b }));
  });

  test("turning on --why misses", () => {
    expect(cacheKey({ ...base, why: true })).not.toBe(cacheKey(base));
  });

  test("adding a question misses", () => {
    const more = [...questions, { kind: "bool", name: "extra", text: "?" } as Question];
    expect(cacheKey({ ...base, questions: more })).not.toBe(cacheKey(base));
  });
});

describe("the store", () => {
  test("a put is readable, and an unknown key is a miss", () => {
    const cache = openCache(tempDir());
    const key = cacheKey(base);

    expect(cache.get(key)).toBeUndefined();
    cache.put(key, { answers: { substantive: true }, usage: { in: 10, out: 5 } });

    expect(cache.get(key)).toEqual({
      answers: { substantive: true },
      usage: { in: 10, out: 5 },
    });
  });

  test("entries are sharded and do not store the item text", () => {
    const dir = tempDir();
    const cache = openCache(dir);
    const key = cacheKey(base);
    cache.put(key, { answers: { substantive: true }, usage: { in: 1, out: 1 } });

    const shards = readdirSync(dir);
    expect(shards).toEqual([key.slice(0, 2)]);
    const contents = readdirSync(join(dir, key.slice(0, 2)));
    expect(contents).toEqual([`${key}.json`]);
    const raw = require("node:fs").readFileSync(join(dir, key.slice(0, 2), `${key}.json`), "utf8");
    expect(raw).not.toContain("an item");
  });

  test("a corrupt entry is a miss, not a crash", () => {
    const dir = tempDir();
    const cache = openCache(dir);
    const key = cacheKey(base);
    cache.put(key, { answers: { substantive: true }, usage: { in: 1, out: 1 } });
    writeFileSync(join(dir, key.slice(0, 2), `${key}.json`), "{ not json");

    expect(cache.get(key)).toBeUndefined();
  });

  test("an unwritable directory does not fail the run", () => {
    const cache = openCache("/dev/null/askq-cannot-exist");
    expect(() =>
      cache.put("a".repeat(64), { answers: {}, usage: { in: 0, out: 0 } }),
    ).not.toThrow();
    expect(cache.get("a".repeat(64))).toBeUndefined();
  });
});

describe("the default location", () => {
  test("honors XDG_CACHE_HOME", () => {
    expect(defaultCacheDir({ XDG_CACHE_HOME: "/tmp/xdg" } as NodeJS.ProcessEnv)).toBe(
      "/tmp/xdg/askq",
    );
  });

  test("falls back to ~/.cache", () => {
    expect(defaultCacheDir({} as NodeJS.ProcessEnv)).toMatch(/\.cache\/askq$/);
  });
});
