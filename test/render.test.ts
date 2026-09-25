import { describe, expect, test } from "bun:test";
import { buildView } from "../src/render";
import { describeRoles, resolveRoles, type Role } from "../src/roles";

function view(
  items: Record<string, unknown>[],
  flags: Partial<Record<Role, string>> = {},
  autodetect = true,
) {
  const map = new Map(items.map((it, i) => [i + 1, it]));
  const roles = resolveRoles(items, flags, autodetect);
  return { v: buildView({ total: items.length, items: map, roles }), roles };
}
const rendered = (v: ReturnType<typeof view>["v"], line: number) => v.entries.get(line)!.rendered;

const LONG =
  "we measured first-token latency on three laptops and a desktop card, full numbers below";

const stella = (over: Record<string, unknown>) => ({
  id: "1",
  url: "https://example.com/s/1",
  author: "@alice",
  text: "hello",
  created_at: "2026-02-01T09:30:00.000Z",
  likes: 3,
  views: 40,
  reply_to_id: null,
  reply_to_author: null,
  quoted_text: null,
  quoted_author: null,
  thread_root_id: null,
  media: [],
  seed_id: "seed-a",
  ...over,
});

const xsearch = (over: Record<string, unknown>) => ({
  id: "100",
  handle: "bob",
  name: "Bob",
  createdAt: "2026-02-02T08:00:00.000Z",
  text: "hi",
  likes: 1,
  followers: 1200,
  verified: false,
  isRT: false,
  url: "https://example.com/x/100",
  quotedText: null,
  quotedHandle: null,
  quotedId: null,
  inReplyToId: null,
  inReplyToHandle: null,
  ...over,
});

describe("roles are recognised by field name", () => {
  test("the stella-stick shape needs no flags", () => {
    const { roles } = view([
      stella({
        reply_to_id: "9",
        quoted_text: "x",
        thread_root_id: "1",
        media: [{ type: "photo", url: "u" }],
      }),
    ]);
    expect(Object.fromEntries(Object.entries(roles).map(([k, r]) => [k, r!.path]))).toMatchObject({
      id: ".url",
      key: ".id",
      text: ".text",
      author: ".author",
      time: ".created_at",
      replyTo: ".reply_to_id",
      quote: ".quoted_text",
      thread: ".thread_root_id",
      media: ".media",
    });
  });

  test("the xsearch shape needs no flags", () => {
    const { roles } = view([
      xsearch({
        inReplyToId: "9",
        inReplyToHandle: "carol",
        quotedText: "q",
        quotedHandle: "dan",
        quotedId: "7",
        isRT: true,
      }),
    ]);
    expect(Object.fromEntries(Object.entries(roles).map(([k, r]) => [k, r!.path]))).toMatchObject({
      id: ".url",
      key: ".id",
      text: ".text",
      author: ".handle",
      time: ".createdAt",
      replyTo: ".inReplyToId",
      replyAuthor: ".inReplyToHandle",
      quote: ".quotedText",
      quoteAuthor: ".quotedHandle",
      quoteId: ".quotedId",
      repost: ".isRT",
    });
  });

  test("a flag overrides detection, and the roles line says what was used", () => {
    const { roles } = view([{ u: "https://example.com/1", who: "@eve", body: "b", text: "t" }], {
      id: ".u",
      author: ".who",
    });
    expect(roles.id!.path).toBe(".u");
    expect(roles.author!.path).toBe(".who");
    expect(describeRoles(roles, 1)).toContain("author .who");
  });

  test("--no-roles shows every field as key: value", () => {
    const { v } = view([{ handle: "@eve", text: "a post" }], {}, false);
    expect(rendered(v, 1)).toBe("[i001] handle: @eve · text: a post");
  });
});

