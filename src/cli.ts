import { parseArgs } from "node:util";
import { defaultCacheDir, openCache } from "./cache";
import { extract, parsePath } from "./field";
import { createClient } from "./gemini";
import { buildPrompt } from "./prompt";
import { parseQuestions, type QuestionKind, type QuestionSpec, UsageError } from "./questions";
import { unpairedScores } from "./review";
import { createThrottle, run, splitLines } from "./runner";

const VERSION = "0.1.0";
const DEFAULT_MODEL = "gemini-3.5-flash-lite";
const DEFAULT_CONCURRENCY = 30;
const DEFAULT_MAX_COST = 1.0;

export const HELP = `askq — ask the same question of every item in a dataset

  You have N items and the same question about each. askq asks a model about one item at a
  time and gives you back a score per item, so you can read from the top instead of reading
  everything. The loop is code: every item is seen, and no item is skipped silently.

  askq decides what you read first. It is not the last reader — the answers depend on how
  you word the question, so the summary shows you a few of the items it ranked low.

Usage
  askq --field <path> --score NAME=QUESTION [more questions] < items.jsonl > out.jsonl

Questions (repeatable, answered in the order declared)
  --score  NAME=QUESTION            a whole number from 0 to 10; anchor both ends in the
                                    question text ("0 = …, 10 = …"). This is the one that
                                    orders your reading.
  --bool   NAME=QUESTION            true or false, for counting and filtering
  --choice NAME=a|b|c: QUESTION     one of the listed values, for counting

Options
  --field <path>        which part of each item the model reads: .txt, .user.name,
                        .items[0].body, or . for the whole item (required)
  --id <path>           a value from each item to carry into the output as askq_id, so you
                        can join the answers back to your data (e.g. --id .url)
  --full                put the whole input item in the output record instead of a pointer
  --why                 add <name>_why, 15 words or fewer, for every answer
  --sample <n>          run only the first n items and print them with their answers and
                        the exact prompt, to check the wording before spending on the rest
  --model <id>          default ${DEFAULT_MODEL}
  --concurrency <n>     default ${DEFAULT_CONCURRENCY}
  --into <key>          nest the answers under one key instead of merging them in
  --max-cost <usd>      refuse to start if the run is estimated over this; default ${DEFAULT_MAX_COST.toFixed(2)}
  --yes                 run anyway, past --max-cost
  --cache <dir>         default \${XDG_CACHE_HOME:-~/.cache}/askq
  --no-cache            neither read nor write the cache
  --allow-empty         0 items on stdin is not an error
  --print-prompt        print the prompt for the first item and exit, calling nothing
  --help, --version

Exit codes
  0  every item answered
  1  coverage incomplete: at least one item failed (each one is named on stderr and
     carries askq_error in the output)
  2  usage or configuration error, or the run aborted because the API rejected the
     request in a way that would repeat for every item
  3  estimated over --max-cost; nothing was sent
  130 interrupted

Output
  One JSONL line per input line, in input order, carrying askq_line (the 1-based input line),
  askq_id when --id is given, and one key per question. A failed item still gets a line, with
  askq_error, so wc -l on the input and the output must match.

Example
  jq -c '.[]' posts.json | askq \\
    --field .text --id .url \\
    --score reports_measurement='0 = no numbers at all, 10 = an explicit measurement or benchmark result' \\
    > out.jsonl

  # then read from the top (the select skips items that failed and so have no score)
  jq -sc 'map(select(.reports_measurement!=null))|sort_by(-.reports_measurement)|.[:20][]' out.jsonl

  A score is the model's graded answer to the question you wrote. Use it to decide what to
  read first; it is not a probability and not a confidence.

  Naming a --score <name>_score after a --bool <name> lets askq compare the two answers and
  mark the items where they disagree, or where the score lands mid-range, with askq_review:

    jq -c 'select(.askq_review)' out.jsonl
`;

