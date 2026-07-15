# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Veil decomposes webpages into **Behavior Graphs** — what a page *does* (interactive
nodes, their event handlers, the API calls those fire, semantic labels), not what it
*looks like*. It is a perception format for LLM agents: 3,000–10,000 DOM nodes → 50–300
behavior nodes.

Read `docs/ARCHITECTURE.md` (as-built design) and `docs/DECISIONS.md` (dated log of why
things are the way they are) before any non-trivial change. DECISIONS.md exists
specifically so choices don't get re-litigated — check it before "fixing" something that
looks odd; it's usually deliberate and the row explains why.

## Commands

```bash
pnpm build              # turbo build, all packages
pnpm typecheck          # tsc --noEmit gate (tsup strips types WITHOUT checking them)
pnpm check              # typecheck + build + test — what CI runs
pnpm test               # Layer 1: hermetic, no Chrome, fast
pnpm test:integration   # Layer 2: real headless Chrome vs local fixtures (auto-skips w/o Chrome)
pnpm test:live          # Layer 3: real internet (example/github/MDN), gated on VEIL_LIVE=1
node packages/core/bench/replay-benchmark.mjs   # direct-replay vs simulated-click benchmark

pnpm play "open https://github.com/login and find the sign-in button"
                        # LLM-driven playground; step-gated. Needs MISTRAL_API_KEY in .env
                        # and `pnpm build` first (it spawns the real MCP server).
                        # Traces every hop to traces/<ts>.trace.jsonl.
```

**Running a single test** — `pnpm --filter @veil/core test -- prune` does **not** filter;
it silently runs the whole suite. The arg doesn't reach vitest through the pnpm script.
Use `exec`:

```bash
pnpm --filter @veil/core exec vitest run prune       # by filename pattern
pnpm --filter @veil/core exec vitest run -t "budget" # by test name
```

Requires **Node ≥ 22** (the CDP client uses global `WebSocket`; older Node crashes at
connect), **pnpm ≥ 10**, and Chrome/Chromium (auto-detected, override with `CHROME_PATH`).

## Architecture

A pnpm + turbo monorepo, three packages:

| package | role |
|---|---|
| `@veil/core` | The engine. Browser runtime (raw CDP), 5-stage pipeline, graph model + serializers. **Zero runtime dependencies** — keep it that way. |
| `@veil/mcp` | **The prime interface.** stdio MCP server; 8 tools (`veil_open/graph/do/replay/query/auth/sessions/close`). |
| `@veil/cli` | Dev/debug tool. Background daemon holds Chrome alive; thin client drives it. |
| `@veil/playground` | Ink terminal harness: an LLM (Mistral) drives Veil over the **real** MCP server, with every hop traced. This is where you reproduce "the agent can't drive this page". See its README. |

`@veil/mcp` and `@veil/cli` are **thin skins over the identical `Veil` / `VeilPage`
core — neither forks behavior.** Fix things in core, not in a skin.

### The pipeline

`VeilPage.buildGraph()` in `packages/core/src/index.ts` is the spine — read it first; it
wires all five stages in order and is where the whole system is legible:

1. **Stage 1** (`stage-1-axtree.ts`) — Accessibility tree → `BehaviorNode`s. The AX tree
   is the skeleton, *not* the DOM. `enrichStructuralEvents` synthesizes click/submit
   events from `href`/`action` for server-rendered pages Stage 2 leaves event-less.
2. **Stage 2** (`stage-2-events.ts`) — `DOMDebugger.getEventListeners` + a React Fiber
   walk (React uses event delegation, so listeners live on the root, not the element).
   Parallel batches of 20.
3. **Stage 3** (`stage-3-network.ts`) — correlates captured requests to the node that
   fired them via async initiator stack frames.
4. **Stage 4** (`stage-4-components.ts`) — React Fiber grouping, or vanilla heuristics.
5. **Stage 5** (`stage-5-semantics.ts`) — heuristic labels, then an **optional** pluggable
   LLM enricher for ambiguous nodes. Heuristics alone are a complete offline Stage 5;
   the enricher never blocks a build and never downgrades a heuristic label.

Then `pruneToNodeBudget()` drops low-value bulk links — deliberately **after** events and
semantics are known, so behavioral nodes are never the ones cut.

### Two execution tiers

- `interact()` — simulates the real DOM interaction, returns a **rebuilt graph**.
- `replay()` — fires a *captured* request template directly through the page's own fetch
  (inherits cookies/session/CSRF), returns the **API response, not a graph**. Up to 121×
  faster. A raw request changes server state; it does not drive the app's DOM.
- `execute(mode: auto|direct|simulate)` — `auto` picks direct when a template exists.

The `capturedRequests` replay cache is deliberately kept **out of the serialized graph**
(it's a replay cache, not perception). Interactions *teach* it their request the first
time they fire, via the incremental-update path.

### Things that will bite you

- **`interact()` has three navigation branches** — hard nav (`frameNavigated` → wait for
  load event), soft SPA nav (`navigatedWithinDocument`; **no load event ever fires** —
  waiting for one stalls the full 10s grace timer), and no-nav (incremental update, full
  rebuild on failure). Subframe navigations must never trigger a rebuild.
- **Node ids are dual.** `resolveNode()` accepts internal AX ids *and* content-derived
  stable display ids. Chrome reassigns internal AX ids every run; display ids are what
  agents and tests should use.
- **This codebase swallows failures on purpose** — dropped CDP frames, React-detection
  fallbacks, enricher errors, mutation-watcher startup. That's degradation-by-design, not
  sloppiness. Set **`VEIL_DEBUG=1`** to surface them on stderr instead of guessing.
- **`turbo test` depends on `^build`**, and `pnpm veil` runs `packages/cli/dist/` — build
  before running the CLI.
- **The CLI daemon is long-lived.** After a rebuild, `pnpm veil daemon stop` or you'll be
  debugging stale code.

Env vars (session limits, timeouts, node budget, settle tuning, enricher config) are
tabulated in `docs/RUNBOOK.md`.

## Conventions

- **Docs are load-bearing.** ARCHITECTURE.md states plainly: *"Drift between doc and code
  is a bug."* A design change means updating `docs/ARCHITECTURE.md` **and** appending a
  dated row to `docs/DECISIONS.md` (newest first, with the why and where).
- **Two-layer test discipline.** Pipeline/model logic gets a hermetic Layer-1 test driving
  `FakeCDPClient` (`src/__tests__/fixtures/fake-cdp.ts`). Anything wire-level, timing-, or
  interaction-dependent needs a Layer-2 test in `packages/core/integration/` against a
  local fixture — the fake cannot catch those.
- Errors thrown as `VeilError` with a typed `VeilErrorCode` (`NODE_NOT_FOUND`,
  `NODE_NOT_INTERACTIVE`, `INTERACTION_FAILED`, `NO_CAPTURE`, `REPLAY_FAILED`). MCP tool
  errors return as clean MCP error *results* so an agent can read and recover — never as
  protocol failures.
- ESM throughout; relative imports carry the `.js` extension.

## Known gaps

Cross-origin iframes (OOPIF) are not captured at all — an empty/wrong graph on a real site
is often this. Anti-bot stealth is shallow. Semantic heuristics are English-only (the
enricher is the multilingual path). See the "Open / scoped future work" section of
`docs/DECISIONS.md`.
