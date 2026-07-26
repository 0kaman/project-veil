# Project Veil

An **AI-first browser** — a machine that perceives the web *for* an agent, with no
human looking and no pixels rendered.

That distinction is the whole product. Dia, Comet, Atlas and Edge are Chromium forks
with an LLM beside the viewport: a human is still the user, the AI is a passenger, and
**every page must render because someone is watching**. They are AI-*assisted*. Veil has
no viewport, so it can decline to boot a browser at all — a move they are structurally
incapable of making.

## The one idea

**A browser is a fallback, not a foundation.**

Booting Chrome costs ~969 MB, 8 processes and ~2.1s before a single byte is read. You
need it for exactly one thing: when the bytes you want don't exist until JavaScript runs,
or when the server won't talk to anything that isn't a browser. Everything else —
fetching, parsing, extracting — is cheaper without it.

So every task starts as HTTP, and the engine is summoned rather than assumed.

## The ladder

Each rung is tried before the one below it, and the receipt always says which one ran.

| rung | how | when |
|---|---|---|
| **SEARCH** | Brave API | always first — snippets often answer outright |
| **READ** | fetch → parse → extract, no browser | a snippet isn't enough |
| **ACT** | Chrome + CDP + accessibility tree | you must click, type, or learn behaviour |
| **REPLAY** | re-fire a captured request | you've acted here once before |

Escalation happens on **evidence**, never on a guess: a page whose HTML contains no
content is a JS shell, a server that refuses non-browsers is a doorman. Both are
measured, and both are stated in the receipt.

## What an agent actually sees

Not a DOM. A page reduced to **what it can do**:

```
route: /login
title: Sign in to GitHub · GitHub

ACTIONS (8)
  textbox-username-or-email-address [textbox] "Username or email address" {focused, required}  → POST /session
  button-sign-in [button] "Sign in"  → POST /session
  button-continue-with-google [button] "Continue with Google"  → GET /sessions/social/google/initiate
  button-sign-in-with-a-passkey [button] "Sign in with a passkey"
  textbox-password [textbox] "Password" {required}  → POST /session

LINKS (7) — veil_query(role:"link", name:"…") to list
```

Every line is behaviour: the arrow is the request that element actually fires, recovered
by walking React's Fiber tree — `DOMDebugger.getEventListeners` returns `[]` for GitHub's
sign-in button, because React delegates to the document root.

Links are counted, not listed. On Wikipedia that's the difference between ~9,000 tokens
and 12.

Reading a page returns prose plus a receipt, and a handle when it's truncated:

```
via: fetch · 919ms · ok · 3949 of 7418 words · handle r1
outline: Contents · HTTP · Page version status · Versions · Use
```

## The receipt principle

Every result leads with **path, cost, status, and what's missing** — before any content —
so a model knows how much to trust what follows. A refusal names the recovery, and that
recovery has to be reachable. A capped view that looks complete is the failure this
project exists to design out.

## Install

Requires **Node ≥ 22**, **pnpm ≥ 10**, and **Chrome/Chromium** for the act path.

```bash
git clone git@github.com:0kaman/project-veil.git
cd project-veil
pnpm install
pnpm build
```

Copy `.env.example` to `.env` and add a `BRAVE_API_KEY` for search.

## Use it — as an MCP server

Veil's primary interface is a **Model Context Protocol** server, so any MCP host can use
it as a native tool.

```bash
claude mcp add veil -- node /ABS/PATH/project-veil/packages/mcp/dist/server.js
```

Eight tools: `veil_search`, `veil_read`, `veil_open`, `veil_query`, `veil_do`,
`veil_replay`, `veil_sessions`, `veil_close`.

`veil_read` takes a URL, a handle from a previous read, **or an open session id** — after
`veil_do` drives a form to a results page, the answer is prose that exists only in that
tab, and re-fetching the URL would return the empty form.

`veil_replay` is **gated and off for mutations by default**. Replaying a GET wastes a
request; replaying a POST can charge a card. See [docs/RUNBOOK.md](docs/RUNBOOK.md).

## Use it — programmatically

```ts
import { SessionPool } from "@veil/core";

const pool = new SessionPool();
const { sessionId, lean } = await pool.open("https://github.com/login");
console.log(lean);

await pool.act(sessionId, "textbox-username-or-email-address", { kind: "type", value: "me" });
const { html } = await pool.html(sessionId);   // the live tab, for reading
await pool.shutdown();
```

`@veil/read` and `@veil/search` stand alone and never touch a browser:

```ts
import { Reader } from "@veil/read";
const r = await new Reader().read("https://en.wikipedia.org/wiki/HTTP");
```

## The playground

Where you reproduce "the agent can't drive this page". An LLM drives Veil over the
**real** MCP server, with every hop traced to `traces/`.

```bash
pnpm play --auto --max-steps 60 --prompt-file packages/playground/prompts/task-fare.txt
pnpm play:analyse    # escalation metric over recorded episodes
```

Needs `MISTRAL_API_KEY` in `.env`. Most of the defects fixed in this repo were found
here, by a model failing on a real site, rather than by a test.

## Testing

```bash
pnpm check             # typecheck + build + test — the full gate
pnpm test              # Layer 1 — hermetic, no Chrome
pnpm test:integration  # Layer 2 — real headless Chrome vs local fixtures
```

Two layers on purpose: anything wire-level, timing- or interaction-dependent gets a
Layer-2 test against a local fixture, because a fake cannot catch those.

## Docs

- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) — as-built design; every number measured
- [docs/DECISIONS.md](docs/DECISIONS.md) — dated log of *why*, including claims that were
  tried and **withdrawn**, with the evidence that killed them
- [docs/RUNBOOK.md](docs/RUNBOOK.md) — every env var, its default, and common situations

## Status

**Alpha, rebooted 2026-07-15.** v1 was deleted and rebuilt around the ladder; it survives
in git at `9e9f3e0`.

The search, read, act and replay tiers all work end to end against real sites, behind 144
hermetic and 47 integration tests. A representative hard task — *find the cheapest
nonstop BLR→DEL fare on a specific date* — has been completed end to end, driving a real
booking form and reading the result out of the live tab. It is not yet reliable: most
attempts still end in an honest "I could not get this and here is where I stopped."

Known limitations — cross-origin iframes are not captured at all, anti-bot stealth is
shallow enough that travel aggregators defeat the browser outright, and semantic
heuristics are English-only — are tracked in
[docs/DECISIONS.md](docs/DECISIONS.md).

## License

MIT
