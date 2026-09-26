import { at, renderBlock, type Block, type Entry, type View } from "./render";
import type { Window } from "./windows";

export const PROMPT_VERSION = 2;

export type Ask = { question: string; context?: string | undefined };

function examples(width: number): { skip: string; read: string } {
  const nines = "9".repeat(width);
  return { skip: `i${nines.slice(0, -1)}8`, read: `i${nines}` };
}

function dataBlock(view: View): string[] {
  const first = view.sent[0]?.pointer ?? view.blocks[0]?.pointer ?? "i001";
  const intro = view.hasAuthor
    ? `Below are ${view.sent.length} items from one dataset. Each starts with a pointer in brackets, like [${first}], then its author and time.`
    : `Below are ${view.sent.length} items from one dataset. Each starts with a pointer in brackets, like [${first}], followed by its fields.`;
  const lines = [intro];
  if (view.blocks.length > 0) {
    const q = view.blocks[0]!.pointer;
    lines.push(
      `Posts that items quote or repost are listed once, after the items, with their own pointers like [${q}]; ` +
        `an item that refers to one shows "> quotes [${q}]" or "> reposts [${q}]" (or the pointer of an item in the set).`,
    );
  }
  if (view.sent.some((e) => e.links.some((l) => l.kind === "reply"))) {
    lines.push('"> replies to [pointer]" names the post an item answers.');
  }
  if (view.sent.some((e) => e.media)) {
    lines.push(
      "A marker like [2 images, 1 video] stands for media you cannot see: a post that is mostly an image or a video can still be worth reading.",
    );
  }
  lines.push(
    "",
    `<items count="${view.sent.length}">`,
    view.sent.map((e) => e.rendered).join("\n\n"),
    "</items>",
  );
  if (view.blocks.length > 0) {
    lines.push(
      "",
      `<referenced count="${view.blocks.length}">`,
      view.blocks.map((b) => renderBlock(b, view.width)).join("\n\n"),
      "</referenced>",
    );
  }
  return lines;
}

function askBlock(ask: Ask): string[] {
  const lines: string[] = [""];
  if (ask.context) {
    lines.push(
      "A reader who cannot read all of these gave this context:",
      "<context>",
      ask.context,
      "</context>",
      "and asked:",
    );
  } else {
    lines.push("A reader who cannot read all of these asked:");
  }
  lines.push("<question>", ask.question, "</question>", "");
  return lines;
}

const WHOLE_SET =
  "You see every item at once, so use what only the whole set shows: authors who post more than once, " +
  "items that continue or answer each other, and patterns that repeat across items.";

function itemRules(view: View, scopeLine: string, everyReason = false): string[] {
  const ex = examples(view.width);
  return [
    "ITEMS",
    scopeLine,
    "<pointer> <r|m|s> <tag>: <reason>",
    "- r = read (worth the reader's time for this question), m = maybe (could be; you are unsure), s = skip (clearly not worth reading for this question).",
    "- tag: one word for what the item is.",
    everyReason
      ? "- reason: six words or fewer, on every line, s lines included."
      : "- reason: six words or fewer, only for r and m. For s write only the pointer, s and the tag.",
    "",
    "Example lines (made-up pointers):",
    everyReason ? `${ex.skip} s promo: launch announcement, nothing measured` : `${ex.skip} s promo`,
    `${ex.read} r benchmark: accuracy versus two named baselines`,
    "",
    "Missing an item worth reading is much worse than giving the reader an extra one: when unsure between m and s, " +
      "choose m. An item that depends on something you cannot see (a reply whose parent is not here, one part of a " +
      "thread whose other parts are missing) is m fragment: never skip an item because you cannot make sense of it." +
      (view.hasText ? "" : " An item with nothing in it to judge is s empty."),
  ];
}

function summaryRule(width: number): string {
  const ex = examples(width);
  return (
    'Three to five short claims about what this dataset says for the reader\'s question, one per line starting with "- ", ' +
    `each ending with the pointers that support it in brackets, like [${ex.read}, ${ex.skip}].`
  );
}

export function buildPrompt(view: View, ask: Ask, everyReason = false): string {
  const items = view.sent.length;
  const refs = view.blocks.length;
  const every =
    refs === 0
      ? `One line for every pointer: all ${items} items, each exactly once, in the order given.`
      : `One line for every pointer: all ${items} items and all ${refs} referenced posts (${items + refs} lines), each exactly once, in the order given.`;
  return [
    ...dataBlock(view),
    ...askBlock(ask),
    WHOLE_SET,
    "",
    "Answer in plain text: no JSON, no markdown, no commentary. Three blocks, in this order: OVERVIEW, ITEMS, SUMMARY.",
    "",
    "OVERVIEW",
    "own: <handles of the accounts that belong to the subject of the question: its creator, company or staff; none if there are none>",
    'threads: <pointers of each thread or conversation; separate groups with " | ">',
    "",
    ...itemRules(view, every, everyReason),
    "",
    "SUMMARY",
    summaryRule(view.width),
    ...(ask.context
      ? [
          "",
          "After the SUMMARY, one last line:",
          "named: <the products, models, people, accounts or places the reader's context names, each in the short form a post would use, separated by commas; none if it names none>",
        ]
      : []),
  ].join("\n");
}

