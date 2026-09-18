# askq

**You have N items and the same question about each.**

Scraped posts, log lines, transcripts, search results, a directory of files. You want to know
which ones are worth your attention, and there are too many to read.

`askq` asks a model about one item at a time and gives you a score per item, so you can read
from the top instead of reading everything. The loop is code: every item is seen, and no item
is skipped without askq saying so.

It decides what you read **first**. It is not the last reader.

```
npx askq --help
```

Requires `GEMINI_API_KEY`.

## Use it

JSONL on stdin, JSONL on stdout.

```bash
jq -c '.[]' posts.json | askq \
  --field .text --id .url \
  --score reports_measurement='0 = no numbers at all, 10 = an explicit measurement or benchmark result' \
  > out.jsonl
```

Answers go to stdout, one line per input line:

```json
{"askq_line":1,"askq_id":"https://example.com/p/1","reports_measurement":10}
{"askq_line":2,"askq_id":"https://example.com/p/2","reports_measurement":5,"askq_review":"mid-range reports_measurement (5)"}
{"askq_line":3,"askq_id":"https://example.com/p/3","reports_measurement":0}
```

The readout goes to stderr. This is the real output of the command above on 16 items:

```
askq: 16 items · 16 answered · 0 failed · 1.0s · 16 calls · 1,395 in + 209 out tokens · ~$0.0009
askq: cache 0 hit / 16 miss
  reports_measurement  0-3 8  4-6 1  7-10 7   mean 4.5  distinct 4
askq: read from the top — highest reports_measurement first:
askq:   [ 1] 10  We cut p95 latency from 840ms to 120ms by moving the tokenizer off the r
askq:   [ 4] 10  4/6 bge-small: 61% recall@5 at 12ms. text-embedding-3-small: 68% recall@
askq:   [ 6] 10  Our index rebuild dropped from 43 minutes to 6 by batching writes at 5k
askq:   [ 8] 10  Reranking added 180ms of latency for a 4-point gain in recall. We kept i
askq:   [12] 10  We ran the same eval twice and got 71% and 78%. Variance that big means
askq:   … 5 more, lines 14 10 2 3 5
askq:   read on: jq -sc 'map(select(.reports_measurement!=null))|sort_by(-.reports_measurement)|.[10:][]' <output file>
askq: borderline — 1 of 16 worth reading yourself (6.3%): lines 2
askq:   1 mid-range `reports_measurement`
askq:   jq -c 'select(.askq_review)' <output file>
askq: spot-check — 5 of the 6 items askq scored 3 or below:
askq:   [ 7]  0  gm builders. today is a great day to ship something small.
askq:   [ 9]  0  Unsure how to get started? Run npx create-thing@latest and follow the pr
askq:   [11]  0  This changes everything for AI agents. Absolute game changer. Cannot wai
askq:   [13]  0  Quick reminder that our webinar on agentic workflows starts in one hour.
askq:   [15]  0  i think people underestimate how much of retrieval quality is just clean
askq:   if any of those is what you were looking for, the question is wrong — reword it
askq:   and re-run. askq decides what you read first, not what you skip.
askq: coverage complete: 16/16 answered
```

Then read on with `jq`. askq has no sorting or filtering flags; the output is a JSONL file and
`jq` already does that:

```bash
jq -sc 'map(select(.reports_measurement!=null))|sort_by(-.reports_measurement)|.[:20][]' out.jsonl
jq -c 'select(.askq_review)' out.jsonl
```

## Why the spot-check exists

A badly worded question does not fail. It returns a full set of healthy-looking answers, and
nothing in the counts tells you it was the wrong question. The only cheap check is to look at
a few of the items askq decided were not worth reading — so the readout prints five of them
every time, without being asked.

Line 2 in the run above is the case to watch. It reads:

> 1/6 We benchmarked four embedding models on our own support corpus. Results in this thread.

It contains no numbers, so a question asking for measurements scores it a 5 rather than a 10 —
correctly. But it is the opening post of the thread whose later parts scored 10, and a reader
hunting benchmarks wants it. askq flagged it as borderline rather than burying it. Had it
scored 0 and landed in the spot-check instead, you would have seen it there.

That is the whole shape of the tool: it is cheap to look at the discards, and expensive to
never look at all.

## What it guarantees

- **Every item is seen.** One input line produces exactly one output line, in input order, and
  each record carries its own `askq_line`. `wc -l` on the input and the output must match.
