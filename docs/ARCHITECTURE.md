# Veil — Architecture (as-built)

> This doc describes what the code **actually does today**, not aspirations. When
> a decision changes the design, update this file and add a dated row to
> [DECISIONS.md](./DECISIONS.md). Drift between doc and code is a bug.
>
> Last reconciled: 2026-07-12.

## What Veil is

Veil is an **AI-first browser**: it decomposes any webpage into a **Behavior
Graph** — a compact, structured description of what a page *does* (its
interactive elements, the event handlers on them, the API calls those trigger,
and the semantic purpose of each), instead of the thousands of DOM nodes a page
*is*.

The product is really a **perception format for agents**. A raw DOM is 3,000–
10,000 nodes of mostly-visual noise; a Behavior Graph is 50–300 nodes an LLM can
actually reason over:

```
PAGE https://github.com/login "Sign in to GitHub"
NODES
  form-5 [form]  on:submit → form_submit (POST /session)  semantic: auth:login (0.85)
    textbox-username [textbox] "Username or email address"  semantic: auth:identifier-input (0.70)
    textbox-password [textbox] "Password"                   semantic: auth:password-input (0.90)
    button-sign-in  [button]  "Sign in"                     semantic: form:submit (0.75)
```

## Packages

A pnpm + turbo monorepo. Three packages:

| package | role |
|---|---|
| `@veil/core` | The engine: browser runtime (raw CDP), the 5-stage pipeline, the graph model + serializers. Zero runtime dependencies. |
| `@veil/mcp` | **The prime interface.** An MCP server exposing the engine to any MCP client (Claude Code, Claude Desktop, agent runtimes) over stdio. |
| `@veil/cli` | A developer/debug interface over the same engine: a background daemon holds Chrome alive; a thin client drives it. Demoted from prime to dev-tool when MCP landed. |

Both `@veil/mcp` and `@veil/cli` are thin skins over the identical `Veil` /
`VeilPage` core — neither forks behavior.

## The core engine (`@veil/core`)

### Browser runtime — raw CDP

Veil speaks **Chrome DevTools Protocol directly over a WebSocket** (no Playwright/
Puppeteer). The pipeline makes thousands of accessibility and event-listener
queries per page; a Node relay per call would be prohibitive, and CDP's
event-driven subscriptions (mutations, network) are what the instrumentation
layer needs.

- `browser/launcher.ts` — spawns headless Chrome with a unique temp `--user-data-
  dir`; auto-detects the binary (`CHROME_PATH`, macOS default, or `google-chrome`).
  Reaps the process + temp dir on **every** failure path, not just success.
- `browser/cdp-client.ts` — a hardened WebSocket JSON-RPC client. The message
  handler never throws to the event loop (a malformed frame is dropped, not
  fatal); sends after close fail fast; event handlers are isolated.