export function buildRepairPrompt(view: View, ask: Ask, scope: string[], everyReason = false): string {
  const scopeLine =
    `One line for each of these ${scope.length} pointers only, in this order: ${scope.join(" ")}. ` +
    "The other pointers were judged separately; still use them as context.";
  return [
    ...dataBlock(view),
    ...askBlock(ask),
    WHOLE_SET,
    "",
    "Answer in plain text: no JSON, no markdown, no commentary. Only an ITEMS block.",
    "",
    ...itemRules(view, scopeLine, everyReason),
  ].join("\n");
}

const WINDOW_SET =
  "You see one part of the dataset, so use what this part shows: authors who post more than once, " +
  "items that continue or answer each other, and patterns that repeat across items.";

function windowDataBlock(view: View, win: Window, parts: number): string[] {
  const n = win.entries.length;
  const first = win.entries[0]?.pointer ?? win.blocks[0]?.pointer ?? "i001";
  const lines = [
    `Below are ${n} of the ${view.sent.length} items in one dataset: part ${win.index + 1} of ${parts}. ` +
      "The other parts are judged separately; you see only this part. " +
      (view.hasAuthor
        ? `Each item starts with a pointer in brackets, like [${first}], then its author and time.`
        : `Each item starts with a pointer in brackets, like [${first}], followed by its fields.`),
  ];
  if (win.blocks.length > 0) {
    const q = win.blocks[0]!.pointer;
    lines.push(
      `Posts that items quote or repost are listed once, after the items, with their own pointers like [${q}]; ` +
        `an item that refers to one shows "> quotes [${q}]" or "> reposts [${q}]" (or the pointer of an item in the set).`,
    );
  }
  if (win.context.length > 0) {
    lines.push(
      "Posts from other parts that items here reply to or quote are listed last, under <context>, for reference only: " +
        "they are judged separately, so write no line for them.",
    );
  }
  if (win.entries.some((e) => e.links.some((l) => l.kind === "reply"))) {
    lines.push('"> replies to [pointer]" names the post an item answers.');
  }
  if (win.entries.some((e) => e.media)) {
    lines.push(
      "A marker like [2 images, 1 video] stands for media you cannot see: a post that is mostly an image or a video can still be worth reading.",
    );
  }
  const inWindow = new Set(win.entries.map((e) => e.line));
  lines.push(
    "",
    `<items count="${n}">`,
    win.entries.map((e) => e.rendered).join("\n\n"),
    "</items>",
  );
  if (win.blocks.length > 0) {
    lines.push(
      "",
      `<referenced count="${win.blocks.length}">`,
      win.blocks
        .map((b) =>
          renderBlock({ ...b, lines: b.lines.filter((l) => inWindow.has(l)) }, view.width),
        )
        .join("\n\n"),
      "</referenced>",
    );
  }
  if (win.context.length > 0) {
    lines.push(
      "",
      `<context count="${win.context.length}">`,
      win.context.map((e) => e.rendered).join("\n\n"),
      "</context>",
    );
  }
  return lines;
}

export function buildWindowPrompt(
  view: View,
  win: Window,
  parts: number,
  ask: Ask,
  everyReason = false,
): string {
  const n = win.entries.length;
  const refs = win.blocks.length;
  const every =
    refs === 0
      ? `One line for every pointer in this part: all ${n} items, each exactly once, in the order given.`
      : `One line for every pointer in this part: all ${n} items and all ${refs} referenced posts (${n + refs} lines), each exactly once, in the order given.`;
  return [
    ...windowDataBlock(view, win, parts),
    ...askBlock(ask),
    WINDOW_SET,
    "",
    "Answer in plain text: no JSON, no markdown, no commentary. Two blocks, in this order: OVERVIEW, ITEMS.",
    "",
    "OVERVIEW",
    "own: <handles of the accounts that belong to the subject of the question: its creator, company or staff; none if there are none>",
    'threads: <pointers of each thread or conversation; separate groups with " | ">',
    "",
    ...itemRules(view, every, everyReason),
  ].join("\n");
}

export function buildWindowRepairPrompt(
  view: View,
  win: Window,
  parts: number,
  ask: Ask,
  scope: string[],
  everyReason = false,
): string {
  const scopeLine =
    `One line for each of these ${scope.length} pointers only, in this order: ${scope.join(" ")}. ` +
    "The other pointers were judged separately; still use them as context.";
  return [
    ...windowDataBlock(view, win, parts),
    ...askBlock(ask),
    WINDOW_SET,
    "",
    "Answer in plain text: no JSON, no markdown, no commentary. Only an ITEMS block.",
    "",
    ...itemRules(view, scopeLine, everyReason),
  ].join("\n");
}

export const OVERVIEW_CUT = 120;
export const OVERVIEW_CUT_FLOOR = 40;
export const OVERVIEW_MAX_CHARS = 780_000;

