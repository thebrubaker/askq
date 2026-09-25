import type { Judgement } from "./checks";
import type { Block, Entry, View } from "./render";

export type LineOutcome =
  | { kind: "judged"; entry: Entry; judgement: Judgement }
  | { kind: "empty"; entry: Entry }
  | { kind: "error"; entry: Entry | undefined; reason: string };

export const EMPTY_NOTE = "askq skipped it without asking the model: no text, no media, no quote";

export function lineRecord(line: number, outcome: LineOutcome): Record<string, unknown> {
  const head: Record<string, unknown> = { askq_line: line };
  if (outcome.entry) head.askq_id = outcome.entry.id ?? null;
  if (outcome.kind === "error") {
    return {
      ...head,
      askq_error: outcome.reason,
      ...(outcome.entry ? { item: outcome.entry.item } : {}),
    };
  }
  if (outcome.kind === "empty") {
    return {
      ...head,
      verdict: "skip",
      tag: "empty",
      askq_note: EMPTY_NOTE,
      item: outcome.entry.item,
    };
  }
  const j = outcome.judgement;
  return {
    ...head,
    verdict: j.verdict,
    tag: j.tag,
    ...(j.reason ? { reason: j.reason } : {}),
    ...(j.notes.length ? { askq_note: j.notes.join("; ") } : {}),
    ...(j.review ? { askq_review: j.review } : {}),
    item: outcome.entry.item,
  };
}

export function blockRecord(
  view: View,
  block: Block,
  judgement: Judgement | undefined,
  error?: string,
): Record<string, unknown> {
  const first = view.entries.get(block.lines[0]!);
  const head = {
    askq_ref: block.pointer,
    askq_kind: block.kind,
    askq_lines: block.lines,
    askq_id: first?.id ?? null,
    author: block.author ?? null,
  };
  const item = { author: block.author ?? null, text: block.text };
  if (!judgement) return { ...head, askq_error: error ?? "no verdict", item };
  return {
    ...head,
    verdict: judgement.verdict,
    tag: judgement.tag,
    ...(judgement.reason ? { reason: judgement.reason } : {}),
    ...(judgement.notes.length ? { askq_note: judgement.notes.join("; ") } : {}),
    ...(judgement.review ? { askq_review: judgement.review } : {}),
    item,
  };
}
