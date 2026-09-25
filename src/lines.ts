export function splitLines(input: string): string[] {
  const lines = input.split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  return lines.map((l) => (l.endsWith("\r") ? l.slice(0, -1) : l));
}

export type ParsedLine =
  { ok: true; item: Record<string, unknown> } | { ok: false; reason: string };

export function parseLine(line: string): ParsedLine {
  if (line.trim().length === 0) return { ok: false, reason: "line is empty" };
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return { ok: false, reason: "line is not JSON" };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { ok: false, reason: "line is not a JSON object" };
  }
  return { ok: true, item: parsed as Record<string, unknown> };
}
