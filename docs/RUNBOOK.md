# Veil — Runbook

Operational reference: every environment variable, what it's for, and its default as
read from the code. Defaults are the ones in source, not aspirations — if you change a
default, change it here too. Drift between doc and code is a bug.

## Secrets

Put these in a **gitignored `.env`** at the repo root (see `.env.example`). Never in
source, never pasted into a transcript — a key that appears in one should be treated as
compromised and rotated.

| var | used by | notes |
|---|---|---|
| `BRAVE_API_KEY` | `@veil/search` | Free tier: **1 query/sec, 2,000/month**. Searches cannot be parallelised. |
| `MISTRAL_API_KEY` | `@veil/playground` | Playground only — Veil itself never calls an LLM. An exhausted key returns **401**, not 429, so "Unauthorized" may mean "out of quota". |
| `MISTRAL_MODEL` | `@veil/playground` | Default `mistral-medium-latest`. |

## Debugging

| var | default | what it does |
|---|---|---|
| `VEIL_DEBUG` | unset | Surfaces intentionally-swallowed failures on stderr — dropped CDP frames, React-detection fallbacks, re-resolve attempts. **Set this first** when behaviour is inexplicable; the codebase degrades silently by design. |
| `CHROME_PATH` | auto-detected | Override the Chrome/Chromium binary. |

## Read tier (`@veil/read`)

| var | default | what it does |
|---|---|---|
| `VEIL_READ_BUDGET_WORDS` | `4000` | Words returned before truncating and issuing a handle. Chosen so typical pages arrive whole and only long-form is cut. |
| `VEIL_READ_CLEAN_WORDS` | `250` | Below this the extraction is "thin" and the fallback extractor is considered. |
| `VEIL_READ_OK_FLOOR` | `60` | Below this a fetched page is classified `js-shell` / `empty` rather than `ok`. |
| `VEIL_READ_FALLBACK_RAW` | `600` | Raw stripped words needed before trying the denser extractor — the guard against declaring failure on content that *is* present. |
| `VEIL_READ_TIMEOUT_MS` | `10000` | Per-fetch timeout. |
| `VEIL_READ_UA` | Chrome UA | Request user-agent. |

A **session** read (`veil_read` with a session id) deliberately ignores the `js-shell`
classification and the `fallbackRaw` gate: that tier has no rung above it, so there is
nothing to escalate to and a thin page keeps its text.

## Search tier (`@veil/search`)

| var | default | what it does |
|---|---|---|
| `VEIL_SEARCH_COUNT` | `10` | Results requested. |
| `VEIL_SEARCH_INTERVAL_MS` | `1100` | Min gap between calls — the free tier is 1/sec and will 429. |
| `VEIL_SEARCH_TTL_MS` | `3600000` | Cache TTL. The same query is stable for hours; cache aggressively. |

## Engine — sessions (`@veil/core`)

| var | default | what it does |
|---|---|---|
| `VEIL_MEMORY_BUDGET_MB` | `3000` | Evict sessions when the browser **process tree** exceeds this. A judgement about the host, not a measurement — override per deployment. Eviction is LRU and never silent: the receipt names what went. |
| `VEIL_MAX_SESSIONS` | `24` | Hard ceiling on concurrent sessions. |
| `VEIL_SESSION_IDLE_MS` | `1800000` (30 min) | Reap sessions idle longer than this. |

## Engine — settle

Settled ⟺ **young-network-idle AND actionable-surface stable**.

| var | default | what it does |
|---|---|---|
| `VEIL_QUIET_MS` | `200` | Quiet window that counts as settled. |
| `VEIL_SETTLE_CAP_MS` | `8000` | Hard cap; past this, settle returns and says it capped. |
| `VEIL_SETTLE_POLL_MS` | `100` | Fingerprint sampling interval. Must stay well under the cost of a fingerprint, or the poll cannot detect its own quiet window. |
| `VEIL_LONGPOLL_MS` | `2000` | A request older than this is "long-lived" (SSE, websocket, poll) and no longer blocks idle. |

## Engine — render (read's escalation)

| var | default | what it does |
|---|---|---|
| `VEIL_RENDER_NAV_MS` | `20000` | Navigation timeout for a render. |
| `VEIL_RENDER_CAP_MS` | `8000` | Settle cap for a render. |

## Replay — the security gate

Replay fires a captured request directly, authenticated, in ~1–6ms. That speed is also a
blast-radius multiplier, and Veil feeds untrusted page text to an LLM holding live
cookies — a textbook confused-deputy chain. **The gate is a security boundary, not a
feature flag**, and it is deliberately not agent-controllable.

| var | default | what it does |
|---|---|---|
| `VEIL_REPLAY` | `safe` | `off` — not even registered as a tool. `safe` — idempotent methods only (GET/HEAD/OPTIONS). `all` — mutations permitted; opt in deliberately. |
| `VEIL_REPLAY_DOMAINS` | empty | Comma-separated allowlist. When set, replay is confined to these hosts and their subdomains (a lookalike host does **not** pass). |

Defaults are asymmetric because the failure modes are: replaying a GET wastes a request;
replaying a POST can charge a card.

## Playground

| flag | default | what it does |
|---|---|---|
| `--auto` | off | Skip the permission gate. Forced on when stdin is not a TTY. |
| `--max-steps N` | `20` | Tool-call budget for a turn. Real tasks need 45–60. |
| `--prompt-file PATH` | — | Read the turn from a file. **Use this for anything long** — resolves against cwd and the repo root. |
| `--model NAME` | `mistral-medium-latest` | Override the model. |

Slash commands in the REPL: `/help`, `/clear`, `/auto`, `/trace`, `/quit`; `esc`
interrupts.

Traces land in `traces/<ts>.trace.jsonl` (every hop, including the user turn verbatim)
and are distilled to `traces/episodes.jsonl` for `pnpm play:analyse`.

## Common situations

**A run ends immediately with `Mistral 401 Unauthorized`.** Usually an exhausted quota,
not a bad key — Mistral returns 401 for both. Verify with a one-token call before
re-running anything expensive.

**Chrome is left running after a crash.** The launcher reaps its own tree on
`uncaughtException`, but a hard kill can orphan it. Sessions hold a real browser; check
for stray `chrome` processes if memory looks wrong.

**A graph looks empty or wrong on a real site.** Most often cross-origin iframes (OOPIF),
which are not captured at all. Second most often a modal: the page is `inert` behind a
dialog and the graph correctly shows only what's reachable — the receipt says
`DIALOG OPEN` when it detects one.

**The playground spawns `dist/`.** After any source change, `pnpm build` before running
it, or you are testing stale code.
