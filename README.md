# askq

**You have N items and the same question about each.**

Four hundred scraped posts, and you want the ones that report a real measurement. A day of
log lines, and you want the ones where a user was actually blocked. Two hundred transcripts,
and you want the ones where the agent gave up.

There are too many to read, so you reach for one of two things. You grep for keywords and
sort by something, which finds the word "benchmark" and misses every post that reports one
without saying so. Or you hand the pile to a cheaper model and tell it to read everything,
and it skims, because nothing makes it do otherwise, and nothing tells you what it skipped.

`askq` is the third option. Code runs the loop, so every item is looked at. A model answers
about one item at a time, so it has nothing to skim. You get a score per item and a short
readout that tells you what to read first, what is borderline, and what it ranked low, so
you can check it was right to.

```bash
jq -c '.[]' posts.json | npx askq \
  --field .text --id .url \
  --score reports_measurement='0 = no numbers at all, 10 = an explicit measurement or benchmark result' \
  > out.jsonl
```

Requires `GEMINI_API_KEY`. Well under a cent per hundred short items.

## What you get back

The readout, on stderr. This is the real output of the command above on 16 items:

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

Three lists, and each one is a thing to do: read the top, read the borderline items
yourself, and glance at the five it ranked low. If one of those five is what you were after,
your question was off. Reword it and run again; unchanged items are cached, so you only pay
for what changed.

The answers, on stdout, one line per input line:

```json
{"askq_line":1,"askq_id":"https://example.com/p/1","reports_measurement":10}
{"askq_line":2,"askq_id":"https://example.com/p/2","reports_measurement":5,"askq_review":"mid-range reports_measurement (5)"}
{"askq_line":3,"askq_id":"https://example.com/p/3","reports_measurement":0}
```

Records are pointers (the line number, plus whatever `--id` names), not your items. Items can
be whole transcripts, and forgetting `> out.jsonl` should not pour the corpus into your
terminal or your agent's context. `--full` puts the items back.

askq has no sorting or filtering flags. The output is JSONL, and `jq` already does that:

```bash
jq -sc 'map(select(.reports_measurement!=null))|sort_by(-.reports_measurement)|.[:20][]' out.jsonl
jq -c 'select(.askq_review)' out.jsonl
```

## Why it shows you what it ranked low

A badly worded question does not fail. It returns a full set of healthy-looking answers, and
nothing in the counts tells you it was the wrong question. The only cheap check is to look at
a few of the items that were about to go unread, so the readout prints five of them every
time, without being asked.

Line 2 in the run above is the case to watch:

> 1/6 We benchmarked four embedding models on our own support corpus. Results in this thread.

It contains no numbers, so a question about measurements scores it a 5, not a 10. That is a
correct answer to the question as written. It is also the opening post of the thread whose
later parts scored 10, and anyone hunting benchmarks wants it. askq marked it borderline
rather than burying it. Had it scored 0, it would have been a candidate for the spot-check.

It is cheap to look at a few discards, and expensive to never look at all.

## What it guarantees

- **Every item is seen.** One input line produces exactly one output line, in input order,
  and each record carries its own `askq_line`. `wc -l` on the input and the output must match.
- **No silent drops.** An item that fails (an API error, a missing or empty field, a line
  that is not JSON) still produces a line, carrying `askq_error`, and is named on stderr. The
  exit code is non-zero. `jq -c 'select(.askq_error)' out.jsonl` lists every hole.
- **A model never sees two items at once.** One call per item: no cross-contamination, no
  position bias, and no item quietly dropped from a batch.
- **Interrupting it still accounts for everything.** Ctrl-C or a `timeout` finishes the
  requests in flight, marks the rest, prints the readout, and exits 130.
- **It never prompts.** A run estimated over `--max-cost` (default $1.00) refuses before
  sending anything and exits 3.

## What it does not

- **Its answers are not facts.** They depend on how you worded the question. On the labelled
  set below, rewording moved answer agreement from 76% to 92% on the same items.
