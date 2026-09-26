import { describe, expect, test } from "bun:test";
import { mergeVotes, ownAccounts, type Judgement } from "../src/checks";
import { handles } from "../src/parse";
import { buildView } from "../src/render";
import { resolveRoles } from "../src/roles";
import { CLAUDE_LAYOUT } from "../src/run";
import { jsonl, lineRecords, pointersIn, posts, runWith, type Ran } from "./helpers";

const j = (verdict: Judgement["verdict"], reason = `${verdict} reason`): Judgement => ({
  verdict,
  tag: "t",
  reason,
  notes: [],
});
const record = (r: Ran, line: number) => lineRecords(r).find((x) => x.askq_line === line)!;

function answer(verdictOf: (pointer: string, call: number) => string, own = "none") {
  return (prompt: string, call: number) => {
    if (prompt.includes("Do not judge the items.")) return `own: ${own}\nnamed: none`;
    if (prompt.includes("Only a SUMMARY block.")) return "SUMMARY\n- a synthetic claim [i001]";
    return [
      "OVERVIEW",
      `own: ${own}`,
      "threads: ",
      "",
      "ITEMS",
      ...pointersIn(prompt).map((p) => `${p} ${verdictOf(p, call)}`),
      "",
      "SUMMARY",
      "- a synthetic claim [i001]",
    ].join("\n");
  };
}

describe("merging two judgements", () => {
  test("read only when every judgement read; any read or maybe is maybe; all skips skip", () => {
    const cases: [Judgement["verdict"][], Judgement["verdict"]][] = [
      [["read", "read"], "read"],
      [["read", "maybe"], "maybe"],
      [["skip", "read"], "maybe"],
      [["maybe", "skip"], "maybe"],
      [["maybe", "maybe"], "maybe"],
      [["skip", "skip"], "skip"],
      [["read", "read", "read"], "read"],
      [["read", "read", "skip"], "maybe"],
      [["read"], "read"],
      [["skip"], "skip"],
    ];
    for (const [votes, want] of cases) expect(mergeVotes(votes.map((v) => j(v))).verdict).toBe(want);
  });

  test("a read that another window skipped keeps the read's reason", () => {
    const m = mergeVotes([j("skip", "nothing here"), j("read", "measured latency")]);
    expect(m).toEqual({ verdict: "maybe", tag: "t", reason: "measured latency", notes: [] });
  });
});

describe("the subject's own accounts", () => {
  test("only @handles count, and prose around them is ignored", () => {
    expect(handles("@maker_co (Jane Doe, the maker's staff), @helper (Sam Roe, staff)")).toEqual([
      "maker_co",
      "helper",
    ]);
    expect(handles("q06 is likely the maker but its handle is not shown in this part")).toEqual([]);
    expect(handles("none (no @maker_co staff account appears directly in this part)")).toEqual([]);
    expect(handles("n/a")).toEqual([]);
    expect(handles("mail x@y.example or @real_one.")).toEqual(["real_one"]);
  });

  test("only accounts that wrote something in the data count, once each", () => {
    const items = posts(3);
    const view = buildView({
      total: 3,
      items: new Map(items.map((it, i) => [i + 1, it])),
      roles: resolveRoles(items, {}, true),
    });
    expect(ownAccounts(view, ["user2", "ghost", "@User2", "user3"])).toEqual(["user2", "user3"]);
  });
});

describe("claude layout", () => {
  test("up to 60 items: two parallel calls over the whole pile, merged by the vote rule", async () => {
    const r = await runWith(
      jsonl(posts(20)),
      answer((p, call) =>
        p === "i003" ? (call === 0 ? "r built: a demo" : "s other: no detail") : p === "i004" ? "r built: both read" : "s other: no detail",
      ),
      { layout: CLAUDE_LAYOUT, maxCalls: 100 },
    );
    expect(r.code).toBe(0);
    expect(r.prompts).toHaveLength(2);
    expect(r.prompts[0]).toBe(r.prompts[1]!);
    expect(r.prompts[0]).toContain("- reason: six words or fewer, on every line, s lines included.");
    expect(record(r, 3).verdict).toBe("maybe");
    expect(record(r, 3).askq_votes).toEqual(["read", "skip"]);
    expect(record(r, 4).verdict).toBe("read");
    expect(r.text).toContain("judged twice: two calls each saw every item (1 disagreed)");
  });

  test("above 60 items: windows of 60 overlapping by 30, wrapping round, so every item is judged twice", async () => {
    const r = await runWith(jsonl(posts(90)), answer((p) => `r note: reason for ${p}`), {
      layout: CLAUDE_LAYOUT,
      maxCalls: 100,
    });
    expect(r.code).toBe(0);
    const lines = lineRecords(r);
    expect(lines).toHaveLength(90);
    for (const l of lines) expect((l.askq_windows as number[]).length).toBeGreaterThanOrEqual(2);
    expect(r.rollup[1]).toContain("overlap by 30, the last wrapping round to the start");
  });

  test("--max-calls refuses a run that needs more calls, sending nothing", async () => {
    const r = await runWith(jsonl(posts(90)), answer(() => "s other: no detail"), {
      layout: CLAUDE_LAYOUT,
      maxCalls: 3,
    });
    expect(r.code).toBe(3);
    expect(r.prompts).toHaveLength(0);
    expect(r.notices.join("\n")).toContain("over --max-calls 3. Nothing was sent.");
  });
});
