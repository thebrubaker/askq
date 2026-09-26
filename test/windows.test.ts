import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import type { CallResult } from "../src/gemini";
import { parseOverview } from "../src/parse";
import { buildView } from "../src/render";
import { resolveRoles } from "../src/roles";
import { planWindows } from "../src/windows";
import { answerAll, jsonl, lineRecords, pointersIn, posts, runWith, type Ran } from "./helpers";

type Kind = "overview" | "leads" | "window" | "repair" | "single";

const kindOf = (prompt: string): Kind =>
  prompt.includes("Do not judge the items.")
    ? "overview"
    : prompt.includes("Only a SUMMARY block.")
      ? "leads"
      : /: part \d+ of \d+\./.test(prompt)
        ? prompt.includes("Only an ITEMS block.")
          ? "repair"
          : "window"
        : "single";

const partOf = (prompt: string) => Number(/: part (\d+) of \d+\./.exec(prompt)?.[1] ?? 0);

const failure = (reason: string, fatal = false): CallResult => ({
  ok: false,
  fatal,
  reason,
  attempts: fatal ? 1 : 3,
});

type Script = {
  verdict?: (pointer: string, prompt: string, kind: Kind) => string | undefined;
  own?: (prompt: string, kind: Kind) => string;
  named?: string;
  fail?: (prompt: string, kind: Kind) => CallResult | undefined;
};

const distinct = (p: string) => `r note: reason for ${p}`;

function scripted(s: Script = {}) {
  return (prompt: string) => {
    const kind = kindOf(prompt);
    const failed = s.fail?.(prompt, kind);
    if (failed) return failed;
    const lines = pointersIn(prompt).flatMap((p) => {
      const v = s.verdict ? s.verdict(p, prompt, kind) : distinct(p);
      return v === undefined ? [] : [`${p} ${v}`];
    });
    return [
      "OVERVIEW",
      `own: ${s.own?.(prompt, kind) ?? "none"}`,
      "threads: ",
      "",
      "ITEMS",
      ...lines,
      "",
      "SUMMARY",
      "- a synthetic claim [i001]",
      ...(s.named ? ["", `named: ${s.named}`] : []),
    ].join("\n");
  };
}

const kinds = (r: Ran) => r.prompts.map(kindOf);
const record = (r: Ran, line: number) => lineRecords(r).find((x) => x.askq_line === line)!;
const viewOf = (items: Record<string, unknown>[]) => {
  const map = new Map(items.map((it, i) => [i + 1, it]));
  return buildView({ total: items.length, items: map, roles: resolveRoles(items, {}, true) });
};

const twenty = () => jsonl(posts(20));

