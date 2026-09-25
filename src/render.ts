import { getPath } from "./field";
import { rolePaths, type Role, type Roles } from "./roles";

export const SHORT_MAX = 80;
export const TEXT_MATCH_MIN = 40;
export const SNIPPET_MAX = 110;

export type Link =
  | { kind: "reply" | "quote" | "repost"; pointer: string }
  | { kind: "reply" | "quote"; note: string };

export type Entry = {
  line: number;
  pointer: string;
  item: Record<string, unknown>;
  id: string | undefined;
  author: string | undefined;
  text: string;
  reposted: string | undefined;
  media: string;
  links: Link[];
  empty: boolean;
  hasLongField: boolean;
  snippet: string;
  rendered: string;
};

export type Block = {
  pointer: string;
  kind: "quote" | "repost";
  author: string | undefined;
  text: string;
  lines: number[];
};

export type View = {
  total: number;
  entries: Map<number, Entry>;
  sent: Entry[];
  empties: Entry[];
  blocks: Block[];
  pointers: string[];
  width: number;
  hasText: boolean;
  hasAuthor: boolean;
};

export type Target = { entry: Entry } | { block: Block };

export function pointerWidth(totalLines: number): number {
  return Math.max(3, String(totalLines + 2).length);
}

const ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  "#39": "'",
  "#x27": "'",
};
export const decodeEntities = (s: string) =>
  s.replace(/&(amp|lt|gt|quot|apos|#39|#x27);/g, (_, e: string) => ENTITIES[e]!);

const scalar = (v: unknown): string => {
  if (v === null || v === undefined || v === false) return "";
  if (typeof v === "string") return decodeEntities(v);
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  return JSON.stringify(v);
};

export const norm = (s: string) =>
  s
    .replace(/\s+/g, " ")
    .trim()
    .replace(/(…|\.\.\.)$/, "")
    .trim()
    .toLowerCase();

const tidy = (s: string) =>
  s
    .replace(/\r/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

export const handleKey = (h: string | undefined) =>
  (h ?? "").trim().replace(/^@/, "").toLowerCase();

export const at = (h: string) =>
  /^[A-Za-z0-9_]{1,30}$/.test(h.trim()) ? `@${h.trim()}` : h.trim();

const ISO = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2}:\d{2})(\.\d+)?(Z|[+-]\d{2}:?\d{2})?$/;
const X_DATE = /^[A-Z][a-z]{2} [A-Z][a-z]{2} \d{2} \d{2}:\d{2}:\d{2} [+-]\d{4} \d{4}$/;
export const showTime = (t: string) => {
  const raw = t.trim();
  const iso =
    X_DATE.test(raw) && !Number.isNaN(Date.parse(raw)) ? new Date(raw).toISOString() : raw;
  const m = ISO.exec(iso);
  return m ? `${m[1]} ${m[2]}` : raw;
};

function sameText(a: string, b: string): boolean {
  if (a === b) return a.length > 0;
  const [short, long] = a.length <= b.length ? [a, b] : [b, a];
  return short.length >= TEXT_MATCH_MIN && long.startsWith(short);
}

export function mediaMarker(value: unknown): string {
  if (value === null || value === undefined || value === false) return "";
  if (!Array.isArray(value)) return scalar(value).trim() === "" ? "" : "[media]";
  if (value.length === 0) return "";
  const counts = new Map<string, number>();
  for (const m of value) {
    const raw =
      typeof m === "object" && m !== null ? scalar((m as Record<string, unknown>).type) : "";
    const t = /photo|image|jpe?g|png/i.test(raw)
      ? "image"
      : /gif/i.test(raw)
        ? "gif"
        : /video/i.test(raw)
          ? "video"
          : raw.trim() || "media";
    counts.set(t, (counts.get(t) ?? 0) + 1);
  }
  const parts = [...counts].map(([t, n]) => `${n} ${t}${n === 1 ? "" : "s"}`);
  return `[${parts.join(", ")}]`;
}

type Leaf = { path: string; value: string };

function leaves(v: unknown, path: string, out: Leaf[]): void {
  if (v === null || v === undefined || v === false) return;
  if (typeof v === "string") {
    if (v.trim() !== "") out.push({ path, value: decodeEntities(v) });
    return;
  }
  if (typeof v === "number" || typeof v === "boolean") {
    out.push({ path, value: String(v) });
    return;
  }
  if (Array.isArray(v)) {
    if (v.every((x) => x === null || typeof x !== "object")) {
      const s = v
        .map(scalar)
        .filter((x) => x.trim() !== "")
        .join(", ");
      if (s) out.push({ path, value: s });
      return;
    }
    v.forEach((x, i) => leaves(x, `${path}[${i}]`, out));
    return;
  }
  for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
    leaves(x, path ? `${path}.${k}` : k, out);
  }
}