function readStdin(): Promise<string> {
  // Without this, askq run with no pipe waits on a terminal that will never send anything.
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

function writeLine(stream: NodeJS.WriteStream, line: string): Promise<void> | void {
  const written = stream.write(line + "\n");
  if (written) return;
  return new Promise<void>((resolve) => stream.once("drain", () => resolve()));
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
        field: { type: "string" },
        bool: { type: "string", multiple: true },
        choice: { type: "string", multiple: true },
        score: { type: "string", multiple: true },
        model: { type: "string" },
        concurrency: { type: "string" },
        into: { type: "string" },
        id: { type: "string" },
        full: { type: "boolean" },
        why: { type: "boolean" },
        sample: { type: "string" },
        "max-cost": { type: "string" },
        yes: { type: "boolean" },
        cache: { type: "string" },
        "no-cache": { type: "boolean" },
        "allow-empty": { type: "boolean" },
        "print-prompt": { type: "boolean" },
        help: { type: "boolean" },
        version: { type: "boolean" },
      },
      strict: true,
      allowPositionals: false,
      tokens: true,
    });
  } catch (e) {
    stderr(`askq: ${(e as Error).message}`);
    stderr("askq: run askq --help for the flags");
    return 2;
  }

  const { values, tokens } = parsed;

  if (values.help) {
    process.stdout.write(HELP);
    return 0;
  }
  if (values.version) {
    process.stdout.write(`${VERSION}\n`);
    return 0;
  }

  try {
    const specs: QuestionSpec[] = [];
    for (const token of tokens) {
      if (token.kind !== "option") continue;
      if (token.name === "bool" || token.name === "choice" || token.name === "score") {
        specs.push({ kind: token.name as QuestionKind, spec: token.value ?? "" });
      }
    }

    const questions = parseQuestions(specs);

    const field = values.field;
    if (field === undefined) throw new UsageError("--field is required");

    const concurrency =
      values.concurrency === undefined ? DEFAULT_CONCURRENCY : Number(values.concurrency);
    if (!Number.isInteger(concurrency) || concurrency < 1) {
      throw new UsageError(`--concurrency must be a positive integer, got: ${values.concurrency}`);
    }

    const model = values.model ?? DEFAULT_MODEL;
    const why = values.why === true;

    const positiveInt = (raw: string | undefined, flag: string): number | undefined => {
      if (raw === undefined) return undefined;
      const n = Number(raw);
      if (!Number.isInteger(n) || n < 1) {
        throw new UsageError(`${flag} must be a positive integer, got: ${raw}`);
      }
      return n;
    };
    const sample = positiveInt(values.sample, "--sample");

    let maxCost: number | undefined = DEFAULT_MAX_COST;
    if (values["max-cost"] !== undefined) {
      maxCost = Number(values["max-cost"]);
      if (!Number.isFinite(maxCost) || maxCost < 0) {
        throw new UsageError(`--max-cost must be a number, got: ${values["max-cost"]}`);
      }
    }

    if (values["no-cache"] && values.cache !== undefined) {
      throw new UsageError("--cache and --no-cache cannot both be given");
    }

    for (const name of unpairedScores(questions)) {
      const base = name.slice(0, -"_score".length);
      stderr(
        `askq: warning: --score ${name} has no matching --bool or --choice ${base}; ` +
          `no agreement check for it`,
      );
    }
    for (const q of questions) {
      if (q.kind !== "score") continue;
      if (q.text.includes("0") && q.text.includes("10")) continue;
      stderr(
        `askq: warning: score question '${q.name}' does not anchor its endpoints; ` +
          `scores are often degenerate without "0 = … , 10 = …"`,
      );
    }

    if (values["print-prompt"]) {
      const lines = process.stdin.isTTY ? [] : splitLines(await readStdin());
      const first = lines[0];
      let text = "<the text your --field selects>";
      if (first !== undefined && first.trim().length > 0) {
        try {
          const item = JSON.parse(first) as unknown;
          const got = extract(item, field, parsePath(field));
          if (got.ok) text = got.text;
        } catch {
          // fall through to the placeholder: --print-prompt must never need valid input
        }
      }
      stderr(buildPrompt(text, questions, why));
      return 0;
    }

    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) throw new UsageError("GEMINI_API_KEY is not set");

    const input = await readStdin();
    const lineCount = splitLines(input).length;
    if (lineCount === 0) {
      if (values["allow-empty"]) {
        stderr("askq: 0 items");
        return 0;
      }
      throw new UsageError("no items on stdin (pass --allow-empty if that is expected)");
    }

    const throttle = createThrottle(concurrency);
    const client = createClient({
      apiKey,
      model,
      onWarn: (message) => stderr(`askq: warning: ${message}`),
      onRateLimit: () => {
        const capacity = throttle.reduce();
        stderr(`askq: warning: rate limited; concurrency reduced to ${capacity}`);
      },
    });

    const cache = values["no-cache"] ? undefined : openCache(values.cache ?? defaultCacheDir());

    const result = await run(
      input,
      {
        questions,
        field,
        model,
        concurrency,
        why,
        into: values.into,
        id: values.id,
        full: values.full === true,
        sample,
        cache,
        maxCost,
        yes: values.yes === true,
        throttle,
      },
      {
        client,
        stdout: (line) => writeLine(process.stdout, line),
        stderr,
        abort,
      },
    );
    return result.exitCode;
  } catch (e) {
    if (e instanceof UsageError) {
      stderr(`askq: ${e.message}`);
      return 2;
    }
    throw e;
  }
}