describe("chunked coverage", () => {
  test("an item only one window holds, missed twice, carries askq_error and exits 1", async () => {
    const r = await runWith(
      twenty(),
      scripted({ verdict: (p, _, k) => (p === "i004" && k !== "leads" ? undefined : distinct(p)) }),
      { window: 8 },
    );
    expect(r.code).toBe(1);
    expect(record(r, 4).askq_error).toBe(
      "the model gave no verdict for this item, even when asked again",
    );
    const repair = r.prompts.filter((p) => kindOf(p) === "repair");
    expect(repair).toHaveLength(1);
    expect(repair[0]).toContain("One line for each of these 1 pointers only, in this order: i004.");
    expect(r.text).toContain("coverage incomplete: 1 of 20 lines have no verdict (lines 4)");
  });

  test("an item one window missed and its overlap window judged is covered, with no repair", async () => {
    const r = await runWith(
      twenty(),
      scripted({
        verdict: (p, prompt) => (p === "i007" && partOf(prompt) === 1 ? undefined : distinct(p)),
      }),
      { window: 8 },
    );
    expect(r.code).toBe(0);
    expect(kinds(r)).not.toContain("repair");
    expect(record(r, 7).verdict).toBe("read");
    expect(record(r, 7).askq_windows).toEqual([1, 2]);
    expect(record(r, 7).askq_votes).toBeUndefined();
  });

  test("an item missed and then answered on repair counts as re-asked", async () => {
    const r = await runWith(
      twenty(),
      scripted({
        verdict: (p, _, k) => (p === "i004" && k === "window" ? undefined : distinct(p)),
      }),
      { window: 8 },
    );
    expect(r.code).toBe(0);
    expect(record(r, 4).verdict).toBe("read");
    expect(r.text).toContain("1 re-asked after the first answer missed them");
  });

  test("a window that fails twice leaves only its own items without a verdict; exit 1", async () => {
    const r = await runWith(
      twenty(),
      scripted({
        fail: (prompt, k) =>
          k === "window" && partOf(prompt) === 2 ? failure("http 503: overloaded") : undefined,
      }),
      { window: 8 },
    );
    expect(r.code).toBe(1);
    expect(r.prompts.filter((p) => kindOf(p) === "window" && partOf(p) === 2)).toHaveLength(2);
    for (const line of [9, 10, 11, 12])
      expect(record(r, line).askq_error).toBe("no verdict: http 503: overloaded");
    for (const line of [7, 8, 13, 14]) expect(record(r, line).verdict).toBe("read");
    expect(r.text).toContain(
      "warning: window 2 got no answer, even when sent again: http 503: overloaded.",
    );
    expect(r.text).toContain("window 2 sent twice");
  });

  test("a 400 stops the queue: windows not yet sent stay unsent; exit 2", async () => {
    const r = await runWith(
      jsonl(posts(60)),
      scripted({
        fail: (prompt, k) =>
          k === "window" && partOf(prompt) === 1
            ? failure("http 400: bad config", true)
            : undefined,
      }),
      { window: 8 },
    );
    expect(r.code).toBe(2);
    const sent = r.prompts.filter((p) => kindOf(p) === "window").map(partOf);
    expect(sent).not.toContain(9);
    expect(sent).not.toContain(10);
    expect(kinds(r)).not.toContain("leads");
    expect(record(r, 60).askq_error).toBe("no verdict: http 400: bad config");
  });

  test("an interrupt keeps what the other windows judged and exits 130", async () => {
    const r = await runWith(
      twenty(),
      scripted({
        fail: (prompt, k) =>
          k === "window" && partOf(prompt) === 2 ? failure("interrupted") : undefined,
      }),
      { window: 8 },
    );
    expect(r.code).toBe(130);
    expect(record(r, 1).verdict).toBe("read");
    expect(record(r, 10).askq_error).toBe("no verdict: interrupted");
    expect(kinds(r)).not.toContain("leads");
  });
});

