# askq

**You have a pile of posts and one question about them.**

Three hundred tweets from a search, and you want the ones where someone reports real results. A
Discord channel's week, and you want the messages that answer how people set something up. You
can't read all of it, so you reach for one of two things. You grep, which finds the word
"benchmark" and misses every post that reports one without saying so. Or you hand the pile to a
sub-agent and tell it to read everything, and it skims, and nothing tells you what it skipped.

`askq` has a model judge every item twice and asks for a verdict each time: read, maybe or skip,
with a tag and a short reason. An item is read only when both judgements read it; one read or one
maybe makes it maybe. Up to 60 items two calls each see the whole pile; past that, overlapping
windows do (see [Limits](#limits)). Code checks that every item came back, and prints a roll-up:
leads, the read list, the maybe list, and five items it skipped, so you can check it was right to
skip them.

```bash
jq -c '.[]' tweets.json | npx askq \
  "which of these report hands-on results with a local voice model?" \
  --context "tweets from an X search; I care about latency, quality and hardware"
```

Requires Claude Code's `claude` CLI, installed and signed in: askq runs Sonnet through it, on your
Claude subscription. About 30 seconds and 7 calls for 150 tweets. `--backend gemini` uses
`GEMINI_API_KEY` instead.

## What you get back

- **The roll-up, on stdout.** Bounded, meant to be read: a header with the records path and the
  fields askq used, warnings first, the model's leads (labelled as leads to verify, each citing the
  lines it rests on), the read list, the maybe list (items one judgement read first), a spot-check of five skipped items (one per
  tag), and a checks line. Every row carries the line, the author, the tag and reason, the item's
  url and a snippet. A post that others quote is listed with an item you can open, never as a bare
  internal pointer.
- **The records, in a file.** One JSON line per input line (`askq_line`, `askq_id`, `verdict`,
  `tag`, `reason`, `item`), then one per referenced post (`askq_ref`), after a first line holding
  the run (`askq_run`). A run judged in windows adds `askq_windows` (the windows that held the
  item), and an item judged more than once carries `askq_votes` (each judgement's verdict). The
  records file goes under your temp directory by default, so scraped content can't land in a
  repo by accident; `--out FILE` to choose. The roll-up names the path once, as a shell
  assignment, and every `jq` it prints after that reads `"$R"`:

```bash
R=/tmp/askq/20260925-141503-a1b2.jsonl
jq -c 'select(.verdict=="read")' "$R"
```

- **`--out -`** puts the records on stdout and the roll-up on stderr, for pipelines.

## How it reads your data

JSONL, one item per line. Fields are recognised by name, so the common scrape shapes need no
flags; the roll-up's `roles:` line shows what was used, and a flag overrides any of them
(`--text`, `--author`, `--time`, `--id`, `--reply-to`, `--quote`; `--no-roles` for none).

- A **reply** points to its parent when the parent is in the data, and says whose post it answered
  when it isn't. A reply to your own earlier post is treated as a thread.
- A **quoted or reposted** post is shown once and pointed to: to the item itself when it is in the
  data (by id, or by matching text), otherwise once in a referenced block, with its author taken
  from a field such as `quoted_author`. A quote whose text wasn't captured is still shown as a
  quote.
- Items of one **thread** are shown next to each other.
- **Media** shows as a marker such as `[2 images, 1 video]`. A post that is only an image is still
  judged. Only an item with no text, no media and no quote is skipped without asking the model.

## What it guarantees

- **Every item gets a verdict, or says why not.** A pointer the model misses is asked for again
  once; if it is still missing, its record carries `askq_error`, the roll-up names the line, and the
  exit code is 1. In windows, a window whose call fails is sent once more before its items are
  marked; items another window judged keep that verdict.
- **It flags the model judging groups instead of items.** Five or more items sharing one reason
  word for word (within one window, when there are windows) is a warning, and each of those
  records carries `askq_review`.
- **It won't let two kinds of item be skipped:** a fragment the model says it can't make sense of,
  and a post by an account the overview names as the subject's (its creator, company or staff)
  and that wrote something in the data. Both become maybe, with a note.
- **A stalled call doesn't stall the run.** A call slower than twice the run's median (45 seconds
  at least) gets one duplicate, and the first good answer wins; after 150 seconds the call fails.
- **It never prompts.** A run that needs more calls than `--max-calls` (default 100) refuses
  before sending anything and exits 3, and askq never starts more calls than that. With
  `--backend gemini`, `--max-cost` (default $1.00) does the same by estimated dollars.

## What it does not

- **Its verdicts are not facts.** They depend on the wording of the question and on the model; two
  identical runs differ on borderline items.
- **Its leads are not findings.** Summaries of a whole set get details wrong, and a model will
  credit a quoted post to the person who quoted it. Who wrote what, in the roll-up, comes from the
  data.
- **It is not the last reader.** It orders your reading.

## How well it holds up

On a 150-tweet set with saved labels (scraped, so not in this repo), three test runs of this design
and one run of the built CLI each kept 33 of 33 items marked must-read and 14 of 14 items a blind
labelling marked substantive, in 29 to 31 seconds and 7 calls each. One dataset and one question: treat it as direction.

On an 856-item pile the same design took 74 seconds with every window started at once. askq now
runs at most 8 calls at a time, so expect a pile that size to take longer.

## Limits

Up to 60 items, two parallel calls each see them all. Posts that the items quote or repost are
judged as items too, so they count.

Above 60 items, or when the rendered pile is too long for one call, askq judges it in windows of
60 items that overlap by 30, the last one wrapping round to the start, so every item is judged by
two windows. Up to 8 calls run at once. A window keeps a thread or a reply chain together where it
can, and shows each item the posts it answers or quotes even when those sit in another window.
Alongside the windows, one overview call reads every item cut to 120 characters and names the
subject's own accounts and the terms your context names; the windows never see it, and askq's
checks use it. A last call writes the leads from the read items. The roll-up says when a run was
chunked. `--window N` (60 to 400) forces windows of N at any size of input; smaller windows lost
items worth reading in testing, so askq refuses them.

With `--backend gemini`, one call sees up to 400 items and windows overlap by 15, so an item may be
judged only once.

Over 2,000 items askq refuses, naming the cap and the count. Split a larger pile into several runs,
by time or by thread, rather than filtering it down: an item dropped to fit is never judged.

## Exit codes

|     |                                                                                      |
| --- | ------------------------------------------------------------------------------------ |
| 0   | every item has a verdict                                                             |
| 1   | coverage incomplete: some items have no verdict (`askq_error`, named in the roll-up) |
| 2   | usage error, over the item cap, or the API refused the request in a way that repeats |
| 3   | over `--max-calls`, or estimated over `--max-cost`; nothing was sent                 |
| 130 | interrupted                                                                          |

## Status

0.3.0, not published. 0.1.0 asked the question of each item in isolation; that design is in
the git history. MIT.
