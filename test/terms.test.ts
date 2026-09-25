import { describe, expect, test } from "bun:test";
import { parseResponse } from "../src/parse";
import { buildPrompt } from "../src/prompt";
import { buildView } from "../src/render";
import { resolveRoles } from "../src/roles";
import { buildTerms, formsOf, splitTerms } from "../src/terms";
import {
  answerAll,
  jsonl,
  lineRecords,
  posts,
  runPrinted as runInShell,
  runWith,
  type Ran,
} from "./helpers";

const termBlock = (r: Ran) => r.text.split("\nterms — ")[1]?.split("\n\n")[0] ?? "";

function runPrinted(r: Ran, command: string): string {
  const res = runInShell(r, command);
  expect(res.status).toBe(0);
  return res.stdout;
}

describe("terms: matching", () => {
  test("a long name also matches its shorter tails, ignoring case, spaces and hyphens", () => {
    expect(formsOf("Kyutai Pocket TTS")).toEqual(["Kyutai Pocket TTS", "Pocket TTS"]);
    const [t] = buildTerms(["Kyutai Pocket TTS"], []);
    for (const s of [
      "I use pocket-tts daily",
      "Pocket TTS landed",
      "PocketTTS is fast",
      "kyutai_pocket_tts",
    ]) {
      expect(t!.pattern.test(s)).toBe(true);
    }
    for (const s of ["pockets of tts users", "a pocket", "notpocket tts"]) {
      expect(t!.pattern.test(s)).toBe(false);
    }
  });

  test("a Latin name inside CJK text, with no spaces around it, still matches", () => {
    const [k] = buildTerms(["Kokoro"], []);
    for (const s of ["用Kokoro做了语音", "kokoroの声を試した", "这周我测试了kokoro和别的模型"]) {
      expect(k!.pattern.test(s)).toBe(true);
    }
    expect(k!.pattern.test("Kokoros")).toBe(false);
    const [cjk] = buildTerms(["音声"], []);
    expect(cjk!.pattern.test("日本語音声の評価")).toBe(true);
  });

  test("the union keeps provenance and drops duplicates, whatever their case", () => {
    const terms = buildTerms(["Kokoro", "Pocket TTS"], ["kokoro", "M3 Air"]);
    expect(terms.map((t) => [t.term, t.from])).toEqual([
      ["kokoro", ["--watch", "context"]],
      ["M3 Air", ["--watch"]],
      ["Pocket TTS", ["context"]],
    ]);
  });

  test("the named: line after SUMMARY is read as a list and never taken for a claim", () => {
    const tail =
      "ITEMS\ni001 r x: y\nSUMMARY\n- a claim [i001]\n\nnamed: Kyutai Pocket TTS, “Kokoro”; @someone";
    const parsed = parseResponse(tail);
    expect(parsed.named).toEqual(["Kyutai Pocket TTS", "Kokoro", "someone"]);
    expect(parsed.summary).toEqual([{ text: "a claim", pointers: ["i001"] }]);
    expect(parseResponse("OVERVIEW\nnamed: Kokoro\nITEMS\n").named).toEqual(["Kokoro"]);
    expect(splitTerms("none")).toEqual([]);
  });

  test("the prompt asks for named: last, after every verdict, and only when there is a context", () => {
    const prompt = (context?: string) =>
      buildPrompt(
        buildView({
          total: 1,
          items: new Map([[1, { text: "a post" }]]),
          roles: resolveRoles([{ text: "a post" }], {}, true),
        }),
        {
          question: "q?",
          context,
        },
      );
    const withContext = prompt("I run Kokoro");
    expect(withContext.indexOf("named: <")).toBeGreaterThan(withContext.indexOf("SUMMARY"));
    expect(prompt(undefined)).not.toContain("named: <");
  });
});