describe("merging windows", () => {
  test("read needs every window's read; one read or one maybe keeps the item as maybe", async () => {
    const r = await runWith(
      twenty(),
      scripted({
        verdict: (p, prompt) =>
          p === "i007"
            ? partOf(prompt) === 1
              ? "s promo"
              : "r usage: a usage report"
            : p === "i008"
              ? "r usage: read by both"
              : distinct(p),
      }),
      { window: 8 },
    );
    expect(record(r, 7).verdict).toBe("maybe");
    expect(record(r, 7).reason).toBe("a usage report");
    expect(record(r, 7).askq_votes).toEqual(["skip", "read"]);
    expect(record(r, 7).askq_windows).toEqual([1, 2]);
    expect(record(r, 8).verdict).toBe("read");
    expect(record(r, 8).askq_votes).toEqual(["read", "read"]);
    expect(r.rollup[1]).toBe(
      "chunked: --window 8 asked for windows, so judged in 3 windows of up to 8 items that overlap by 2, not in one call. " +
        "4 items were judged more than once (1 disagreed): an item is read only when every judgement read it; one read, " +
        "or any maybe, makes it maybe. Expect a longer maybe list than one call would give.",
    );
    const maybeHeader = r.rollup.findIndex((l) => l.startsWith("then maybe"));
    expect(r.rollup[maybeHeader]).toContain("items one judgement read first");
  });

  test("a quoted post two windows hold is judged in both and keeps one verdict", async () => {
    const quote = {
      quoted_text: "a synthetic announcement quoted from two far apart posts",
      quoted_author: "@origin",
    };
    const r = await runWith(
      jsonl(posts(20, (i) => (i === 0 || i === 19 ? quote : {}))),
      scripted({
        verdict: (p, prompt) =>
          p.startsWith("q")
            ? partOf(prompt) === 1
              ? "s promo"
              : "m launch: the launch post"
            : distinct(p),
      }),
      { window: 8 },
    );
    const ref = r.records.find((x) => x.askq_ref === "q1" || x.askq_ref === "q01")!;
    expect(ref.verdict).toBe("maybe");
    expect(ref.askq_windows).toEqual([1, 3]);
    expect(ref.askq_votes).toEqual(["skip", "maybe"]);
  });

  test("leads come from one call over the read items only", async () => {
    const r = await runWith(
      twenty(),
      scripted({
        verdict: (p) =>
          p === "i001" ? "r built: a demo" : p === "i002" ? "m maybe: a demo" : "s other",
      }),
      { window: 8 },
    );
    const leads = r.prompts.filter((p) => kindOf(p) === "leads");
    expect(leads).toHaveLength(1);
    expect(leads[0]).toContain('<read count="1">');
    expect(leads[0]).not.toContain("<maybe");
    expect(r.text).toContain("  - a synthetic claim  [1]");
  });
});

describe("safety nets across windows", () => {
  test("the tripwire flags a repeated reason inside one window, not one spread over windows", async () => {
    const same = "r note: the same six words each time";
    const inOne = await runWith(
      twenty(),
      scripted({
        verdict: (p) => (["i001", "i002", "i003", "i004", "i005"].includes(p) ? same : distinct(p)),
      }),
      { window: 8 },
    );
    expect(inOne.text).toContain(
      '5 items in window 1 share the reason "the same six words each time"',
    );
    const spread = await runWith(
      jsonl(posts(40)),
      scripted({
        verdict: (p) => (["i001", "i010", "i016", "i022", "i028"].includes(p) ? same : distinct(p)),
      }),
      { window: 8 },
    );
    expect(spread.text).not.toContain("share the reason");
  });

  test("own accounts: the overview's, and any two windows name; one window alone is not enough", async () => {
    const r = await runWith(
      twenty(),
      scripted({
        verdict: () => "s other",
        own: (prompt, k) =>
          k === "overview"
            ? "@user3 (the maker's staff), @ghost_account"
            : partOf(prompt) === 1
              ? "@user7, @user2"
              : partOf(prompt) === 2
                ? "@user7 (staff)"
                : "@user16",
      }),
      { window: 8 },
    );
    expect(record(r, 3).verdict).toBe("maybe");
    expect(String(record(r, 3).askq_note)).toContain("the overview names as the subject's own");
    expect(record(r, 7).verdict).toBe("maybe");
    expect(String(record(r, 7).askq_note)).toContain(
      "the answer for window 1 and window 2 names as the subject's own",
    );
    expect(record(r, 2).verdict).toBe("skip");
    expect(record(r, 16).verdict).toBe("skip");
    expect(r.text).toContain(
      "2 skipped posts by @user3 (overview) @user7 (window 1, window 2), named as the subject's own",
    );
    expect(r.text).not.toContain("ghost_account");
  });

  test("the overview answer parses with no headers, and with markdown", () => {
    expect(parseOverview("own: @alpha, @beta\nnamed: Widget, Gizmo")).toEqual({
      own: ["alpha", "beta"],
      named: ["Widget", "Gizmo"],
    });
    expect(parseOverview("OVERVIEW\n**own:** none\n- named: Widget")).toEqual({
      own: [],
      named: ["Widget"],
    });
  });

  test("a failed overview leaves the run judged, warns, and keeps --watch terms", async () => {
    const r = await runWith(
      twenty(),
      scripted({
        fail: (_, k) => (k === "overview" ? failure("http 503: overloaded") : undefined),
      }),
      { window: 8, watch: ["render"], ask: { question: "which?", context: "about Widget" } },
    );
    expect(r.code).toBe(0);
    expect(r.text).toContain("warning: the overview call failed (http 503: overloaded)");
    expect(r.text).toContain("  render · from --watch · 20 items");
  });
});