- **No silent drops.** An item that fails — an API error, a missing or empty field, a line that
  is not JSON — still produces a line, carrying `askq_error`, and is named on stderr. The exit
  code is non-zero. `jq -c 'select(.askq_error)' out.jsonl` lists every hole.
- **A model never sees two items at once.** One call per item, so there is no cross-contamination
  and no position bias, and an item cannot be dropped from a batch without anyone noticing.
- **Interrupting it still accounts for everything.** Ctrl-C or a `timeout` finishes the requests
  in flight, marks the rest, prints the readout, and exits 130.

## What it does not

- **Verdicts are not facts.** They depend on how you worded the question. On the labelled set
  below, rewording moved verdict agreement from 76% to 92% on the same items.
- **It is not a probability or a confidence.** A score is the model's graded answer to the
  question you wrote. Nothing here is calibrated.
- **It is not the last reader.** It orders your reading. Read the top, read the borderline
  items, glance at the spot-check.

## How good is the order?

Measured against a 40-item blind reference labelling (**n = 40**, 14 labelled as wanted, 2 with
no text to answer about). Two wordings of the same question — a loose one and a sharp one:

|                                   | loose wording | sharp wording |
| --------------------------------- | ------------- | ------------- |
| wanted items found in the ranking | 13 of 14      | 13 of 14      |
| items you read to get there       | 16 of 38      | 15 of 38      |
| items you read to get all 14      | 24 of 38      | 22 of 38      |
| verdict agreement with the labels | 76%           | 92%           |

The order held up when the wording changed; the verdicts did not. That is the argument for
using the score to decide what to read first and not treating the answers as conclusions.

One wanted item was buried by both wordings: it scored 2 either way, landing 24th and 21st of 38. That is what a false negative actually looks like — not a missing row, but a real item
sitting below where anyone would stop reading. It was in the low band both times, which is the
pool the spot-check draws from, and the content-hash selection did put it among the five shown
under both wordings.

n is small. Treat this as direction, not proof — and note that five slots drawn from a pool of
seventeen catching that item is partly luck. The claim is that a buried item lands in the pool
the spot-check samples, not that five slots reliably catch it.

## Flags worth knowing

| flag                                        |                                                                                                                                |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `--field <path>`                            | which part of each item the model reads (`.text`, `.user.name`, `.items[0].body`, `.`)                                         |
| `--score NAME=Q`                            | a 0-10 answer; anchor both ends in the wording (`0 = …, 10 = …`). This orders your reading.                                    |
| `--bool NAME=Q`, `--choice NAME=a\|b\|c: Q` | for counting and filtering                                                                                                     |
| `--id <path>`                               | carry a value from each item into the output as `askq_id`, to join on                                                          |
| `--full`                                    | put the whole input item in the output record instead of a pointer                                                             |
| `--sample <n>`                              | run the first n items and print them with their answers and the exact prompt, to check the wording before spending on the rest |
| `--why`                                     | add `<name>_why`, 15 words or fewer, per answer                                                                                |

Records carry pointers rather than your items on purpose: items can be transcripts, and
forgetting `> out.jsonl` should not pour the corpus back into your terminal. `--full` restores
them.

Runs are cached on the content of (item, question wording, model), so re-running while you tune
the wording only pays for what actually changed. A run estimated over `--max-cost` (default
$1.00) refuses before sending anything and exits 3; it never prompts.

## Naming a score after a bool

A `--score` named `<name>_score` is read as the graded version of the `--bool` named `<name>`.
When the two disagree — `true` with a low score, or `false` with a high one — askq marks the
item with `askq_review` and lists it as borderline. It is a cheap second opinion from the same
model, not an error detector.

```bash
askq --field .text \
  --bool substantive='Reports a measurement or a specific technical claim; not promotion' \
  --score substantive_score='0 = pure promotion, 10 = concrete numbers or a falsifiable claim'
```

## Exit codes

|     |                                                                                                                |
| --- | -------------------------------------------------------------------------------------------------------------- |
| 0   | every item answered                                                                                            |
| 1   | coverage incomplete: at least one item failed, each named on stderr and carrying `askq_error`                  |
| 2   | usage error, or the run aborted because the API rejected the request in a way that would repeat for every item |
| 3   | estimated over `--max-cost`; nothing was sent                                                                  |
| 130 | interrupted                                                                                                    |

## Status

Pre-release, single user. Gemini via `GEMINI_API_KEY`; default model `gemini-3.5-flash-lite`.
