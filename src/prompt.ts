import { renderBlock, type View } from "./render";

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

function itemRules(view: View, scopeLine: string): string[] {
  const ex = examples(view.width);
  return [
    "ITEMS",
    scopeLine,
    "<pointer> <r|m|s> <tag>: <reason>",
    "- r = read (worth the reader's time for this question), m = maybe (could be; you are unsure), s = skip (clearly not worth reading for this question).",
    "- tag: one word for what the item is.",
    "- reason: six words or fewer, only for r and m. For s write only the pointer, s and the tag.",
    "",
    "Example lines (made-up pointers):",
    `${ex.skip} s promo`,
    `${ex.read} r benchmark: accuracy versus two named baselines`,
    "",
    "Missing an item worth reading is much worse than giving the reader an extra one: when unsure between m and s, " +
      "choose m. An item that depends on something you cannot see (a reply whose parent is not here, one part of a " +
      "thread whose other parts are missing) is m fragment: never skip an item because you cannot make sense of it." +
      (view.hasText ? "" : " An item with nothing in it to judge is s empty."),
  ];
}

export function buildPrompt(view: View, ask: Ask): string {
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
    ...itemRules(view, every),
    "",
    "SUMMARY",
    'Three to five short claims about what this dataset says for the reader\'s question, one per line starting with "- ", ' +
      `each ending with the pointers that support it in brackets, like [${examples(view.width).read}, ${examples(view.width).skip}].`,
    ...(ask.context
      ? [
          "",
          "After the SUMMARY, one last line:",
          "named: <the products, models, people, accounts or places the reader's context names, each in the short form a post would use, separated by commas; none if it names none>",
        ]
      : []),
  ].join("\n");
}

export function buildRepairPrompt(view: View, ask: Ask, scope: string[]): string {
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
    ...itemRules(view, scopeLine),
  ].join("\n");
}
