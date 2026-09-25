import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CallResult, Client } from "../src/gemini";
import { run, type RunConfig } from "../src/run";

export function pointersIn(prompt: string): string[] {
  const scoped = /One line for each of these \d+ pointers only, in this order: ([^.]+)\./.exec(
    prompt,
  );
  if (scoped) return scoped[1]!.trim().split(/\s+/);
  return [...prompt.matchAll(/^\[([iq]\d+)\]/gm)].map((m) => m[1]!);
}

export type Answer = string | ((prompt: string, call: number) => string | CallResult);

export function ok(text: string): CallResult {
  return {
    ok: true,
    text,
    finishReason: "STOP",
    usage: { in: 1000, out: 100, thoughts: 0 },
    attempts: 1,
    ms: 5,
  };
}

export function fakeClient(answer: Answer, model = "gemini-3.8-flash") {
  const prompts: string[] = [];
  const client: Client = {
    model,
    thinking: { thinkingBudget: 0 },
    async call(prompt) {
      prompts.push(prompt);
      const out = typeof answer === "string" ? answer : answer(prompt, prompts.length - 1);
      return typeof out === "string" ? ok(out) : out;
    },
  };
  return { client, prompts };
}

export function answerAll(
  verdictOf: (pointer: string) => string = () => "r note: synthetic reason",
  extra: { own?: string; summary?: string[]; named?: string } = {},
) {
  return (prompt: string) => {
    const lines = pointersIn(prompt).map((p) => `${p} ${verdictOf(p)}`);
    return [
      "OVERVIEW",
      `own: ${extra.own ?? "none"}`,
      "threads: ",
      "",
      "ITEMS",
      ...lines,
      "",
      "SUMMARY",
      ...(extra.summary ?? ["- a synthetic claim [i001]"]),
      ...(extra.named ? ["", `named: ${extra.named}`] : []),
    ].join("\n");
  };
}

export function jsonl(items: Record<string, unknown>[]): string {
  return items.map((i) => JSON.stringify(i)).join("\n") + "\n";
}

export type Ran = {
  code: number;
  rollup: string[];
  records: Record<string, unknown>[];
  notices: string[];
  prompts: string[];
  text: string;
};

export async function runWith(
  input: string,
  answer: Answer,
  cfg: Partial<RunConfig> = {},
): Promise<Ran> {
  const { client, prompts } = fakeClient(answer);
  const recordsPath = join(mkdtempSync(join(tmpdir(), "askq-test-")), "records.jsonl");
  const rollupLines: string[] = [];
  const notices: string[] = [];
  let written: string[] = [];
  const code = await run(
    input,
    {
      ask: { question: "which should I read?" },
      flags: {},
      autodetect: true,
      model: "gemini-3.8-flash",
      maxCost: 1,
      yes: false,
      printPrompt: false,
      ...cfg,
    },
    {
      client: () => client,
      rollupOut: (l) => rollupLines.push(l),
      recordsOut: {
        path: recordsPath,
        write: (lines) => {
          written = lines;
          writeFileSync(recordsPath, lines.join("\n") + "\n");
        },
      },
      notice: (l) => notices.push(l),
      now: (() => {
        let t = 0;
        return () => (t += 1000);
      })(),
    },
  );
  return {
    code,
    rollup: rollupLines,
    records: written.map((l) => JSON.parse(l) as Record<string, unknown>),
    notices,
    prompts,
    text: rollupLines.join("\n"),
  };
}

export function runPrinted(r: Ran, command: string): { status: number | null; stdout: string } {
  const assign = r.rollup.find((l) => l.startsWith("R="));
  if (!assign) throw new Error("the roll-up printed no R= line");
  const res = spawnSync("sh", ["-c", `${assign}\n${command}`], { encoding: "utf8" });
  return { status: res.status, stdout: res.stdout };
}

export const printedCommands = (r: Ran) =>
  r.rollup.flatMap((l) => [...l.matchAll(/(jq -[cr] '[^']+' "\$R")/g)].map((m) => m[1]!));

export const lineRecords = (r: Ran) => r.records.filter((x) => typeof x.askq_line === "number");

/** Synthetic posts only: no scraped third-party text may enter this repository. */
export function posts(
  n: number,
  extra: (i: number) => Record<string, unknown> = () => ({}),
): Record<string, unknown>[] {
  return Array.from({ length: n }, (_, i) => ({
    id: String(1000 + i),
    url: `https://example.com/p/${1000 + i}`,
    author: `@user${i + 1}`,
    text: `synthetic post ${i + 1}: I shipped a demo that cut render time by ${i + 3}%`,
    created_at: `2026-01-0${(i % 9) + 1}T10:00:00.000Z`,
    ...extra(i),
  }));
}