describe("discourse render", () => {
  test("a reply to a post in the set points to it; the head carries author, time and other fields", () => {
    const { v } = view([
      stella({ id: "1", text: "root post" }),
      stella({ id: "2", url: "u2", author: "@bob", text: "reply", reply_to_id: "1" }),
    ]);
    expect(rendered(v, 2)).toBe(
      "[i002] @bob · 2026-02-01 09:30:00 · likes: 3 · views: 40 · seed_id: seed-a\nreply\n> replies to [i001]",
    );
  });

  test("a reply whose parent is missing says whose it was, or that it continues the author's own thread", () => {
    const { v } = view([
      xsearch({ id: "1", inReplyToId: "900", inReplyToHandle: "carol" }),
      xsearch({ id: "2", inReplyToId: "901", inReplyToHandle: "bob" }),
    ]);
    expect(rendered(v, 1)).toContain("> replies to @carol; that post is not in this data");
    expect(rendered(v, 2)).toContain(
      "> continues @bob's own thread; the earlier post is not in this data",
    );
  });

  test("a quote of a post in the set points to it by id instead of repeating its text", () => {
    const { v } = view([
      xsearch({ id: "1", text: LONG }),
      xsearch({
        id: "2",
        text: "look at this",
        quotedId: "1",
        quotedText: LONG,
        quotedHandle: "bob",
      }),
    ]);
    expect(rendered(v, 2)).toContain("> quotes [i001]");
    expect(v.blocks).toHaveLength(0);
  });

  test("a quoted post outside the set is shown once for every quoter, truncations merged, author from the data", () => {
    const { v } = view([
      stella({
        id: "1",
        text: "a",
        quoted_text: `${LONG} and a longer tail`,
        quoted_author: "@maker",
      }),
      stella({ id: "2", text: "b", quoted_text: LONG, quoted_author: "@maker" }),
      stella({ id: "3", text: "c", quoted_text: `${LONG.slice(0, 50)}…`, quoted_author: "@maker" }),
    ]);
    expect(v.blocks).toHaveLength(1);
    expect(v.blocks[0]).toMatchObject({
      pointer: "q01",
      author: "@maker",
      lines: [1, 2, 3],
      text: `${LONG} and a longer tail`,
    });
    for (const line of [1, 2, 3]) expect(rendered(v, line)).toContain("> quotes [q01]");
  });

  test("a quote whose text was not captured is still a quote, and the model is not handed a guess", () => {
    const { v } = view([
      xsearch({ id: "1", text: "", quotedId: "55", quotedHandle: "dan", quotedText: null }),
    ]);
    expect(v.empties).toHaveLength(0);
    expect(rendered(v, 1)).toBe(
      "[i001] @bob · 2026-02-02 08:00:00 · name: Bob · likes: 1 · followers: 1200\n(no text)\n> quotes @dan (its text was not captured)",
    );
  });

  test("a retweet of a post in the set points to it; one outside the set is shown once, author from the RT prefix", () => {
    const { v } = view([
      xsearch({ id: "1", handle: "orig", text: LONG }),
      xsearch({ id: "2", isRT: true, text: `RT @orig: ${LONG}` }),
      xsearch({
        id: "3",
        isRT: true,
        text: "RT @far: a repost of something that is not in the data at all, long enough",
      }),
      xsearch({
        id: "4",
        isRT: true,
        handle: "zed",
        text: "RT @far: a repost of something that is not in the data at all, long enough",
      }),
    ]);
    expect(rendered(v, 2)).toContain("(repost)\n> reposts [i001]");
    expect(v.blocks).toEqual([
      expect.objectContaining({ kind: "repost", author: "@far", lines: [3, 4] }),
    ]);
  });

  test("a post that is only media is judged; only no text, no media and no quote is empty", () => {
    const { v } = view([
      stella({
        id: "1",
        text: "",
        media: [{ type: "photo" }, { type: "photo" }, { type: "video" }],
      }),
      stella({ id: "2", text: "  " }),
      stella({ id: "3", text: "words" }),
    ]);
    expect(v.empties.map((e) => e.line)).toEqual([2]);
    expect(rendered(v, 1)).toContain("(no text)\n[2 images, 1 video]");
    expect(v.pointers).toEqual(["i001", "i003"]);
  });

  test("items of one thread are shown next to each other", () => {
    const { v } = view([
      stella({ id: "1", text: "root", thread_root_id: null }),
      stella({ id: "2", text: "other" }),
      stella({ id: "3", text: "reply", thread_root_id: "1", reply_to_id: "1" }),
      stella({ id: "4", text: "reply to reply", reply_to_id: "3" }),
    ]);
    expect(v.sent.map((e) => e.line)).toEqual([1, 3, 4, 2]);
  });

  test("self-thread replies whose root is missing are grouped by author", () => {
    const { v } = view([
      xsearch({ id: "1", handle: "amy", inReplyToId: "90", inReplyToHandle: "amy" }),
      xsearch({ id: "2", handle: "ben" }),
      xsearch({ id: "3", handle: "amy", inReplyToId: "91", inReplyToHandle: "amy" }),
    ]);
    expect(v.sent.map((e) => e.line)).toEqual([1, 3, 2]);
  });
});

describe("time", () => {
  test("ISO and X's own date format both read as UTC date and time", async () => {
    const { showTime } = await import("../src/render");
    expect(showTime("2026-02-01T09:30:00.000Z")).toBe("2026-02-01 09:30:00");
    expect(showTime("Fri Sep 25 19:56:24 +0000 2026")).toBe("2026-09-25 19:56:24");
    expect(showTime("yesterday")).toBe("yesterday");
  });
});

describe("text as scraped", () => {
  test("HTML entities in scraped text reach the model as the characters they stand for", () => {
    const { v } = view([stella({ text: "VAD -&gt; STT -&gt; LLM &amp; TTS, &quot;local&quot;" })]);
    expect(rendered(v, 1)).toContain('VAD -> STT -> LLM & TTS, "local"');
    expect(v.entries.get(1)!.snippet).toBe('VAD -> STT -> LLM & TTS, "local"');
  });
});
