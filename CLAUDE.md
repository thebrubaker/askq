# askq

A CLI that asks one question of a whole dataset and returns what to read: a verdict (read, maybe,
skip), a tag and a short reason for every item, and a bounded roll-up for the agent that asked.
Every item is judged twice: up to 60 items two calls each see them all; above that, windows of 60
overlapping by 30 (the last wrapping round) do, beside an overview pass and a leads call. An item is
read only when both judgements read it. Code guarantees every item comes back, or says which did not.

askq orders a reader's attention; it is never the last reader. Judge a change by what it could
make a caller miss, and by how much it makes them read.

- **Stack:** TypeScript on Bun for development. Published unscoped to npm as `askq`; the
  bin must also run under plain Node so `npx askq` works without Bun installed. No
  runtime dependencies.
- **Backend:** Sonnet through Claude Code's `claude` CLI (`claude -p` with tools, MCP, settings,
  hooks and session persistence stripped, run from a temp directory), on the user's subscription.
  askq checks the CLI is installed and signed in (`claude auth status`), runs at most 8 calls at
  once, hedges a stalled call once and caps a run's calls with `--max-calls` (default 100). Reasons
  on every line, skip lines included: without them Sonnet judges groups. `--backend gemini` keeps
  Gemini 3.8 Flash via `GEMINI_API_KEY` (one call up to 400 items, windows overlapping by 15),
  opt-in only. Plain-text line output parsed by code. One question per run. Over 2,000 items it
  refuses.
- **Discourse first:** fields are recognised by name (text, author, time, reply-to, quote, thread,
  media, repost). A quoted, reposted or parent post is shown once and pointed to. Who wrote what
  comes from the data, never from the model.
- **Checks:** `bun run check` (typecheck + tests, no network). Any command the help text
  or the roll-up prints must be run verbatim against real output before it ships.

## Data

`data/` and `.scratch/` are gitignored. Real datasets used for validation never enter git
history; test fixtures and README examples are synthetic.
