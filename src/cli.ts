import { randomBytes } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { UsageError } from "./errors";
import { createClient } from "./gemini";
import type { Role } from "./roles";
import { splitTerms } from "./terms";
import { MAX_ITEMS, OVERVIEW_MODEL, run, VERSION } from "./run";
import { CHUNK_ABOVE, overlapFor, WINDOW_SIZE } from "./windows";

export const DEFAULT_MODEL = "gemini-3.8-flash";
const DEFAULT_MAX_COST = 1.0;

export const HELP = `askq — ask one question of a whole dataset, get back what to read

  You have a pile of posts, messages or records and one question about them. askq hands the
  whole pile to one model call, gets a verdict for every item (read, maybe or skip, with a tag
  and a short reason), checks in code that every item came back, and prints a roll-up: leads,
  the read list, the maybe list, and five of the skipped items so you can check it was right to
  skip them. Every item's verdict goes to a records file the roll-up names.

  askq decides what you read first. It is not the last reader.

Usage
  askq "QUESTION" [--context TEXT] < items.jsonl

  jq -c '.[]' tweets.json | askq "which report hands-on results with a local voice model?" \\
    --context "tweets from an X search; I care about latency, quality and hardware"

Input
  JSONL, one item per line. Fields are recognised by name, so the known scrape shapes need no
  flags; the roll-up's roles: line shows what askq used. Name a field to override:
  --text PATH       the post's text (text, txt, content, body, ...)
  --author PATH     who wrote it (author, handle, username, ...)
  --time PATH       when (created_at, createdAt, time, ...)
  --id PATH         what the roll-up shows to open an item (url, permalink, else id)
  --reply-to PATH   the id of the post it replies to (reply_to_id, inReplyToId, parent_id, ...)
  --quote PATH      the text of the post it quotes (quoted_text, quotedText, quoted, ...)
  --no-roles        recognise nothing; show the model every field as key: value
  Also recognised: quoted_author / quotedHandle, quotedId, reply_to_author / inReplyToHandle,
  thread_root_id / conversation_id, media, isRT.

  A reply points to its parent when the parent is in the data. A quoted or reposted post is shown
  once and pointed to. An item with no text, no media and no quote is skipped without asking the
  model; a post that is only an image or a video is still judged.

Output
  stdout      the roll-up: bounded, meant to be read
  records     one JSON line per input line (askq_line, askq_id, verdict, tag, reason, item), then
              one per referenced post (askq_ref); first line is the run (askq_run). Default path is
              under ${join(tmpdir(), "askq")}; --out FILE to choose.
  --out -     records to stdout and the roll-up to stderr, for pipelines

Options
  --context TEXT    what you already know and what you care about, in your own words
  --watch "A, B"    terms to track: the roll-up says how every item naming one was judged,
                    alongside the terms the model finds named in --context
  --model ID        default ${DEFAULT_MODEL}
  --max-cost USD    refuse to start if the run is estimated over this; default ${DEFAULT_MAX_COST.toFixed(2)}
  --yes             run anyway, past --max-cost
  --print-prompt    print the exact prompt and exit, calling nothing
  --help, --version

Advanced
  --window N        judge in windows of N items, overlapping by N/4, at any size; without it
                    askq uses windows of ${WINDOW_SIZE} only above ${CHUNK_ABOVE} items

Limits
  Up to ${CHUNK_ABOVE} items (posts plus referenced posts), one call sees them all. Above that, askq judges
  them in windows of ${WINDOW_SIZE} that overlap by ${overlapFor(WINDOW_SIZE)}, each window seeing only its own items and the
  posts they answer or quote; an overview pass over every item (${OVERVIEW_MODEL}) names the
  subject's own accounts and the context's terms, and a last call writes the leads. An item judged
  in two windows keeps the higher verdict, so the maybe list runs longer than one call's would.
  Over ${MAX_ITEMS.toLocaleString("en-US")} items askq refuses, naming the cap.

Exit codes
  0    every item has a verdict
  1    coverage incomplete: some items have no verdict (askq_error in the records, named in the roll-up)
  2    usage error, over the item cap, or the API refused the request in a way that would repeat
  3    estimated over --max-cost; nothing was sent
  130  interrupted
`;

const V1_FLAGS = new Set([
  "score",
  "bool",
  "choice",
  "field",
  "why",
  "full",
  "into",
  "sample",
  "concurrency",
  "cache",
  "no-cache",
  "allow-empty",
]);

function readStdin(): Promise<string> {
  if (process.stdin.isTTY) {
    throw new UsageError("no input on stdin: pipe JSONL in, one item per line");
  }
  return new Promise((resolve, reject) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => (data += chunk));
    process.stdin.on("end", () => resolve(data));
    process.stdin.on("error", reject);
  });
}

export function closingLine(where: {
  recordsToStdout: boolean;
  path: string;
  stdoutIsTTY: boolean;
}): string {
  if (where.recordsToStdout) return "askq: the records went to stdout and the roll-up to stderr";
  const rollup = where.stdoutIsTTY ? "the roll-up is above" : "the roll-up went to stdout";
  return `askq: ${rollup}; the records are in ${where.path}`;
}

