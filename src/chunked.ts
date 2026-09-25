import { collect, RANK, type Judgement } from "./checks";
import { CHARS_PER_TOKEN } from "./cost";
import type { Client } from "./gemini";
import { parseOverview, parseResponse, type Verdict } from "./parse";
import { buildWindowRepairPrompt, type Ask } from "./prompt";
import { handleKey, type View } from "./render";
import { CONCURRENCY, type Window } from "./windows";

export type WindowStatus = {
  window: number;
  items: number;
  referenced: number;
  context: number;
  ok: boolean;
  reason?: string | undefined;
  retried: boolean;
};

export type ChunkResult = {
  judged: Map<string, Judgement>;
  windowJudged: Map<string, Judgement>[];
  votes: Map<string, Verdict[]>;
  windowsOf: Map<string, number[]>;
  own: string[];
  ownFrom: Map<string, { handle: string; from: string[] }>;
  named: string[];
  overviewFailed: string | undefined;
  calls: number;
  tokens: { in: number; out: number };
  overviewTokens: { in: number; out: number };
  repaired: string[];
  duplicates: string[];
  unknown: string[];
  unparsed: number;
  aborted: string | undefined;
  fatal: boolean;
  interrupted: boolean;
  reasons: Map<string, string>;
  status: WindowStatus[];
};

export async function pool(limit: number, jobs: (() => Promise<void>)[]): Promise<void> {
  let next = 0;
  const worker = async () => {
    while (next < jobs.length) {
      const i = next++;
      await jobs[i]!();
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, jobs.length) }, worker));
}

