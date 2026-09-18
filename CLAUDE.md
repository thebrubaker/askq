# askq

A CLI that asks the same question(s) of every item in a dataset and returns a typed
answer per item. Code runs the loop; a model answers about the one item in front of it.
Coverage is guaranteed by code: `askq` cannot skip an item without saying so.

askq orders a reader's attention; it is never the last reader. Judge a change by what it
could make a caller miss, and by how much it makes them read.

- **Stack:** TypeScript on Bun for development. Published unscoped to npm as `askq`; the
  bin must also run under plain Node so `npx askq` works without Bun installed. No
  runtime dependencies.
- **Backend:** Gemini Flash-Lite via `GEMINI_API_KEY`. One item per model call, all
  questions for that item in that call.
- **Checks:** `bun run check` (typecheck + tests, no network). Any command the help text
  or the readout prints must be run verbatim against real output before it ships.

## Data

`data/` and `.scratch/` are gitignored. Real datasets used for validation never enter git
history; test fixtures and README examples are synthetic.