describe("how windows are cut", () => {
  test("with no structure, windows are positional and overlap by a quarter", () => {
    const windows = planWindows(viewOf(posts(20)), 8, 2);
    expect(windows.map((w) => w.pointers.map((p) => Number(p.slice(1))))).toEqual([
      [1, 2, 3, 4, 5, 6, 7, 8],
      [7, 8, 9, 10, 11, 12, 13, 14],
      [13, 14, 15, 16, 17, 18, 19, 20],
    ]);
  });

  test("a reply chain at a window boundary stays whole", () => {
    const view = viewOf(posts(11, (i) => (i >= 7 ? { reply_to_id: String(1000 + i - 1) } : {})));
    const chain = ["i007", "i008", "i009", "i010", "i011"];
    const windows = planWindows(view, 8, 2);
    for (const w of windows) {
      const held = chain.filter((p) => w.pointers.includes(p)).length;
      expect([0, chain.length]).toContain(held);
    }
    expect(windows.some((w) => chain.every((p) => w.pointers.includes(p)))).toBe(true);
  });

  test("a thread larger than a window splits with overlap and carries its root as context", () => {
    const items = [
      { id: "1", author: "@root", text: "a synthetic question that starts a long thread" },
      ...Array.from({ length: 149 }, (_, i) => ({
        id: String(i + 2),
        author: `@r${i}`,
        text: `synthetic answer number ${i}`,
        reply_to_id: "1",
      })),
    ];
    const windows = planWindows(viewOf(items), 60, 15);
    expect(windows).toHaveLength(3);
    expect(windows.map((w) => w.entries.length)).toEqual([60, 60, 60]);
    expect(windows[1]!.context.map((e) => e.pointer)).toEqual(["i001"]);
    expect(windows[2]!.context.map((e) => e.pointer)).toEqual(["i001"]);
  });

  test("every pointer lands in a window, within size, over random structures", () => {
    let seed = 7;
    const rand = () => (seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;
    for (let round = 0; round < 25; round++) {
      const n = 20 + Math.floor(rand() * 280);
      const size = 4 + Math.floor(rand() * 57);
      const items = posts(n, (i) => ({
        ...(i > 0 && rand() < 0.3 ? { reply_to_id: String(1000 + Math.floor(rand() * i)) } : {}),
        ...(rand() < 0.2
          ? {
              quoted_text: `a synthetic shared announcement number ${Math.floor(rand() * 5)} with enough text`,
            }
          : {}),
      }));
      const view = viewOf(items);
      const windows = planWindows(view, size, Math.floor(size / 4));
      const covered = new Set(windows.flatMap((w) => w.pointers));
      for (const p of view.pointers) expect(covered.has(p)).toBe(true);
      for (const w of windows) {
        expect(w.entries.length).toBeLessThanOrEqual(size);
        expect(new Set(w.pointers).size).toBe(w.pointers.length);
        const quoted = new Set(
          w.entries.flatMap((e) => e.links.flatMap((l) => ("pointer" in l ? [l.pointer] : []))),
        );
        for (const b of w.blocks) expect(quoted.has(b.pointer)).toBe(true);
      }
    }
  });

  test("a post quoted from another window is shown as context, and its lines there are ignored", async () => {
    const r = await runWith(
      jsonl(posts(20, (i) => (i === 18 ? { text: "Here", quoted_text: posts(1)[0]!.text } : {}))),
      scripted({
        verdict: (p, prompt) => (p === "i001" && partOf(prompt) === 3 ? "s promo" : distinct(p)),
      }),
      { window: 8 },
    );
    const part3 = r.prompts.find((p) => kindOf(p) === "window" && partOf(p) === 3)!;
    expect(part3).toContain('<context count="1">\n[i001] @user1');
    expect(part3).toContain("[i019] @user19");
    expect(part3).toContain("> quotes [i001]");
    expect(record(r, 1).askq_windows).toEqual([1]);
    expect(record(r, 1).verdict).toBe("read");
  });

  test("a short reply's quoted post travels with it into its window", async () => {
    const quote = {
      text: "Here",
      quoted_text: "a synthetic post that links the repository and the setup steps",
    };
    const r = await runWith(jsonl(posts(20, (i) => (i === 15 ? quote : {}))), scripted(), {
      window: 8,
    });
    const holding = r.prompts.filter((p) => kindOf(p) === "window" && p.includes("[i016] @user16"));
    expect(holding.length).toBeGreaterThan(0);
    for (const p of holding) expect(p).toContain("links the repository and the setup steps");
  });
});

const GOLDEN_NO_CONTEXT = "8f7e616156ab2c1b41aca4cfb91d2d76d7826c2e45e77b4cebb87c284a7f625f";
const GOLDEN_CONTEXT = "6e67d45e3e5f43e1185ab724c4115d9329957495d4b6cf8b6d50c779dd1e02f0";

describe("when chunking kicks in", () => {
  test("400 pointers go in one call, 401 in windows, and --window forces windows", async () => {
    const one = await runWith(jsonl(posts(400)), answerAll(distinct));
    expect(kinds(one)).toEqual(["single"]);
    const many = await runWith(jsonl(posts(401)), scripted());
    expect(kinds(many)).toContain("overview");
    expect(kinds(many)).toContain("window");
    expect(kinds(many)).toContain("leads");
    expect(many.rollup[1]).toStartWith(
      "chunked: over 400 items, so judged in 9 windows of up to 60 items",
    );
    const forced = await runWith(twenty(), scripted(), { window: 8 });
    expect(kinds(forced).filter((k) => k === "window")).toHaveLength(3);
  });

  test("the one-call prompt is byte-identical to askq 0.2.0", async () => {
    const input = jsonl([
      ...posts(6, (i) =>
        i === 2
          ? { reply_to_id: "1000" }
          : i === 3
            ? {
                quoted_text:
                  "a synthetic quoted post long enough to be shown as its own referenced block",
                quoted_author: "@origin",
              }
            : i === 4
              ? { media: [{ type: "photo" }, { type: "video" }] }
              : {},
      ),
      { id: "2000", author: "@user9", text: "" },
    ]);
    const hash = async (context?: string) => {
      const r = await runWith(input, answerAll(), {
        printPrompt: true,
        ask: { question: "which should I read?", context },
      });
      return createHash("sha256").update(r.text).digest("hex");
    };
    expect(await hash()).toBe(GOLDEN_NO_CONTEXT);
    expect(await hash("a synthetic context naming Widget and Gizmo")).toBe(GOLDEN_CONTEXT);
  });

  test("over 2,000 items refuses, naming the cap, and sends nothing", async () => {
    const r = await runWith(jsonl(posts(2001)), scripted());
    expect(r.code).toBe(2);
    expect(r.prompts).toHaveLength(0);
    expect(r.notices.join("\n")).toContain(
      "2001 items to judge is over the 2,000 one run can safely handle. Nothing was sent.",
    );
  });

  test("--max-cost refuses from the estimate summed over every window", async () => {
    const r = await runWith(twenty(), scripted(), { window: 8, maxCost: 0.000001 });
    expect(r.code).toBe(3);
    expect(r.prompts).toHaveLength(0);
    expect(r.notices.join("\n")).toContain("for 20 items in 3 windows");
  });
});
