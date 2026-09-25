import { describe, expect, test } from "bun:test";
import { answerAll, jsonl, posts, runWith, type Ran } from "./helpers";

const maybeSection = (r: Ran) => r.text.split("\nthen maybe — ")[1]!.split("\n\nspot-check")[0]!;
const reachable = (section: string, line: number) =>
  new RegExp(`(\\[${line}\\]|lines( \\d+)* ${line}\\b)`).test(section);

describe("per-author collapse in the read and maybe lists", () => {
  test("eight posts by one author are one row plus one line naming the other seven", async () => {
    const items = posts(11, (i) =>
      i < 8
        ? {
            author: "@echo",
            text: `same pitch again, version ${i}`,
            thread_root_id: i % 2 ? "t1" : "t2",
          }
        : {},
    );
    const r = await runWith(
      jsonl(items),
      answerAll(() => "m setup: could be real"),
    );
    const section = maybeSection(r);
    expect(section.split("\n")[0]).toContain("11; authors with 3+ here shown once");
    expect(section.match(/\] @echo ·/g)).toHaveLength(1);
    expect(section).toContain("      … and 7 more by @echo here: lines 2 3 4 5 6 7 8");
    for (let line = 1; line <= 11; line++) expect(reachable(section, line)).toBe(true);
  });

  test("two posts by one author are not collapsed", async () => {
    const items = posts(5, (i) => (i < 2 ? { author: "@pair" } : {}));
    const r = await runWith(
      jsonl(items),
      answerAll(() => "m setup: could be real"),
    );
    const section = maybeSection(r);
    expect(section.match(/\] @pair ·/g)).toHaveLength(2);
    expect(section).not.toContain("more by");
  });

  test("collapsed rows free slots under the cap, and nothing falls through it unlisted", async () => {
    const items = posts(40, (i) => (i < 10 ? { author: "@loud" } : {}));
    const r = await runWith(
      jsonl(items),
      answerAll(() => "m setup: could be real"),
    );
    const section = maybeSection(r);
    expect(section.split("\n")[0]).toContain("40, first 25 rows shown");
    expect([...section.matchAll(/^ {2}\[(\d+)\]/gm)]).toHaveLength(25);
    expect(section).toContain("… and 9 more by @loud here: lines 2 3 4 5 6 7 8 9 10");
    const rest = /… (\d+) more: jq -c '/.exec(section);
    expect(Number(rest![1])).toBe(40 - 25 - 9);
  });

  test("without an author field nothing is collapsed", async () => {
    const items = Array.from({ length: 6 }, (_, i) => ({
      id: String(i),
      text: `anonymous note ${i}`,
    }));
    const r = await runWith(
      jsonl(items),
      answerAll(() => "m note: could be"),
    );
    expect(maybeSection(r)).not.toContain("more by");
  });
});
