import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { answerAll, jsonl, lineRecords, posts, runWith } from "./helpers";

describe("guards that refuse before anything is sent", () => {
  test("over --max-cost: exit 3, no call", async () => {
    const r = await runWith(jsonl(posts(20)), answerAll(), { maxCost: 0.000001 });
    expect(r.code).toBe(3);
    expect(r.prompts).toHaveLength(0);
    expect(r.notices.join("\n")).toContain("Nothing was sent");
  });

  test("over the item cap: exit 2, no call, the cap named", async () => {
    const r = await runWith(jsonl(posts(12)), answerAll(), { maxItems: 10 });
    expect(r.code).toBe(2);
    expect(r.prompts).toHaveLength(0);
    expect(r.notices.join("\n")).toContain("over the 10 one call can safely handle");
  });

  test("--print-prompt calls nothing", async () => {
    const r = await runWith(jsonl(posts(2)), answerAll(), { printPrompt: true });
    expect(r.code).toBe(0);
    expect(r.prompts).toHaveLength(0);
    expect(r.text).toContain("[i001] @user1");
  });

  test("a dataset of only empty items asks nothing and still accounts for every line", async () => {
    const r = await runWith(
      jsonl([
        { id: "1", text: "" },
        { id: "2", text: " " },
      ]),
      answerAll(),
    );
    expect(r.code).toBe(0);
    expect(r.prompts).toHaveLength(0);
    expect(lineRecords(r).map((x) => x.tag)).toEqual(["empty", "empty"]);
  });
});

describe("records: one per input line, then referenced posts, after a run record", () => {
  test("shape and order", async () => {
    const items = [
      ...posts(2),
      {
        id: "9",
        author: "@q",
        text: "quoting",
        quoted_text: "a long quoted post that is not in the data and is long enough",
        quoted_author: "@maker",
      },
    ];
    const input = jsonl(items).replace("\n", "\nnot json\n");
    const r = await runWith(input, answerAll());
    expect(r.code).toBe(1);
    expect(Object.keys(r.records[0]!)).toEqual(["askq_run"]);
    const lines = lineRecords(r);
    expect(lines.map((x) => x.askq_line)).toEqual([1, 2, 3, 4]);
    expect(lines[1]).toEqual({ askq_line: 2, askq_error: "line is not JSON" });
    expect(lines[0]).toMatchObject({
      askq_id: "https://example.com/p/1000",
      verdict: "read",
      tag: "note",
      item: items[0],
    });
    const refs = r.records.filter((x) => "askq_ref" in x);
    expect(refs).toEqual([
      expect.objectContaining({
        askq_ref: "q01",
        askq_lines: [4],
        author: "@maker",
        verdict: "read",
      }),
    ]);
    expect(r.text).toContain("1 lines were not JSON objects");
  });
});

describe("roll-up", () => {
  const quoting = [
    ...posts(3),
    {
      id: "8",
      url: "https://example.com/p/8",
      author: "@fan",
      text: "wow",
      quoted_text: "the maker's own long announcement post, which is not itself in the data",
      quoted_author: "@maker",
    },
  ];

  test("every row names an openable pointer, the author and a snippet; a referenced post is never a bare q-id", async () => {
    const r = await runWith(jsonl(quoting), answerAll());
    expect(r.text).toContain(
      '  [1] @user1 · note: synthetic reason\n      https://example.com/p/1000 · "synthetic post 1:',
    );
    expect(r.text).toContain(
      "[quoted by 4] @maker · note: synthetic reason\n      via https://example.com/p/8 ·",
    );
    expect(r.text).not.toMatch(/\bq\d{2}\b/);
  });

  test("leads are labelled as leads, with pointers turned into lines", async () => {
    const r = await runWith(
      jsonl(quoting),
      answerAll(undefined, { summary: ["- people like it [i001, q01]"] }),
    );
    expect(r.text).toContain("Leads to verify, not facts");
    expect(r.text).toContain("  - people like it  [1, the post quoted by 4]");
  });

  test("the spot-check shows skipped items, one per tag first", async () => {
    const r = await runWith(
      jsonl(posts(9)),
      answerAll((p) =>
        Number(p.slice(1)) <= 6 ? "s promo" : Number(p.slice(1)) <= 8 ? "s joke" : "s offtopic",
      ),
    );
    const spot = r.text.split("\nspot-check — ")[1]!.split("checks:")[0]!;
    expect(spot).toContain("5 of the 9 items the model skipped");
    for (const tag of ["promo", "joke", "offtopic"]) expect(spot).toContain(`· ${tag}`);
    expect(r.text).toContain("warning: nothing was marked read");
  });

  test("the commands it prints run verbatim against the records it wrote", async () => {
    if (spawnSync("jq", ["--version"]).status !== 0) return;
    const r = await runWith(jsonl(posts(60)), answerAll());
    const dir = mkdtempSync(join(tmpdir(), "askq-test-"));
    const file = join(dir, "records.jsonl");
    writeFileSync(file, r.records.map((x) => JSON.stringify(x)).join("\n") + "\n");
    const commands = r.rollup
      .flatMap((l) => [...l.matchAll(/(jq -c '[^']+' \S+)/g)].map((m) => m[1]!))
      .map((c) => c.replace("/tmp/askq-test/records.jsonl", file));
    expect(commands.length).toBeGreaterThanOrEqual(2);
    for (const c of commands) {
      const res = spawnSync("sh", ["-c", c], { encoding: "utf8" });
      expect(res.status).toBe(0);
      expect(res.stdout.trim().split("\n").length).toBeGreaterThan(0);
      expect(res.stdout).toContain('"verdict":"read"');
    }
  });
});
