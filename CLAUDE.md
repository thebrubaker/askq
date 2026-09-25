# askq

A CLI that asks one question of a whole dataset and returns what to read: a verdict (read, maybe,
skip), a tag and a short reason for every item, and a bounded roll-up for the agent that asked. Up
to 400 items one model call sees them all; above that, overlapping windows of 60 do, beside an
overview pass and a leads call. Code guarantees every item comes back, or says which did not.

askq orders a reader's attention; it is never the last reader. Judge a change by what it could
make a caller miss, and by how much it makes them read.

- **Stack:** TypeScript on Bun for development. Published unscoped to npm as `askq`; the
  bin must also run under plain Node so `npx askq` works without Bun installed. No
  runtime dependencies.
- **Backend:** Gemini 3.8 Flash via `GEMINI_API_KEY`, temperature 0, `thinkingBudget: 0`, plain-text
  line output parsed by code. One question per run. Up to 400 items the whole dataset goes in one
  call; above that askq judges overlapping windows of 60, and each item keeps its highest verdict.
  Over 2,000 items it refuses.
- **Discourse first:** fields are recognised by name (text, author, time, reply-to, quote, thread,
  media, repost). A quoted, reposted or parent post is shown once and pointed to. Who wrote what
  comes from the data, never from the model.
- **Checks:** `bun run check` (typecheck + tests, no network). Any command the help text
  or the roll-up prints must be run verbatim against real output before it ships.

## Data

`data/` and `.scratch/` are gitignored. Real datasets used for validation never enter git
history; test fixtures and README examples are synthetic.
