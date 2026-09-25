export type Verdict = "read" | "maybe" | "skip";

export type VerdictLine = { pointer: string; verdict: Verdict; tag: string; reason: string };

export type Claim = { text: string; pointers: string[] };

export type Parsed = {
  own: string[];
  threads: string[][];
  lines: VerdictLine[];
  summary: Claim[];
  unparsed: string[];
};

const HEADER = /^(OVERVIEW|ITEMS|SUMMARY)\s*:?\s*$/i;
const POINTERS = /\b[iq]\d{2,}\b/g;
const LINE =
  /^\s*(?:[-*•]|\d+[.)])?\s*\[?([iq]\d{2,})\]?\s*[:.)\]-]?\s+(r|m|s|read|maybe|skip)\b\s*([^:]*?)\s*(?::\s*(.*))?$/i;
const BRACKETED = /\s*\[([iq]\d{2,}(?:\s*,\s*[iq]\d{2,})*)\]\s*\.?/g;

const VERDICT: Record<string, Verdict> = { r: "read", m: "maybe", s: "skip" };

const unmark = (s: string) => s.replace(/\*\*|__|`/g, "");

function verdictLine(raw: string): VerdictLine | undefined {
  const m = LINE.exec(unmark(raw));
  if (!m) return undefined;
  const verdict = VERDICT[m[2]!.toLowerCase()[0]!]!;
  let tag = (m[3] ?? "").trim().replace(/[.,;]+$/, "");
  let reason = (m[4] ?? "").trim();
  if (!m[4] && /\s/.test(tag)) {
    const [first, ...rest] = tag.split(/\s+/);
    tag = first ?? "";
    reason = rest.join(" ");
  }
  return { pointer: m[1]!.toLowerCase(), verdict, tag: tag.toLowerCase(), reason };
}

function handles(s: string): string[] {
  if (/^\s*(none|n\/a|-)\s*\.?\s*$/i.test(s)) return [];
  return s
    .split(/[,;\s]+/)
    .map((t) => t.replace(/^[([]+|[)\].,:;]+$/g, ""))
    .filter((t) => /^@?[A-Za-z0-9_]{1,30}$/.test(t) && !/^(none|and|or|the|its|staff)$/i.test(t));
}

export function parseResponse(text: string): Parsed {
  const rows = text.split("\n");
  const sawItems = rows.some(
    (r) => HEADER.exec(unmark(r).replace(/^[#\s]+/, ""))?.[1]?.toUpperCase() === "ITEMS",
  );
  const out: Parsed = { own: [], threads: [], lines: [], summary: [], unparsed: [] };
  let section = sawItems ? "" : "ITEMS";

  for (const raw of rows) {
    const bare = unmark(raw)
      .replace(/^[#\s]+/, "")
      .trim();
    if (!bare || /^```/.test(bare)) continue;
    const header = HEADER.exec(bare);
    if (header) {
      section = header[1]!.toUpperCase();
      continue;
    }
    if (section === "OVERVIEW" || (!sawItems && /^(own|threads)\s*:/i.test(bare))) {
      const kv = /^(own|threads)\s*:\s*(.*)$/i.exec(bare);
      if (kv?.[1]?.toLowerCase() === "own") out.own = handles(kv[2]!);
      else if (kv) {
        out.threads = kv[2]!
          .split("|")
          .map((g) => [...g.matchAll(POINTERS)].map((m) => m[0].toLowerCase()))
          .filter((g) => g.length > 1);
      }
      continue;
    }
    if (section === "SUMMARY") {
      const claim = bare.replace(/^(?:[-*•]|\d+[.)])\s*/, "");
      const pointers = [...claim.matchAll(POINTERS)].map((m) => m[0].toLowerCase());
      const clean = claim.replace(BRACKETED, " ").replace(/\s+/g, " ").trim();
      if (clean) out.summary.push({ text: clean, pointers: [...new Set(pointers)] });
      continue;
    }
    if (section === "ITEMS") {
      const line = verdictLine(raw);
      if (line) out.lines.push(line);
      else out.unparsed.push(raw);
    }
  }
  return out;
}