function claimed(leafPath: string, paths: string[]): boolean {
  const dotted = `.${leafPath}`;
  return paths.some(
    (p) => dotted === p || dotted.startsWith(`${p}.`) || dotted.startsWith(`${p}[`),
  );
}

const REPOST_PREFIX = /^RT @([A-Za-z0-9_]{1,30}):\s*/;

export type BuildInput = {
  total: number;
  items: Map<number, Record<string, unknown>>;
  roles: Roles;
};

export function buildView({ total, items, roles }: BuildInput): View {
  const width = pointerWidth(total);
  const ptr = (line: number) => `i${String(line).padStart(width, "0")}`;
  const get = (item: Record<string, unknown>, role: Role) => {
    const rp = roles[role];
    return rp ? getPath(item, rp.steps) : undefined;
  };
  const text = (item: Record<string, unknown>, role: Role) => scalar(get(item, role)).trim();
  const claimedPaths = rolePaths(roles);

  const keyToLine = new Map<string, number>();
  for (const [line, item] of items) {
    for (const role of ["key", "id"] as const) {
      const k = text(item, role);
      if (k && !keyToLine.has(k)) keyToLine.set(k, line);
    }
  }

  const repostOf = (item: Record<string, unknown>) => {
    const flag = get(item, "repost");
    return flag === true || flag === "true" || flag === 1;
  };

  const ownText = new Map<number, string>();
  for (const [line, item] of items) {
    if (repostOf(item)) continue;
    const n = norm(text(item, "text"));
    if (n.length >= TEXT_MATCH_MIN) ownText.set(line, n);
  }
  const lineWithText = (n: string, self: number): number | undefined => {
    for (const [line, t] of ownText) if (line !== self && sameText(t, n)) return line;
    return undefined;
  };

  type Pending = {
    kind: "quote" | "repost";
    key: string;
    text: string;
    author: string | undefined;
    lines: number[];
  };
  const pending: Pending[] = [];
  const pendingFor = new Map<string, Pending>();
  const addPending = (
    line: number,
    kind: Pending["kind"],
    raw: string,
    author: string | undefined,
  ) => {
    const n = norm(raw);
    const found = pending.find((p) => p.kind === kind && sameText(p.key, n));
    if (found) {
      found.lines.push(line);
      if (n.length > found.key.length) {
        found.key = n;
        found.text = raw;
      }
      found.author ??= author;
      pendingFor.set(`${kind}:${line}`, found);
      return;
    }
    const p: Pending = { kind, key: n, text: raw, author, lines: [line] };
    pending.push(p);
    pendingFor.set(`${kind}:${line}`, p);
  };

  type Draft = Omit<Entry, "rendered" | "snippet" | "links"> & {
    links: (Link | { kind: "quote" | "repost"; pendingKey: string })[];
    shortFields: string[];
    longFields: string[];
    time: string;
  };
  const drafts = new Map<number, Draft>();

  for (const [line, item] of items) {
    const author = text(item, "author") || undefined;
    let own = roles.text ? text(item, "text") : "";
    let reposted: string | undefined;
    const links: Draft["links"] = [];

    if (repostOf(item) && own) {
      const m = REPOST_PREFIX.exec(own);
      const content = m ? own.slice(m[0].length) : own;
      const origin = m ? `@${m[1]}` : undefined;
      reposted = content;
      own = "";
      const target = lineWithText(norm(content), line);
      if (target !== undefined) links.push({ kind: "repost", pointer: ptr(target) });
      else {
        addPending(line, "repost", content, origin);
        links.push({ kind: "repost", pendingKey: `repost:${line}` });
      }
    }

    const replyTo = text(item, "replyTo");
    const replyAuthor = text(item, "replyAuthor");
    if (replyTo || replyAuthor) {
      const parent = replyTo ? keyToLine.get(replyTo) : undefined;
      if (parent !== undefined && parent !== line)
        links.push({ kind: "reply", pointer: ptr(parent) });
      else if (replyAuthor && author && handleKey(replyAuthor) === handleKey(author)) {
        links.push({
          kind: "reply",
          note: `continues ${at(author)}'s own thread; the earlier post is not in this data`,
        });
      } else if (replyAuthor) {
        links.push({
          kind: "reply",
          note: `replies to ${at(replyAuthor)}; that post is not in this data`,
        });
      } else links.push({ kind: "reply", note: "replies to a post that is not in this data" });
    }

    const quoteText = text(item, "quote");
    const quoteAuthor = text(item, "quoteAuthor") || undefined;
    const quoteId = text(item, "quoteId");
    const quotedLine = quoteId ? keyToLine.get(quoteId) : undefined;
    if (quotedLine !== undefined && quotedLine !== line) {
      links.push({ kind: "quote", pointer: ptr(quotedLine) });
    } else if (quoteText) {
      const target = lineWithText(norm(quoteText), line);
      if (target !== undefined) links.push({ kind: "quote", pointer: ptr(target) });
      else {
        addPending(line, "quote", quoteText, quoteAuthor ? at(quoteAuthor) : undefined);
        links.push({ kind: "quote", pendingKey: `quote:${line}` });
      }
    } else if (quoteId || quoteAuthor) {
      links.push({
        kind: "quote",
        note: `quotes ${quoteAuthor ? at(quoteAuthor) : "a post"} (its text was not captured)`,
      });
    }

    const media = roles.media ? mediaMarker(get(item, "media")) : "";

    const rest: Leaf[] = [];
    leaves(item, "", rest);
    const shortFields: string[] = [];
    const longFields: string[] = [];
    for (const l of rest) {
      if (claimed(l.path, claimedPaths)) continue;
      if (l.value.length <= SHORT_MAX && !l.value.includes("\n"))
        shortFields.push(`${l.path}: ${l.value}`);
      else longFields.push(`${l.path}: ${tidy(l.value)}`);
    }

    const hasQuote = links.some((l) => l.kind === "quote" || l.kind === "repost");
    const empty = roles.text
      ? !own && !media && !hasQuote
      : !media && !hasQuote && shortFields.length === 0 && longFields.length === 0;

    drafts.set(line, {
      line,
      pointer: ptr(line),
      item,
      id: text(item, "id") || undefined,
      author,
      text: own,
      reposted,
      media,
      links,
      empty,
      hasLongField: longFields.length > 0 || own.length > SHORT_MAX || own.includes("\n"),
      shortFields,
      longFields,
      time: text(item, "time"),
    });
  }

  const qWidth = Math.max(2, String(pending.length).length);
  const blocks: Block[] = pending
    .map((p) => ({ ...p, first: Math.min(...p.lines) }))
    .sort((a, b) => a.first - b.first)
    .map((p, i) => ({
      pointer: `q${String(i + 1).padStart(qWidth, "0")}`,
      kind: p.kind,
      author: p.author,
      text: p.text,
      lines: [...p.lines].sort((a, b) => a - b),
    }));
  const blockOfPending = new Map<Pending, Block>();
  pending
    .map((p) => ({ p, first: Math.min(...p.lines) }))
    .sort((a, b) => a.first - b.first)
    .forEach(({ p }, i) => blockOfPending.set(p, blocks[i]!));

  const entries = new Map<number, Entry>();
  for (const d of drafts.values()) {
    const links: Link[] = d.links.map((l) =>
      "pendingKey" in l
        ? { kind: l.kind, pointer: blockOfPending.get(pendingFor.get(l.pendingKey)!)!.pointer }
        : l,
    );
    const facts = [
      d.author ? at(d.author) : "",
      d.time ? showTime(d.time) : "",
      ...d.shortFields,
    ].filter(Boolean);
    const head = `[${d.pointer}]${facts.length ? ` ${facts.join(" · ")}` : ""}`;
    const body: string[] = [];
    if (roles.text) {
      if (d.text) body.push(tidy(d.text));
      else if (d.reposted !== undefined) body.push("(repost)");
      else body.push("(no text)");
    }
    if (d.media) body.push(d.media);
    body.push(...d.longFields);
    for (const l of links) {
      const verb = l.kind === "reply" ? "replies to" : l.kind === "quote" ? "quotes" : "reposts";
      body.push("pointer" in l ? `> ${verb} [${l.pointer}]` : `> ${l.note}`);
    }
    const snippetSource =
      d.text || d.reposted || d.media || (d.longFields[0] ?? "") || d.shortFields.join(" · ");
    const { shortFields: _s, longFields: _l, time: _t, ...rest } = d;
    entries.set(d.line, {
      ...rest,
      links,
      rendered: [head, ...body].join("\n"),
      snippet: snippet(snippetSource),
    });
  }

  const threadKeys = new Set<string>();
  for (const e of entries.values()) {
    const t = text(e.item, "thread");
    if (t) threadKeys.add(t);
  }
  const memo = new Map<number, string>();
  const threadOf = (e: Entry, depth = 0): string => {
    const cached = memo.get(e.line);
    if (cached) return cached;
    let key = `l:${e.line}`;
    const t = text(e.item, "thread");
    const own = text(e.item, "key");
    const reply = e.links.find((l) => l.kind === "reply");
    if (t) key = `t:${t}`;
    else if (own && threadKeys.has(own)) key = `t:${own}`;
    else if (reply && "pointer" in reply && depth < 50) {
      const parent = entries.get(Number(reply.pointer.slice(1)));
      if (parent) key = threadOf(parent, depth + 1);
    } else if (reply && "note" in reply && reply.note.startsWith("continues") && e.author) {
      key = `s:${handleKey(e.author)}`;
    }
    memo.set(e.line, key);
    return key;
  };

  const all = [...entries.values()].sort((a, b) => a.line - b.line);
  const empties = all.filter((e) => e.empty);
  const live = all.filter((e) => !e.empty);
  const groupFirst = new Map<string, number>();
  for (const e of live) {
    const k = threadOf(e);
    if (!groupFirst.has(k)) groupFirst.set(k, e.line);
  }
  const sent = [...live].sort(
    (a, b) => groupFirst.get(threadOf(a))! - groupFirst.get(threadOf(b))! || a.line - b.line,
  );

  const referenced = new Set(
    sent.flatMap((e) => e.links.flatMap((l) => ("pointer" in l ? [l.pointer] : []))),
  );
  const liveBlocks = blocks.filter((b) => referenced.has(b.pointer));

  return {
    total,
    entries,
    sent,
    empties,
    blocks: liveBlocks,
    pointers: [...sent.map((e) => e.pointer), ...liveBlocks.map((b) => b.pointer)],
    width,
    hasText: roles.text !== undefined,
    hasAuthor: roles.author !== undefined,
  };
}

export function snippet(s: string, max = SNIPPET_MAX): string {
  const flat = s.replace(/\s+/g, " ").trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
}

export function renderBlock(b: Block, width: number): string {
  const who = b.author ?? "author not in the data";
  const verb = b.kind === "quote" ? "quoted by" : "reposted by";
  const ptrs = b.lines.map((line) => `i${String(line).padStart(width, "0")}`);
  const by = ptrs.length === 1 ? ptrs[0] : `${ptrs.length} items: ${ptrs.join(", ")}`;
  return `[${b.pointer}] ${who} · ${verb} ${by}\n${tidy(b.text)}`;
}

export function targetOf(view: View, pointer: string): Target | undefined {
  if (pointer.startsWith("q")) {
    const block = view.blocks.find((b) => b.pointer === pointer);
    return block ? { block } : undefined;
  }
  const line = Number(pointer.slice(1));
  const entry = view.entries.get(line);
  return entry ? { entry } : undefined;
}
