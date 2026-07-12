# Veil — Decisions log

> Append-only, dated. Each row: the decision, the why, and where it lives. Newest
> first. This is the project's memory — read it before re-litigating a choice.

| date | decision | why | where |
|---|---|---|---|
| 2026-07-12 | **MCP is the prime interface; CLI demoted (not deleted).** New `@veil/mcp` package: a stdio MCP server exposing `veil_open/graph/do/query/auth/sessions/close` over a hardened in-process `SessionStore`. | The behavior graph's whole point is to be consumed by an LLM agent; MCP is the native way to hand it to one. The CLI shares the daemon infra and stays useful for human debugging, so it's kept as a dev-tool. | `packages/mcp/`, [[ARCHITECTURE]] |
| 2026-07-12 | **Pluggable LLM semantic enricher; revive `source:'llm'`.** `SemanticEnricher` interface + default `OpenAICompatEnricher` (env `VEIL_ENRICH_BASE_URL`). Heuristics stay a complete offline Stage 5; the enricher only labels ambiguous low-confidence nodes and never downgrades a heuristic. | The stripped LLM stage left dead plumbing. Making it pluggable (OpenAI-compatible) means a local model — or Walter's brain — can label perceptions without hardwiring a vendor. Best-effort so it never blocks a build. | `packages/core/src/pipeline/enricher.ts` |
| 2026-07-12 | **Two-layer test discipline (Walter pattern).** Layer 1 hermetic (FakeCDPClient + in-memory MCP transport, default `pnpm test`); Layer 2 real headless Chrome against local fixtures (`pnpm test:integration`, auto-skips without Chrome). | The whole I/O layer was untested (all unit tests used a fake). Real-web tests catch wire/interaction/timing regressions; keeping them separate keeps the unit suite fast and hermetic. | `packages/core/integration/` |
| 2026-07-12 | **`tsc --noEmit` typecheck gate for every package.** Wired into turbo (`pnpm typecheck`, `pnpm check`). | `tsup` strips types without checking; the 968-line CLI had editor-only type safety. The gate immediately caught real type bugs. | `turbo.json`, each `package.json` |
| 2026-07-12 | **Node ≥ 22 required (`engines`).** | The CDP client uses global `WebSocket`, stable only in Node 22+. The README previously claimed Node 20 and would crash at connect. | root + package `package.json` |
| 2026-07-12 | **Each `open()` gets its own tab (`freshTarget`); `page.close()` closes the tab.** | `connectToPage` attached to the first shared page target, so concurrent sessions hijacked each other's page. Fresh targets isolate sessions; closing the tab prevents leaks. | `browser/page.ts`, `index.ts` |
| 2026-07-12 | **Daemon/MCP crash safety + idle TTL.** `uncaughtException`/`unhandledRejection` reap the shared Chrome; sessions build-before-register and reap on idle. | Chrome is a non-detached child — a crash orphaned it forever; dangling half-sessions counted against MAX_SESSIONS. | `daemon-server.ts`, `session-manager.ts`, `mcp/sessions.ts` |
| 2026-07-12 | **Semantic propagation respects roles.** Group labels no longer smear onto self-defining roles (links, inputs); password/identifier inputs get their own labels; `api-trigger` is its own `interactive` category; inherited labels are tagged `source:'inherited'`. | The observed `form:submit (0.56)` flood: a form's group label was stamped onto every descendant (password fields, forgot-password links). | `pipeline/stage-5-semantics.ts` |
| 2026-07-12 | **SPA `pushState` navigation handled explicitly.** `interact()` tracks `navigatedWithinDocument` and rebuilds as a new virtual page instead of waiting for a `loadEventFired` that never fires. | Every SPA route-change click burned the full 10s load-event grace timer. | `index.ts` |
| — (pre-existing, recorded) | **Raw CDP over Playwright/Puppeteer.** | Thousands of AX/event queries per page; a Node relay per call is prohibitive, and CDP's event subscriptions are needed directly. | `browser/cdp-client.ts` |
| — (pre-existing, recorded) | **CLI-only teardown** (commit `05e1c80`): stripped the old MCP/HTTP-WS/SDK server surface to focus the core. | Scope down to a solid pipeline. **Superseded 2026-07-12** by the new, purpose-built `@veil/mcp`. | git history |
| — (pre-existing, recorded) | **Behavior Graph via the Accessibility Tree**, not the DOM; content-derived stable display ids; lossless-ish compression to 50–300 nodes. | Agents waste tokens on visual DOM noise; the AX tree is the semantic skeleton. | `pipeline/`, `graph/` |

## Open / scoped future work

- **OOPIF / cross-origin iframe capture.** Out-of-process frames (ads, OAuth
  popups, embedded checkout) are invisible today. Plan: `Target.setAutoAttach
  {flatten:true}` on the browser target → attach a `PageHandle`-like session per
  child frame → run Stages 1–3 per frame → merge into the parent graph under a
  frame-namespaced id prefix (`frame1:node-…`) so display ids stay unique. Deferred
  as a larger, riskier change; wanted to land the crash/correctness/MCP work first.
- **Stealth hardening** (canvas/WebGL/font spoofing) — only if a real target needs it.
- **Multilingual semantics** — via the enricher, not more regex.
- **Request-shape persistence across incremental updates** — request bodies aren't
  persisted on edges, so `requestShape` can go stale after an incremental rebuild.
- **`networkEdges` cap** on very long-lived analytics-heavy pages (unmatched edges
  aren't pruned).
