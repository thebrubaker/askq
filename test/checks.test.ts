import { describe, expect, test } from "bun:test";
import { REPEAT_THRESHOLD } from "../src/checks";
import { answerAll, jsonl, lineRecords, pointersIn, posts, runWith } from "./helpers";

describe("coverage: every pointer comes back once, or the run says which did not", () => {
  test("positive control: a complete answer is exit 0 and every line has a verdict", async () => {
    const r = await runWith(jsonl(posts(5)), answerAll());
    expect(r.code).toBe(0);
    const lines = lineRecords(r);
    expect(lines).toHaveLength(5);
    expect(lines.every((x) => x.verdict === "read" && !("askq_error" in x))).toBe(true);
    expect(r.prompts).toHaveLength(1);
    expect(r.text).not.toContain("coverage incomplete");
  });

  test("a pointer the model never returns, even when re-asked, fails the run and is named", async () => {
    const r = await runWith(jsonl(posts(5)), (prompt) =>
      answerAll()(prompt)
        .split("\n")
        .filter((l) => !l.startsWith("i003 "))
        .join("\n"),
    );
    expect(r.code).toBe(1);
    expect(r.prompts).toHaveLength(2);
    const lines = lineRecords(r);
    expect(lines).toHaveLength(5);
    const hole = lines.find((x) => x.askq_line === 3)!;
    expect(hole.askq_error).toMatch(/no verdict/);
    expect(hole.verdict).toBeUndefined();
    expect(r.text).toContain(
      "warning: coverage incomplete: 1 of 5 lines have no verdict (lines 3)",
    );
  });

  test("the re-ask names exactly the missing pointers, and a good second answer fills the hole", async () => {
    const r = await runWith(jsonl(posts(5)), (prompt, call) => {
      const full = answerAll()(prompt);
      return call === 0
        ? full
            .split("\n")
            .filter((l) => !/^i00[24] /.test(l))
            .join("\n")
        : full;
    });
    expect(r.code).toBe(0);
    expect(pointersIn(r.prompts[1]!)).toEqual(["i002", "i004"]);
    expect(lineRecords(r).every((x) => x.verdict === "read")).toBe(true);
    expect(r.text).toContain("2 re-asked after the first answer missed them");
  });

  test("a pointer answered twice keeps the higher verdict and is counted", async () => {
    const r = await runWith(jsonl(posts(3)), (prompt) =>
      answerAll(() => "s promo")(prompt).replace(
        "ITEMS\n",
        "ITEMS\ni002 m builder: could be real\n",
      ),
    );
    expect(r.code).toBe(0);
    expect(lineRecords(r).find((x) => x.askq_line === 2)!.verdict).toBe("maybe");
    expect(r.text).toContain("1 answered twice (kept the higher)");
  });

  test("a pointer that was never sent is ignored rather than attached to anything", async () => {
    const r = await runWith(jsonl(posts(2)), (prompt) =>
      answerAll()(prompt).replace("ITEMS\n", "ITEMS\ni777 r made-up: not in the data\n"),
    );
    expect(r.code).toBe(0);
    expect(lineRecords(r)).toHaveLength(2);
    expect(JSON.stringify(r.records)).not.toContain("i777");
  });
});

describe("repeated reasons: many items sharing one reason flags the run", () => {
  const sameFor = (n: number) => (p: string) =>
    Number(p.slice(1)) <= n ? "r promo: same launch thread recap" : `r note: reason ${p}`;

  test(`${REPEAT_THRESHOLD} items with one identical reason are flagged, each record marked`, async () => {
    const r = await runWith(jsonl(posts(8)), answerAll(sameFor(REPEAT_THRESHOLD)));
    expect(r.code).toBe(0);
    expect(r.text).toContain(
      `warning: ${REPEAT_THRESHOLD} items share the reason "same launch thread recap"`,
    );
    const marked = lineRecords(r).filter((x) => x.askq_review);
    expect(marked.map((x) => x.askq_line)).toEqual([1, 2, 3, 4, 5]);
  });

  test(`${REPEAT_THRESHOLD - 1} items sharing a reason are not flagged`, async () => {
    const r = await runWith(jsonl(posts(8)), answerAll(sameFor(REPEAT_THRESHOLD - 1)));
    expect(r.text).not.toContain("share the reason");
    expect(lineRecords(r).some((x) => x.askq_review)).toBe(false);
    expect(r.text).toContain(`no reason repeated on 5+ items (most ${REPEAT_THRESHOLD - 1})`);
  });

  test("empty items skipped by code never count toward the flag", async () => {
    const items = [
      ...posts(3),
      ...Array.from({ length: 6 }, (_, i) => ({ id: `e${i}`, author: `@quiet${i}`, text: "" })),
    ];
    const r = await runWith(jsonl(items), answerAll());
    expect(r.prompts[0]).not.toContain("@quiet");
    expect(r.text).not.toContain("share the reason");
    expect(lineRecords(r).filter((x) => x.tag === "empty")).toHaveLength(6);
  });
});