export async function judgeInWindows(input: {
  view: View;
  plan: Window[];
  prompts: string[];
  overviewPrompt: string;
  ask: Ask;
  client: Client;
  overviewClient: Client;
  maxInputTokens: number;
  abort?: AbortSignal | undefined;
}): Promise<ChunkResult> {
  const { view, plan, prompts, ask, client, abort } = input;
  const out: ChunkResult = {
    judged: new Map(),
    windowJudged: plan.map(() => new Map()),
    votes: new Map(),
    windowsOf: new Map(),
    own: [],
    ownFrom: new Map(),
    named: [],
    overviewFailed: undefined,
    calls: 0,
    tokens: { in: 0, out: 0 },
    overviewTokens: { in: 0, out: 0 },
    repaired: [],
    duplicates: [],
    unknown: [],
    unparsed: 0,
    aborted: undefined,
    fatal: false,
    interrupted: false,
    reasons: new Map(),
    status: plan.map((w) => ({
      window: w.index + 1,
      items: w.entries.length,
      referenced: w.blocks.length,
      context: w.context.length,
      ok: false,
      reason: undefined,
      retried: false,
    })),
  };
  const contextOf = plan.map((w) => new Set(w.context.map((e) => e.pointer)));
  const promptTokens = prompts.map((p) => Math.ceil(p.length / CHARS_PER_TOKEN));
  const tooBig = promptTokens.map((t) => t > input.maxInputTokens);
  let stop = false;

  const addOwn = (handle: string, from: string) => {
    const key = handleKey(handle);
    if (!key) return;
    const known = out.ownFrom.get(key) ?? { handle: handle.replace(/^@/, ""), from: [] };
    if (!known.from.includes(from)) known.from.push(from);
    out.ownFrom.set(key, known);
  };
  const failed = (k: number, r: { reason: string; fatal: boolean }) => {
    out.status[k]!.reason = r.reason;
    if (r.reason === "interrupted") {
      out.interrupted = true;
      stop = true;
    } else if (r.fatal) {
      out.aborted ??= r.reason;
      out.fatal = true;
      stop = true;
    }
  };

  const judgeWindow = async (k: number) => {
    if (stop || tooBig[k]) return;
    const r = await client.call(prompts[k]!, abort);
    out.calls += r.attempts;
    if (!r.ok) return failed(k, r);
    out.status[k]!.ok = true;
    out.status[k]!.reason = undefined;
    out.tokens.in += r.usage.in;
    out.tokens.out += r.usage.out + r.usage.thoughts;
    const parsed = parseResponse(r.text);
    out.unparsed += parsed.unparsed.length;
    for (const h of parsed.own) addOwn(h, `window ${k + 1}`);
    const lines = parsed.lines.filter((l) => !contextOf[k]!.has(l.pointer));
    const tally = collect(lines, plan[k]!.pointers, out.windowJudged[k]!);
    out.duplicates.push(...tally.duplicates);
    out.unknown.push(...tally.unknown);
  };

  const overview = (async () => {
    const r = await input.overviewClient.call(input.overviewPrompt, abort);
    out.calls += r.attempts;
    if (!r.ok) {
      out.overviewFailed = r.reason;
      return;
    }
    out.overviewTokens.in += r.usage.in;
    out.overviewTokens.out += r.usage.out + r.usage.thoughts;
    const o = parseOverview(r.text);
    for (const h of o.own) addOwn(h, "overview");
    out.named = o.named;
  })();

  await pool(
    CONCURRENCY,
    plan.map((_, k) => () => judgeWindow(k)),
  );
  const again = out.status.flatMap((s, k) => (!s.ok && s.reason !== undefined ? [k] : []));
  if (!stop && again.length > 0) {
    for (const k of again) out.status[k]!.retried = true;
    await pool(
      CONCURRENCY,
      again.map((k) => () => judgeWindow(k)),
    );
  }
  await overview;

  plan.forEach((w, k) => {
    for (const p of w.pointers) out.windowsOf.set(p, [...(out.windowsOf.get(p) ?? []), k + 1]);
  });
  const merge = () => {
    out.judged.clear();
    out.votes.clear();
    out.windowJudged.forEach((m) => {
      for (const [p, j] of m) {
        out.votes.set(p, [...(out.votes.get(p) ?? []), j.verdict]);
        const kept = out.judged.get(p);
        if (!kept || RANK[j.verdict] > RANK[kept.verdict]) out.judged.set(p, j);
      }
    });
  };
  merge();

  if (!stop) {
    const scopes = new Map<number, string[]>();
    for (const p of view.pointers) {
      if (out.judged.has(p)) continue;
      const home = (out.windowsOf.get(p) ?? []).map((w) => w - 1).find((k) => out.status[k]!.ok);
      if (home !== undefined) scopes.set(home, [...(scopes.get(home) ?? []), p]);
    }
    await pool(
      CONCURRENCY,
      [...scopes].map(([k, scope]) => async () => {
        if (stop) return;
        const r = await client.call(
          buildWindowRepairPrompt(view, plan[k]!, plan.length, ask, scope),
          abort,
        );
        out.calls += r.attempts;
        if (!r.ok) {
          if (r.reason === "interrupted") {
            out.interrupted = true;
            stop = true;
          }
          return;
        }
        out.tokens.in += r.usage.in;
        out.tokens.out += r.usage.out + r.usage.thoughts;
        const parsed = parseResponse(r.text);
        out.unparsed += parsed.unparsed.length;
        const lines = parsed.lines.filter((l) => !contextOf[k]!.has(l.pointer));
        collect(lines, scope, out.windowJudged[k]!);
        out.repaired.push(...scope.filter((p) => out.windowJudged[k]!.has(p)));
      }),
    );
    merge();
  }

  const order = (f: string) => (f === "overview" ? 0 : Number(f.split(" ")[1]));
  for (const o of out.ownFrom.values()) o.from.sort((a, b) => order(a) - order(b));
  const rank = (from: string[]) =>
    from.includes("overview") ? 0 : Math.min(...from.map((f) => Number(f.split(" ")[1])));
  out.own = [...out.ownFrom.values()]
    .sort((a, b) => rank(a.from) - rank(b.from))
    .map((o) => o.handle);

  for (const p of view.pointers) {
    if (out.judged.has(p)) continue;
    const ks = (out.windowsOf.get(p) ?? []).map((w) => w - 1);
    let reason = "the model gave no verdict for this item, even when asked again";
    if (out.interrupted) reason = "no verdict: interrupted";
    else if (ks.length === 0) reason = "internal: askq put this item in no window";
    else if (ks.every((k) => tooBig[k])) {
      reason =
        `no verdict: its part of the data is ~${Math.min(...ks.map((k) => promptTokens[k]!)).toLocaleString("en-US")} tokens, ` +
        `over the ${input.maxInputTokens.toLocaleString("en-US")} one call takes; read it yourself`;
    } else if (ks.every((k) => !out.status[k]!.ok)) {
      const why = ks.map((k) => out.status[k]!.reason).find((r) => r !== undefined);
      reason = `no verdict: ${why ?? out.aborted ?? "its window was not sent"}`;
    }
    out.reasons.set(p, reason);
  }
  return out;
}