- `browser/page.ts` — a per-tab CDP session (`PageHandle`). Each `Veil.open()`
  creates its **own** tab (`freshTarget`) so concurrent sessions can't hijack one
  another's page; `close()` closes the tab, not just the socket.
  Also **`awaitQuiescence`** — the event-driven settle every navigation and
  interaction waits on. It asks the injected `window.__veil.whenQuiet()` (page-
  side; a host-side fallback covers strict-CSP pages where injection is blocked)
  to report when the page has stopped reacting: DOM quiet **and** no *young*
  in-flight request, for `VEIL_QUIET_MS` (40). **Only young requests count.** A
  request in flight past `VEIL_LONGPOLL_MS` (2s) is a persistent connection —
  long-poll, SSE-over-XHR, keepalive — that will never close, and real sites
  hold them open forever (google's autocomplete XHR does). Requiring *zero*
  in-flight requests made settle unreachable there, silently degrading it into a
  flat `VEIL_QUIESCE_CAP_MS` (12s) timeout **per action**. Late data still lands
  via the mutation-watcher's incremental update, so settling early loses nothing.
  See DECISIONS 2026-07-15.
- `browser/network-capture.ts` — captures XHR/Fetch/Document requests with full
  async initiator stacks (`Debugger.setAsyncCallStackDepth`). Response bodies are
  fetched and **awaited** (`settle()`) before shape inference.
- `browser/mutation-watcher.ts` — debounced DOM-mutation + SPA-nav + poll signals
  that drive incremental graph updates on long-lived sessions.
- `browser/interactions.ts` — dispatches agent actions. Clicks/types scroll the
  target into view first; `clear`/`type` are contenteditable-aware; `type` clears
  before inserting.

### The 5-stage pipeline (`pipeline/`)

Raw CDP signals → Behavior Graph, in five stages. Data flows in `VeilPage.buildGraph()`:

1. **Stage 1 — AXTree skeleton** (`stage-1-axtree.ts`): the accessibility tree →
   `BehaviorNode`s. Keeps interactive roles, semantic containers, table/list body
   roles, and named content landmarks; collapses generic wrapper chains.
   `enrichStructuralEvents` lifts `href`/`action` on server-rendered link/form
   nodes into synthetic click/submit events (skipping in-page `#` anchors and
   `javascript:` links). Supports incremental patching.
2. **Stage 2 — Event binding** (`stage-2-events.ts`): for each interactive node,
   `DOMDebugger.getEventListeners` + a React Fiber walk (React 16 & 17+) to find
   component `onClick`/`onChange` props; each handler categorized (api_call /
   navigation / dom_mutation / form_submit / unknown) from its source. Runs in
   **parallel batches of 20**.
3. **Stage 3 — Network correlation** (`stage-3-network.ts` + `api-endpoints.ts`):
   maps captured requests to the node that triggered them via initiator-stack
   frames (with a col=0-collision-aware ranked match), and extracts parameterized
   `ApiEndpoint`s (numeric/uuid/date/hash/locale segments collapse to `{id}`).
4. **Stage 4 — Component grouping** (`stage-4-components.ts`): React Fiber-tree
   grouping, or vanilla heuristic grouping (containers + shared handlers). Group
   ids are dedup-suffixed and content-derived for stability.
5. **Stage 5 — Semantic inference** (`stage-5-semantics.ts` + `enricher.ts`):
   heuristic rules label the obvious (auth, search, navigation, commerce, …);
   then an **optional pluggable LLM enricher** labels the ambiguous ones (see
   below). Heuristics alone are a complete offline Stage 5.

### The graph model (`graph/`)

- `model.ts` — `BehaviorGraph`, `BehaviorNode`, `EventBinding`, `NetworkEdge`,
  `ApiEndpoint`, `ComponentGroup`, `SemanticLabel`.
- `display-ids.ts` — content-derived **stable** display ids, so the same page
  yields the same ids across sessions (Chrome reassigns internal AX ids each run).
- `serializer.ts` — the compact-text (LLM-facing) and JSON-Graph-Format
  serializers. Names/values are escaped so newlines/quotes/commas can't corrupt
  the format.
- `differ.ts` / `query.ts` — incremental-update diffing and node querying.

### The pluggable enricher (`pipeline/enricher.ts`)

Stage 5's heuristics can't read *intent* from an ambiguous "Apply" / "Continue" /
icon-only button. The `SemanticEnricher` interface takes those low-confidence
nodes and returns labels; results land as `source: 'llm'`.

The default `OpenAICompatEnricher` speaks the OpenAI chat-completions protocol —
**the same socket a local model or Walter's brain exposes**. Enable it with
`VEIL_ENRICH_BASE_URL` (+ `VEIL_ENRICH_MODEL`, `VEIL_ENRICH_API_KEY`), or inject
any implementation via `new Veil({ enricher })`. It is best-effort: any failure
returns `[]` and never blocks a build; it never lowers a more-confident heuristic.

## The MCP server (`@veil/mcp`) — the prime interface

`packages/mcp/src/server.ts` runs an MCP server over stdio. `tools.ts` registers
seven tools on a shared, hardened in-process `SessionStore` (one Chrome, a tab per
session, idle-TTL reaping):

| tool | does |
|---|---|
| `veil_open` | open a URL in a fresh tab → session id + behavior graph |
| `veil_graph` | current graph (compact text or JSON Graph Format) |
| `veil_do` | act on a node (click/type/clear/select/focus/hover) → updated graph |
| `veil_query` | find nodes by role/name/event/semantic |
| `veil_auth` | human-in-the-loop login; carry cookies into the headless session |
| `veil_sessions` / `veil_close` | list / close sessions |

Tool errors are returned as clean MCP error results (an agent reads the text and
recovers), never protocol failures.

See [RUNBOOK.md](./RUNBOOK.md) for setup and commands.

## Testing — two layers (Walter pattern)

- **Layer 1 (hermetic, default `pnpm test`)**: drives an in-process `FakeCDPClient`
  — pure pipeline/model logic, deterministic, no Chrome. Plus the MCP tool surface
  over an in-memory transport with a fake Veil.
- **Layer 2 (`pnpm test:integration`)**: launches **real headless Chrome** against
  locally-served fixtures (server-rendered form, pushState SPA, below-the-fold
  button). Catches wire-level, interaction, and timing regressions the fake can't.
  Auto-skips when Chrome is absent.

Every package has a `tsc --noEmit` typecheck gate wired into turbo.

## Known limitations / scoped future work

- **Cross-origin iframes (OOPIF) are not captured.** Out-of-process frames (ads,
  OAuth popups, embedded checkout) need `Target.setAutoAttach` + per-frame session
  merge + cross-frame id namespacing. Designed, not yet built — see DECISIONS.
- **Anti-bot stealth is shallow** (masks `navigator.webdriver`/plugins only);
  `--headless=new` is fingerprintable. Defeats naive checks, not sophisticated ones.
- **Semantic heuristics are English-only.** The enricher hook is the multilingual
  path.
