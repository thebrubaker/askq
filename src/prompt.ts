import type { Question } from "./questions";
import { whyKey } from "./schema";

export const PROMPT_VERSION = 1;

export function questionLine(q: Question): string {
  switch (q.kind) {
    case "bool":
      return `${q.name} (true/false): ${q.text}`;
    case "choice":
      return q.text
        ? `${q.name} (one of: ${q.values.join(", ")}): ${q.text}`
        : `${q.name} (one of: ${q.values.join(", ")})`;
    case "score": {
      const text = /[.!?]$/.test(q.text) ? q.text : `${q.text}.`;
      return `${q.name} (answer 0-10): ${text} Use the middle of the range for genuinely borderline items.`;
    }
  }
}

export function buildPrompt(text: string, questions: Question[], why = false): string {
  const lines = [
    "Item:",
    '"""',
    text,
    '"""',
    "",
    "Answer each question about the item above, and only about it.",
    "",
    ...questions.map(questionLine),
  ];
  if (why) {
    lines.push(
      "",
      `Also answer ${questions.map(whyKey).join(", ")}: the reason for that answer, ` +
        "15 words or fewer, about this item only.",
    );
  }
  return lines.join("\n");
}