const flat = (s: string) => s.replace(/\s+/g, " ").trim();
const cutTo = (s: string, max: number) => {
  const f = flat(s);
  return f.length > max ? `${f.slice(0, max)}…` : f;
};

function overviewRows(view: View, cut: number): { items: string[]; refs: string[] } {
  const items = view.sent.map((e) => {
    const head = `[${e.pointer}]${e.author ? ` ${at(e.author)}` : ""}`;
    const body = e.text
      ? cutTo(e.text, cut)
      : e.reposted !== undefined
        ? "(repost)"
        : cutTo(e.snippet, cut);
    const links = e.rendered.split("\n").filter((l) => l.startsWith("> "));
    return [head, body, e.media, ...links].filter(Boolean).join("\n");
  });
  const refs = view.blocks.map(
    (b) =>
      `[${b.pointer}] ${b.author ?? "author not in the data"} · ${b.kind === "quote" ? "quoted" : "reposted"} by ${b.lines.length}\n${cutTo(b.text, cut)}`,
  );
  return { items, refs };
}

export function buildOverviewPrompt(view: View, ask: Ask): string {
  let cut = OVERVIEW_CUT;
  let rows = overviewRows(view, cut);
  const size = (r: typeof rows) => [...r.items, ...r.refs].reduce((n, x) => n + x.length + 2, 0);
  if (size(rows) > OVERVIEW_MAX_CHARS) {
    cut = Math.max(OVERVIEW_CUT_FLOOR, Math.floor((cut * OVERVIEW_MAX_CHARS) / size(rows)));
    rows = overviewRows(view, cut);
  }
  const refs = rows.refs.length;
  return [
    `Below are all ${view.sent.length} items of one dataset${refs ? `, then the ${refs} posts they quote or repost` : ""}, ` +
      `each cut to its first ${cut} characters. Each starts with a pointer in brackets, then its author.`,
    "",
    `<items count="${view.sent.length}">`,
    rows.items.join("\n\n"),
    "</items>",
    ...(refs ? ["", `<referenced count="${refs}">`, rows.refs.join("\n\n"), "</referenced>"] : []),
    ...askBlock(ask),
    "Do not judge the items. Write only these lines, in plain text, with no commentary:",
    "own: <handles of the accounts that belong to the subject of the question: its creator, company or staff; none if there are none>",
    ...(ask.context
      ? [
          "named: <the products, models, people, accounts or places the reader's context names, each in the short form a post would use, separated by commas; none if it names none>",
        ]
      : []),
  ].join("\n");
}

export const LEADS_MAX_CHARS = 60_000;
export const LEADS_TOTAL_CHARS = 100_000;
export const LEADS_CUT = 200;

export function buildLeadsPrompt(
  view: View,
  ask: Ask,
  read: readonly string[],
  maybe: readonly string[],
): string | undefined {
  if (read.length + maybe.length === 0) return undefined;
  const target = (p: string): { e?: Entry; b?: Block } =>
    p.startsWith("q")
      ? { b: view.blocks.find((x) => x.pointer === p) }
      : { e: view.entries.get(Number(p.slice(1))) };
  const full = (p: string) => {
    const t = target(p);
    return t.e ? t.e.rendered : t.b ? renderBlock(t.b, view.width) : "";
  };
  const short = (p: string) => {
    const t = target(p);
    if (t.e) return `${t.e.rendered.split("\n")[0]}\n${cutTo(t.e.text || t.e.snippet, LEADS_CUT)}`;
    if (t.b)
      return `[${t.b.pointer}] ${t.b.author ?? "author not in the data"}\n${cutTo(t.b.text, LEADS_CUT)}`;
    return "";
  };
  let used = 0;
  const readRows: string[] = [];
  for (const p of read) {
    if (used >= LEADS_TOTAL_CHARS) break;
    const row = used < LEADS_MAX_CHARS ? full(p) : short(p);
    used += row.length + 2;
    readRows.push(row);
  }
  const maybeRows: string[] = [];
  for (const p of maybe) {
    if (used >= LEADS_MAX_CHARS) break;
    const row = short(p);
    used += row.length + 2;
    maybeRows.push(row);
  }
  return [
    (readRows.length === read.length
      ? `Below are the ${read.length} items a first pass over a dataset of ${view.sent.length} items marked worth reading`
      : `Below are the first ${readRows.length} of the ${read.length} items a first pass over a dataset of ${view.sent.length} items marked worth reading`) +
      (maybeRows.length
        ? `, then ${maybeRows.length === maybe.length ? "the" : `the first ${maybeRows.length} of the`} ${maybe.length} it marked maybe, each cut to its first ${LEADS_CUT} characters`
        : "") +
      ". Each starts with a pointer in brackets.",
    "",
    `<read count="${readRows.length}">`,
    readRows.join("\n\n"),
    "</read>",
    ...(maybeRows.length
      ? ["", `<maybe count="${maybeRows.length}">`, maybeRows.join("\n\n"), "</maybe>"]
      : []),
    ...askBlock(ask),
    "Answer in plain text: no JSON, no markdown, no commentary. Only a SUMMARY block.",
    "",
    "SUMMARY",
    summaryRule(view.width),
  ].join("\n");
}