describe("terms: the roll-up", () => {
  const items = [
    ...posts(4),
    {
      id: "p",
      url: "https://example.com/p",
      author: "@dev",
      text: "switched my agent to pocket-tts last week",
    },
  ];

  test("a skipped item naming a term the context names is listed by line", async () => {
    const r = await runWith(
      jsonl(items),
      answerAll(() => "s promo", { named: "Kyutai Pocket TTS" }),
      {
        ask: { question: "which should I read?", context: "I run Kyutai Pocket TTS" },
      },
    );
    expect(termBlock(r)).toContain(
      'Kyutai Pocket TTS · from context · also as "Pocket TTS" · 1 item: 0 read, 0 maybe, 1 skipped (promo): lines 5',
    );
    expect(lineRecords(r).find((x) => x.askq_line === 5)!.askq_terms).toEqual([
      "Kyutai Pocket TTS",
    ]);
    expect(r.prompts[0]).toContain("named: <");
  });

  test("control: no named terms and no --watch, no terms section", async () => {
    const r = await runWith(
      jsonl(items),
      answerAll(() => "s promo"),
    );
    expect(r.text).not.toContain("\nterms — ");
    expect(r.prompts[0]).not.toContain("named: <");
  });

  test("a common term with 100 skipped matches is one line of counts and a jq command that works", async () => {
    const many = posts(100, (i) => ({ text: `kokoro run ${i}: sounded fine on my laptop` }));
    const r = await runWith(
      jsonl(many),
      answerAll(() => "s chatter"),
      { watch: ["Kokoro"] },
    );
    const block = termBlock(r);
    expect(block.split("\n").slice(1)).toHaveLength(1);
    expect(block).toContain(
      "Kokoro · from --watch · 100 items: 0 read, 0 maybe, 100 skipped (all chatter): jq -c ",
    );
    expect(block).not.toMatch(/lines \d/);
    expect(r.rollup.length).toBeLessThan(40);
    const command = /(jq -c '[^']+' "\$R")/.exec(block)![1]!;
    expect(runPrinted(r, command).trim().split("\n")).toHaveLength(100);
  });

  test("a term's skipped items say what the model took them for, most common tags first", async () => {
    const replies = posts(12, (i) => ({
      text: `@maker love it, Kokoro version ${i}`,
    }));
    const tagOf = (p: string) => {
      const n = Number(p.slice(1));
      return n <= 7 ? "s praise" : n <= 10 ? "s reaction" : "s question";
    };
    const r = await runWith(jsonl(replies), answerAll(tagOf), { watch: ["Kokoro"] });
    expect(termBlock(r)).toContain("12 skipped (mostly praise, reaction): jq -c ");
  });

  test("maybe items naming a term come first, so the maybe cap cannot hide them", async () => {
    const thirty = posts(30, (i) => (i === 29 ? { text: "tried Kokoro on a fanless laptop" } : {}));
    const r = await runWith(
      jsonl(thirty),
      answerAll(() => "m note: could be"),
      { watch: ["Kokoro"] },
    );
    const maybeRows = r.text.split("\nthen maybe — ")[1]!;
    expect(maybeRows.split("\n")[0]).toContain("items naming a term first");
    expect(maybeRows.split("\n")[1]).toStartWith("  [30] ");
  });

  test("one line says snippets are cut, and its jq prints an item's full text", async () => {
    const long = "a".repeat(50) + " measured 0.4 realtime factor on a laptop CPU " + "b".repeat(80);
    const r = await runWith(jsonl([{ id: "1", author: "@x", text: long }]), answerAll());
    const note = r.rollup.filter((l) => l.startsWith("snippets are cut at"));
    expect(note).toHaveLength(1);
    const command = /(jq -r '[^']+' "\$R")/.exec(note[0]!)![1]!;
    expect(runPrinted(r, command).trim()).toBe(long);
  });
});

test("a term's skipped lines are listed in line order", async () => {
  const items = posts(6, (i) => ({ text: `Kokoro note ${i}`, thread_root_id: i % 2 ? "a" : "b" }));
  const r = await runWith(
    jsonl(items),
    answerAll(() => "s chatter"),
    { watch: ["Kokoro"] },
  );
  expect(r.text).toContain("6 skipped (all chatter): lines 1, 2, 3, 4, 5, 6");
});
