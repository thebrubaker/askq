import { describe, expect, test } from "bun:test";
import { parseResponse } from "../src/parse";

describe("compact response parsing", () => {
  test("the three blocks", () => {
    const p = parseResponse(
      [
        "OVERVIEW",
        "own: @acme, acme_staff",
        "threads: i001, i004 | i007 i009",
        "",
        "ITEMS",
        "i001 r benchmark: latency on a laptop GPU",
        "i004 m howto: setup steps, no numbers",
        "i007 s promo",
        "q01 r creator: launch post",
        "",
        "SUMMARY",
        "- Two posts measure latency [i001, i004].",
        "- The launch post sets the claims [q01]",
      ].join("\n"),
    );
    expect(p.own).toEqual(["@acme", "acme_staff"]);
    expect(p.threads).toEqual([
      ["i001", "i004"],
      ["i007", "i009"],
    ]);
    expect(p.lines).toEqual([
      { pointer: "i001", verdict: "read", tag: "benchmark", reason: "latency on a laptop GPU" },
      { pointer: "i004", verdict: "maybe", tag: "howto", reason: "setup steps, no numbers" },
      { pointer: "i007", verdict: "skip", tag: "promo", reason: "" },
      { pointer: "q01", verdict: "read", tag: "creator", reason: "launch post" },
    ]);
    expect(p.summary).toEqual([
      { text: "Two posts measure latency", pointers: ["i001", "i004"] },
      { text: "The launch post sets the claims", pointers: ["q01"] },
    ]);
  });

  test("tolerates bullets, brackets, bold and spelled-out verdicts", () => {
    const p = parseResponse(
      [
        "ITEMS",
        "- [i002] R howto: fine",
        "**i003** maybe question: unclear",
        "i004: skip joke",
        "i005 m usage report",
      ].join("\n"),
    );
    expect(p.lines.map((l) => [l.pointer, l.verdict, l.tag, l.reason])).toEqual([
      ["i002", "read", "howto", "fine"],
      ["i003", "maybe", "question", "unclear"],
      ["i004", "skip", "joke", ""],
      ["i005", "maybe", "usage", "report"],
    ]);
  });

  test("verdict-shaped text outside ITEMS is never a verdict", () => {
    const p = parseResponse(
      [
        "OVERVIEW",
        "own: none",
        "i009 s promo",
        "ITEMS",
        "i001 r benchmark: numbers",
        "SUMMARY",
        "- one post quotes the line 'i002 s promo' verbatim [i001]",
        "i003 r fake: echoed from an item",
      ].join("\n"),
    );
    expect(p.lines.map((l) => l.pointer)).toEqual(["i001"]);
    expect(p.own).toEqual([]);
  });

  test("with no ITEMS header at all, verdict lines still count", () => {
    const p = parseResponse("i001 r benchmark: numbers\ni002 s promo");
    expect(p.lines.map((l) => l.pointer)).toEqual(["i001", "i002"]);
  });

  test("lines in ITEMS that are not verdicts are kept aside, not guessed at", () => {
    const p = parseResponse("ITEMS\ni001 r benchmark: numbers\nhere is my answer\ni002 x promo");
    expect(p.lines).toHaveLength(1);
    expect(p.unparsed).toEqual(["here is my answer", "i002 x promo"]);
  });
});
