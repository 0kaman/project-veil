# @veil/playground

A terminal LLM playground with **Veil hardwired over MCP**. A goal goes in, an
LLM drives the behavior graph, and *every hop is traced* — so you can watch the
agent misbehave and find out why.

Built to answer one question: **when an agent fails to drive a page, whose fault
is it — the model, the graph, or the protocol?**

```bash
pnpm build                 # the playground spawns the REAL built MCP server
pnpm play                  # prompts for a goal
pnpm play "open https://github.com/login and find the sign-in button"
pnpm play --auto "..."     # no step gate
pnpm play --max-steps 50 --model mistral-large-latest "..."
```

Needs `MISTRAL_API_KEY` in `.env` at the repo root (see `.env.example`).

## Why it's wired this way

It spawns `packages/mcp/dist/server.js` **as a subprocess over stdio** rather
than importing `registerVeilTools` in-process. That's deliberate: this harness
must exercise the same path Claude Code and Claude Desktop take, protocol
serialization and all. An in-process shortcut would hide the bugs we're hunting.

`.env` sets `VEIL_DEBUG=1`, so Veil's intentionally-swallowed failures (dropped
CDP frames, React-detection fallbacks, enricher errors) surface in the stderr
pane instead of vanishing.

## Step-through

Default is **step mode**: the model picks a tool, then the call is held at a gate
until you release it — the moment to inspect what it's about to do and why.

| key | |
|---|---|
| `enter` / `space` | run the pending call |
| `x` | abort it |
| `a` | toggle auto ↔ step |
| `i` | inspector — full text of the last tool result |
| `q` | quit |

No TTY (piped, CI) → auto mode is forced and the goal must come from argv.

## What gets traced

The UI is only a view. The record is `traces/<timestamp>.trace.jsonl`, one JSON
object per event — grep it, replay it, diff two runs against each other.

| event | carries |
|---|---|
| `run.start` / `run.end` | goal, model, duration, why it stopped |
| `mcp.connect` | handshake latency, tool names |
| `mcp.stderr` | Veil's own stderr (`VEIL_DEBUG=1`) |
| `llm.request` | step, message count, tools offered, approx prompt size |
| `llm.response` | latency, finish reason, **real** token usage, cached tokens, content, tool calls |
| `tool.call` | name + full arguments |
| `tool.result` | latency, ok/error, chars, approx tokens, full text |
| `graph.observed` | node count, section counts, token size, **node ids added/removed vs the previous graph** |
| `warn` | `REPEATED_CALL`, `BAD_TOOL_ARGS`, `NODE_NOT_FOUND`, … |
| `error` | message + stack |

Token counts on `llm.*` are Mistral's real `usage`, not estimates. Per-payload
`approxTokens` is a ~4-chars/token heuristic for sizing individual tool results.
No dollar figures — prices change and guessing them would be worse than useless.

## Reading the stats bar

```
↑24k ↓45  ctx 23k · graph 800n/~18kt · tools 1 (avg 15.2s) · llm 2.0s · 2 err · 1 warn
```

- `↑ / ↓` — cumulative prompt / completion tokens for the whole run.
- `ctx` — prompt tokens of the **latest** call. This is the number that grows
  until it kills you; it turns red past 60k.
- `graph` — nodes and approx tokens of the most recent graph the model saw.
- `tools` / `llm` — call counts and average latency.

## The episodic log

Each session also distills into one line of `traces/episodes.jsonl` — an
append-only memory across every run. Where the trace is *what happened*, the
episode is *what it cost and what went wrong*, in a shape you can compare
against every other session.

```bash
pnpm play:analyse
```

Timeout detection needs **two** conditions: a duration that's constant *for a
given page* (work varies; caps don't) **and** that sits at or above the settle
cap. Constancy alone isn't evidence — google reliably takes ~4.5s and that's
just google's load time.

```
1. Timeout signatures
   Constant for a page AND ≥ the 12.0s settle cap ⇒ settle is timing out.

   ● veil_open @ https://google.com     ~14.5s ×2 ⇒ ≈ the 12.0s cap

   consistent but below the cap (just that page's load time):
     ~3.0s ×2  veil_open @ https://news.ycombinator.com
```

Two weaker heuristics were tried and rejected against real data, which is worth
knowing before "improving" this: **"any constant ≥3s"** flags ordinary load
times, and **"the same constant across different pages"** — which sounds far
more compelling — is birthday-paradox noise on a diverse corpus; it flagged 5
innocent clusters and missed the real bug, which only ever hit google.

Each episode carries turns (text, steps, outcome, tokens), per-tool latency
(p50/p95/max + every raw duration, so analysis can re-cluster), pages visited
with node/token counts, and auto-detected anomalies:

| code | means |
|---|---|
| `CONSTANT_TIME_CLUSTER` | same duration repeatedly ⇒ a timeout, not work |
| `SLOW_TOOL` | a call over 5s |
| `REPEATED_CALL` | identical call+args ⇒ the agent may be looping |
| `TOOL_ERROR` | the tool returned an error result |
| `CONTEXT_GROWTH` | prompt passed 50k tokens |
| `GRAPH_BLOAT` | one graph serialized past 10k tokens |
| `NO_PROGRESS` | a turn hit the step ceiling without answering |
| `MODEL_ERROR` | the turn threw |

Episodes are flushed on a `process.on("exit")` hook, so a crash or ctrl+c still
records one.

## Analysing a trace

```bash
# every tool call and how long it took
jq -r 'select(.kind=="tool.result") | "\(.name) \(.ms)ms \(.chars)ch \(.ok)"' traces/*.jsonl

# context growth per step
jq -r 'select(.kind=="llm.response") | "\(.step) ctx=\(.promptTokens)"' traces/*.jsonl

# everything the harness flagged
jq -r 'select(.kind=="warn") | "\(.code): \(.message)"' traces/*.jsonl
```