describe("safety lifts: askq never lets these be skipped", () => {
  test("a skipped fragment becomes maybe, with a note", async () => {
    const r = await runWith(
      jsonl(posts(3)),
      answerAll((p) => (p === "i002" ? "s fragment" : "s promo")),
    );
    const lines = lineRecords(r);
    expect(lines.find((x) => x.askq_line === 2)).toMatchObject({
      verdict: "maybe",
      tag: "fragment",
    });
    expect(String(lines.find((x) => x.askq_line === 2)!.askq_note)).toContain("lifted");
    expect(lines.find((x) => x.askq_line === 1)!.verdict).toBe("skip");
  });

  test("a skipped post by an account the overview names as the subject's own becomes maybe", async () => {
    const r = await runWith(
      jsonl(posts(3)),
      answerAll(() => "s promo", { own: "@User2, @nobody_here" }),
    );
    const lines = lineRecords(r);
    expect(lines.find((x) => x.askq_line === 2)!.verdict).toBe("maybe");
    expect(lines.find((x) => x.askq_line === 1)!.verdict).toBe("skip");
    expect(lines.find((x) => x.askq_line === 3)!.verdict).toBe("skip");
    expect(r.text).toContain("named in the overview as the subject's own");
  });

  const pointing = () =>
    jsonl([
      ...posts(3),
      { id: "2001", author: "@helper", text: "@asker Here", quoted_text: posts(1)[0]!.text },
      {
        id: "2002",
        author: "@helper",
        text: "Here",
        quoted_text: "a synthetic post that links the repository and the setup steps",
      },
    ]);

  test("a short post quoting a kept post becomes maybe, naming the line it points to", async () => {
    const r = await runWith(
      pointing(),
      answerAll((p) => (p === "i001" || p.startsWith("q") ? "m repo: has the setup" : "s pointer")),
    );
    const lines = lineRecords(r);
    expect(lines.find((x) => x.askq_line === 4)!.verdict).toBe("maybe");
    expect(String(lines.find((x) => x.askq_line === 4)!.askq_note)).toContain(
      "a short post pointing at line 1, the post it quotes, which was kept",
    );
    expect(lines.find((x) => x.askq_line === 5)!.verdict).toBe("maybe");
    expect(String(lines.find((x) => x.askq_line === 5)!.askq_note)).toContain(
      "the post it quotes (askq_ref q01)",
    );
    expect(r.text).toContain("lifted to maybe: 2 short posts quoting a kept post (lines 4 5)");
  });

  test("ordinary short skips stay skipped: no quote, a skipped quote, a long quote, or a short reply", async () => {
    const r = await runWith(
      jsonl([
        ...posts(3),
        { id: "3001", author: "@a", text: "nice" },
        { id: "3002", author: "@b", text: "lol", quoted_text: posts(2)[1]!.text },
        {
          id: "3003",
          author: "@c",
          text: "this one is a long enough comment to stand on its own",
          quoted_text: posts(1)[0]!.text,
        },
        { id: "3004", author: "@d", text: "wow", reply_to_id: "1000" },
      ]),
      answerAll((p) => (p === "i001" ? "r repo: has the setup" : "s other")),
    );
    const lines = lineRecords(r);
    for (const line of [4, 5, 6, 7])
      expect(lines.find((x) => x.askq_line === line)!.verdict).toBe("skip");
    expect(r.text).not.toContain("quoting a kept post");
  });
});
