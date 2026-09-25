import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { HELP } from "../src/cli";
import { jsonl, posts } from "./helpers";

const ENTRY = join(import.meta.dir, "..", "src", "entry.ts");
const cli = (args: string[], input = "", env: Record<string, string> = {}) =>
  spawnSync("bun", [ENTRY, ...args], {
    input,
    encoding: "utf8",
    env: { ...process.env, GEMINI_API_KEY: "", ...env },
  });

describe("cli", () => {
  test("a v1 flag says what replaced it", () => {
    const r = cli(["--score", "x=0 = no, 10 = yes"]);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("--score was askq 0.1");
    expect(r.stderr).toContain('askq "which of these should I read for X?" < items.jsonl');
  });

  test("one question per run", () => {
    const r = cli(["one", "two"], jsonl(posts(1)));
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("one question per run");
  });

  test("--print-prompt needs no key and prints the prompt on stdout", () => {
    const r = cli(
      ["which should I read?", "--print-prompt", "--context", "synthetic posts"],
      jsonl(posts(2)),
    );
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("<context>\nsynthetic posts\n</context>");
    expect(r.stdout).toContain("[i002] @user2");
  });

  test("without a key a real run is a usage error", () => {
    const r = cli(["which?"], jsonl(posts(1)));
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("GEMINI_API_KEY is not set");
  });

  test("help names --context and the flags a scrape shape can need", () => {
    for (const flag of [
      "--context",
      "--id",
      "--text",
      "--author",
      "--reply-to",
      "--quote",
      "--out -",
      "--no-roles",
    ]) {
      expect(HELP).toContain(flag);
    }
  });
});
