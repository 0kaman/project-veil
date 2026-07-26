# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Veil is an **AI-first browser**: it perceives the web *for* an agent, with no human
looking and no pixels rendered. The bet is that **a browser is a fallback, not a
foundation** — booting Chrome costs ~969 MB and ~2s before a single byte is read, so
every task starts as HTTP and the engine is summoned only when it must be.

Read `docs/ARCHITECTURE.md` (as-built design) and `docs/DECISIONS.md` (dated log of why
things are the way they are) before any non-trivial change. DECISIONS.md exists
specifically so choices don't get re-litigated — check it before "fixing" something that
looks odd; it's usually deliberate and the row explains why. Several rows also record
things that were tried and **withdrawn**, with the measurement that killed them.

> **This tree is the 2026-07-15 reboot.** v1's source was deleted and rebuilt; it is
> preserved in git at `9e9f3e0`. `@veil/sdk`, `@veil/server` and `@veil/cli` are gone —
> don't reintroduce references to them.

## Commands

```bash
pnpm build              # turbo build, all packages
pnpm typecheck          # tsc --noEmit gate (tsup strips types WITHOUT checking them)
pnpm check              # typecheck + build + test — the full gate
pnpm test               # Layer 1: hermetic, no Chrome, fast
pnpm test:integration   # Layer 2: real headless Chrome vs local fixtures (auto-skips w/o Chrome)

pnpm --filter @veil/core bench:replay        # replay vs the click it replaces
pnpm --filter @veil/playground bench:prune   # history pruning, replayed over recorded traces

pnpm play --auto --max-steps 60 --prompt-file packages/playground/prompts/task-fare.txt
                        # LLM-driven playground. Needs MISTRAL_API_KEY in .env and
                        # `pnpm build` first (it spawns the real MCP server).
                        # Traces every hop to traces/<ts>.trace.jsonl.
pnpm play:analyse       # escalation metric over traces/episodes.jsonl
```

**Running a single test** — `pnpm --filter @veil/core test -- prune` does **not** filter;
it silently runs the whole suite. The arg doesn't reach vitest through the pnpm script.
Use `exec`:

```bash
pnpm --filter @veil/core exec vitest run prune       # by filename pattern
pnpm --filter @veil/core exec vitest run -t "budget" # by test name
pnpm --filter @veil/core exec vitest run --config vitest.integration.config.ts act
```

Requires **Node ≥ 22** (the CDP client uses global `WebSocket`), **pnpm ≥ 10**, and
Chrome/Chromium for the act path (auto-detected, override with `CHROME_PATH`).

## Architecture

A pnpm + turbo monorepo:

| package | role |
|---|---|
| `@veil/search` | Brave API → links + snippets. Not content. Zero deps. |
| `@veil/read` | fetch → extract → prose, **no browser**. Escalates to a render only on evidence. |
| `@veil/core` | The engine. Raw CDP, session pool, behavior graph, act + replay. **Zero runtime dependencies** — keep it that way. |
| `@veil/mcp` | **The prime interface.** stdio MCP server; 8 tools. |
| `@veil/playground` | Ink terminal harness: an LLM (Mistral) drives Veil over the **real** MCP server, every hop traced. This is where you reproduce "the agent can't drive this page". |

### The ladder

Each rung is tried before the one below it, and the receipt always says which ran.

| rung | how | when |
|---|---|---|
| **SEARCH** | Brave | always first — snippets often answer outright |
| **READ** | fetch → linkedom → readability | a snippet isn't enough |
| **ACT** | Chrome + CDP + AX tree | you must click, type, or learn behaviour |
| **REPLAY** | captured request template | you've acted here once before |

`veil_read` also accepts an **open session id** — after `veil_do` drives a form to a
results page, the answer is prose that lives only in that tab.

### The act path

`SessionPool` in `packages/core/src/session.ts` is the spine — read it first.

- **`graph/`** — the behavior graph. AX tree → stable display ids → doers-first
  projection. `pipeline/stage-1-axtree.ts` (skeleton) and `stage-2-events.ts` (event
  binding, including a React Fiber walk, because React delegates to the root and
  `DOMDebugger.getEventListeners` returns `[]` on the element).
- **`browser/settle.ts`** — settled ⟺ young-network-idle AND actionable-surface stable.
- **`browser/interact.ts`** — actionability checks that refuse *with a reason*.
- **`browser/capture.ts`** — network capture with ambient-baseline filtering.
- **`browser/replay.ts`** — fire a captured request directly, refreshing tokens at fire
  time. Gated by `config.ts` — that gate is a **security boundary**, not a feature flag.

### Things that will bite you

- **The graph is a snapshot.** `backendNodeId` lives only as long as that DOM node, so a
  self-re-rendering page leaves dead handles. `act()` re-resolves once by stable display
  id and reports `reResolved`.
- **Node ids are dual.** `resolveNode()` takes internal AX ids *and* content-derived
  display ids. Chrome reassigns AX ids every run; display ids are what agents and tests
  should use.
- **Every session thinks it's the front tab, but only one is.** Chrome starves
  backgrounded renderers — sessions enable `Emulation.setFocusEmulationEnabled` or mouse
  input blocks for 5s+ on a compositor ack that never comes.
- **This codebase swallows failures on purpose** — dropped CDP frames, React-detection
  fallbacks, mutation-watcher startup. That's degradation-by-design. Set **`VEIL_DEBUG=1`**
  to surface them on stderr instead of guessing.
- **`turbo test` depends on `^build`** — build before running anything that spawns the
  MCP server, including the playground.

Env vars are tabulated in `docs/RUNBOOK.md`.

## Conventions

- **Docs are load-bearing.** ARCHITECTURE.md states plainly: *"Drift between doc and code
  is a bug."* A design change means updating `docs/ARCHITECTURE.md` **and** appending a
  dated row to `docs/DECISIONS.md` (newest first, with the why and where).
- **Measure, don't assert.** Every number in the docs is measured, and a claim that turns
  out wrong gets **withdrawn in writing** rather than quietly dropped. Several DECISIONS
  rows exist only to record a retraction and the evidence behind it.
- **The receipt principle / no silent degradation.** Every tool result leads with a
  receipt — path, cost, status, what's missing — before any content. A refusal must name
  the recovery, and that recovery must actually be reachable.
- **An affordance belongs on the node, not only in the tool description.** An agent
  decides *what to do* from the graph, then reaches for a tool; a capability that exists
  only in a tool schema is invisible at the moment of the decision.
- **Two-layer test discipline.** Pipeline/model logic gets a hermetic Layer-1 test.
  Anything wire-level, timing- or interaction-dependent needs a Layer-2 test in
  `packages/core/integration/` against a local fixture — the fake cannot catch those.
- **State that accumulates across calls needs a LOOP test and a test per SCHEME it
  models.** A fixture implementing one scheme, exercised one iteration, cannot fail.
  Three separate defects shipped past a suite that did exactly that.
- Errors thrown as `VeilError` with a typed `VeilErrorCode`. MCP tool errors return as
  clean MCP error *results* so an agent can read and recover — never as protocol failures.
- ESM throughout; relative imports carry the `.js` extension.

## Known gaps

Cross-origin iframes (OOPIF) are not captured — an empty/wrong graph on a real site is
often this. Anti-bot stealth is shallow; flight/travel aggregators defeat the browser
outright. Semantic heuristics are English-only. See the "Open / scoped future work"
section of `docs/DECISIONS.md`.