- **A score is not a probability or a confidence.** It is the model's graded answer to the
  question you wrote. Nothing here is calibrated.
- **It is not the last reader.** It orders your reading. What you conclude is still yours.

## How good is the order?

Measured against a blind reference labelling of 40 scraped posts (14 labelled as wanted, 2
with no text to answer about), with two wordings of the same question, one loose and one
sharp:

|                                   | loose wording | sharp wording |
| --------------------------------- | ------------- | ------------- |
| wanted items found in the ranking | 13 of 14      | 13 of 14      |
| items you read to get there       | 16 of 38      | 15 of 38      |
| items you read to get all 14      | 24 of 38      | 22 of 38      |
| answer agreement with the labels  | 76%           | 92%           |

The order held up when the wording changed; the true/false answers did not. That is the
argument for using the score to decide what to read first, and for not treating the answers
as conclusions.

One wanted item was buried by both wordings: it scored 2 either way, landing 24th and 21st of 38. That is what a false negative looks like here: a real item sitting below where anyone
would stop reading. Both times it was in the low band the spot-check draws from, and both
times it was among the five shown.

The sample is small, so treat this as direction. Five slots drawn from a pool of seventeen
catching that item is partly luck. The claim is that a buried item lands in the pool the
spot-check samples, not that five slots reliably catch it.

## Writing the question

The wording is the program. Two habits cover most of it:

- **Anchor both ends of a score**: `0 = …, 10 = …`. An unanchored score clusters at the top
  and stops ordering anything.
- **Check the wording on a few items first.** `--sample 10` runs ten items and prints each
  with its answers and the exact prompt that was sent.

`--bool` and `--choice` exist for counting (`--choice stance='positive|skeptical|neutral: the
author's stance toward the tool'`). A `--score` named `<name>_score` is read as the graded
version of the `--bool` named `<name>`; when the two disagree, the item is marked
`askq_review` and listed as borderline. That is a second opinion from the same model, not an
error detector.

```bash
askq --field .text \
  --bool substantive='Reports a measurement or a specific technical claim; not promotion' \
  --score substantive_score='0 = pure promotion, 10 = concrete numbers or a falsifiable claim'
```

## Flags

| flag                                        |                                                                                        |
| ------------------------------------------- | -------------------------------------------------------------------------------------- |
| `--field <path>`                            | which part of each item the model reads (`.text`, `.user.name`, `.items[0].body`, `.`) |
| `--score NAME=Q`                            | a 0-10 answer. This orders your reading.                                               |
| `--bool NAME=Q`, `--choice NAME=a\|b\|c: Q` | for counting and filtering                                                             |
| `--id <path>`                               | carry a value from each item into the output as `askq_id`, to join on                  |
| `--full`                                    | put the whole input item in the output record instead of a pointer                     |
| `--sample <n>`                              | run the first n items and show answers and the exact prompt                            |
| `--why`                                     | add `<name>_why`, 15 words or fewer, per answer                                        |
| `--model <id>`                              | default `gemini-3.5-flash-lite`                                                        |
| `--max-cost <usd>`, `--yes`                 | the cost guard and its override                                                        |

`askq --help` has the rest.

## Exit codes

|     |                                                                                                                |
| --- | -------------------------------------------------------------------------------------------------------------- |
| 0   | every item answered                                                                                            |
| 1   | coverage incomplete: at least one item failed, each named on stderr and carrying `askq_error`                  |
| 2   | usage error, or the run aborted because the API rejected the request in a way that would repeat for every item |
| 3   | estimated over `--max-cost`; nothing was sent                                                                  |
| 130 | interrupted                                                                                                    |

## For agents

If you run coding agents, this is the line that gets them to reach for it:

> I have N items and the same question about each → `askq`. Don't regex for meaning, and
> don't send a sub-agent to "read everything"; it will skim. Read the readout, then the top
> of the ranking, the borderline items, and the spot-check.

## Status

0.1.0. Gemini only, JSONL on stdin only. MIT.