function defaultRecordsPath(): string {
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15);
  return join(tmpdir(), "askq", `${stamp}-${randomBytes(2).toString("hex")}.jsonl`);
}

export async function main(argv: string[], abort?: AbortSignal): Promise<number> {
  const stderr = (line: string) => {
    process.stderr.write(line + "\n");
  };

  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      options: {
        context: { type: "string" },
        watch: { type: "string", multiple: true },
        id: { type: "string" },
        text: { type: "string" },
        author: { type: "string" },
        time: { type: "string" },
        "reply-to": { type: "string" },
        quote: { type: "string" },
        "no-roles": { type: "boolean" },
        out: { type: "string" },
        model: { type: "string" },
        "max-cost": { type: "string" },
        yes: { type: "boolean" },
        "print-prompt": { type: "boolean" },
        window: { type: "string" },
        help: { type: "boolean" },
        version: { type: "boolean" },
      },
      strict: true,
      allowPositionals: true,
    });
  } catch (e) {
    const message = (e as Error).message;
    const flag = /'--?([\w-]+)/.exec(message)?.[1];
    stderr(`askq: ${message}`);
    if (flag && V1_FLAGS.has(flag)) {
      stderr(
        `askq: --${flag} was askq 0.1. askq ${VERSION} takes one question as its argument and judges the whole ` +
          `dataset at once: askq "which of these should I read for X?" < items.jsonl`,
      );
    } else {
      stderr("askq: run askq --help for the flags");
    }
    return 2;
  }

  const { values, positionals } = parsed;
  if (values.help) {
    process.stdout.write(HELP);
    return 0;
  }
  if (values.version) {
    process.stdout.write(`${VERSION}\n`);
    return 0;
  }

  try {
    if (positionals.length === 0)
      throw new UsageError('no question: askq "QUESTION" < items.jsonl');
    if (positionals.length > 1) {
      throw new UsageError(
        `one question per run, got ${positionals.length} arguments (quote the question; run askq once per question)`,
      );
    }
    const question = positionals[0]!.trim();
    if (!question) throw new UsageError("the question is empty");

    let maxCost: number | undefined = DEFAULT_MAX_COST;
    if (values["max-cost"] !== undefined) {
      maxCost = Number(values["max-cost"]);
      if (!Number.isFinite(maxCost) || maxCost < 0) {
        throw new UsageError(`--max-cost must be a number, got: ${values["max-cost"]}`);
      }
    }

    const flags: Partial<Record<Role, string>> = {};
    if (values.id !== undefined) flags.id = values.id;
    if (values.text !== undefined) flags.text = values.text;
    if (values.author !== undefined) flags.author = values.author;
    if (values.time !== undefined) flags.time = values.time;
    if (values["reply-to"] !== undefined) flags.replyTo = values["reply-to"];
    if (values.quote !== undefined) flags.quote = values.quote;

    let window: number | undefined;
    if (values.window !== undefined) {
      window = Number(values.window);
      if (!Number.isInteger(window) || window < 4 || window > CHUNK_ABOVE) {
        throw new UsageError(
          `--window must be a whole number of items from 4 to ${CHUNK_ABOVE}, got: ${values.window}`,
        );
      }
    }

    const model = values.model ?? DEFAULT_MODEL;
    const printPrompt = values["print-prompt"] === true;
    const apiKey = process.env.GEMINI_API_KEY;
    if (!printPrompt && !apiKey) throw new UsageError("GEMINI_API_KEY is not set");

    const input = await readStdin();

    const toStdout = values.out === "-";
    const path = toStdout ? "(stdout)" : resolve(values.out ?? defaultRecordsPath());
    const rollupOut = toStdout ? stderr : (line: string) => void process.stdout.write(line + "\n");
    let written = false;
    const recordsOut = {
      path,
      write: (lines: string[]) => {
        written = true;
        const body = lines.join("\n") + "\n";
        if (toStdout) {
          process.stdout.write(body);
          return;
        }
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, body);
      },
    };

    const code = await run(
      input,
      {
        ask: { question, context: values.context },
        flags,
        autodetect: values["no-roles"] !== true,
        model,
        maxCost,
        yes: values.yes === true,
        printPrompt,
        watch: (values.watch ?? []).flatMap(splitTerms),
        window,
      },
      {
        client: () =>
          createClient({
            apiKey: apiKey ?? "",
            model,
            onRetry: (reason) => stderr(`askq: retrying: ${reason}`),
          }),
        overviewClient: () =>
          createClient({
            apiKey: apiKey ?? "",
            model: OVERVIEW_MODEL,
            onRetry: (reason) => stderr(`askq: retrying the overview: ${reason}`),
          }),
        rollupOut,
        recordsOut,
        notice: stderr,
        abort,
      },
    );
    if (written) {
      stderr(
        closingLine({
          recordsToStdout: toStdout,
          path,
          stdoutIsTTY: process.stdout.isTTY === true,
        }),
      );
    }
    return code;
  } catch (e) {
    if (e instanceof UsageError) {
      stderr(`askq: ${e.message}`);
      return 2;
    }
    throw e;
  }
}
