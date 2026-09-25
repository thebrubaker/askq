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

  test("--window below 60 is refused, saying why", () => {
    const r = cli(["which?", "--window", "40", "--print-prompt"], jsonl(posts(1)));
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("--window must be a whole number of items from 60 to 400, got: 40");
    expect(r.stderr).toContain("smaller windows lost items worth reading in testing");
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

describe("closing line", () => {
  test("names where the roll-up and the records went, for a pipe, a file and a terminal", async () => {
    const { closingLine } = await import("../src/cli");
    const path = "/tmp/askq/r.jsonl";
    expect(closingLine({ recordsToStdout: false, path, stdoutIsTTY: false })).toBe(
      "askq: the roll-up went to stdout; the records are in /tmp/askq/r.jsonl",
    );
    expect(closingLine({ recordsToStdout: false, path, stdoutIsTTY: true })).toBe(
      "askq: the roll-up is above; the records are in /tmp/askq/r.jsonl",
    );
    expect(closingLine({ recordsToStdout: true, path: "(stdout)", stdoutIsTTY: false })).toBe(
      "askq: the records went to stdout and the roll-up to stderr",
    );
  });

  test("a run that wrote nothing says nothing about where it went", () => {
    const r = cli(["which?", "--max-cost", "0"], jsonl(posts(3)), { GEMINI_API_KEY: "not-used" });
    expect(r.status).toBe(3);
    expect(r.stderr).not.toContain("the records are in");
  });
});
