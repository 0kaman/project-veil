# Veil — Runbook

> How to build, test, run, and debug Veil. Update when commands change.

## Prerequisites

- **Node.js ≥ 22** (the CDP client uses global `WebSocket`)
- **pnpm ≥ 10**
- **Chrome / Chromium** installed (auto-detected; override with `CHROME_PATH`)

## Build

```bash
pnpm install
pnpm build          # turbo build — all packages
pnpm typecheck      # tsc --noEmit gate across all packages
pnpm check          # typecheck + build + test (what CI should run)
```

## Test

```bash
pnpm test               # Layer 1 — hermetic (FakeCDPClient, in-memory MCP). Fast.
pnpm test:integration   # Layer 2 — REAL headless Chrome vs local fixtures.
                        #            Auto-skips if Chrome is absent.
pnpm test:live          # Live real sites (example/github/MDN); hits the
                        #            internet, gated behind VEIL_LIVE=1.

# direct-API replay vs simulated interaction benchmark:
node packages/core/bench/replay-benchmark.mjs           # instant API
API_DELAY=200 node packages/core/bench/replay-benchmark.mjs  # 200ms API
```

## Run — MCP server (the prime interface)

Build first, then register with an MCP client.

**Claude Code:**
```bash
claude mcp add veil -- node /ABS/PATH/project-veil/packages/mcp/dist/server.js
```

**Claude Desktop / any MCP client** (config JSON):
```json
{
  "mcpServers": {
    "veil": {
      "command": "node",
      "args": ["/ABS/PATH/project-veil/packages/mcp/dist/server.js"],
      "env": { "VEIL_DEBUG": "" }
    }
  }
}
```

Then the agent has `veil_open`, `veil_graph`, `veil_do`, `veil_query`,
`veil_auth`, `veil_sessions`, `veil_close`. Typical flow: `veil_open` a URL →
read the returned graph → `veil_query` to find a node id → `veil_do` to act →
read the updated graph.

### MCP env vars

| var | effect |
|---|---|
| `VEIL_MAX_SESSIONS` | max concurrent sessions (default 10) |
| `VEIL_SESSION_TTL_MS` | idle-session reap time (default 30 min; 0 disables) |
| `CHROME_PATH` | Chrome binary path |
| `VEIL_DEBUG` | set to any value → diagnostic logs on stderr |
| `VEIL_ENRICH_BASE_URL` | OpenAI-compatible endpoint for the LLM enricher (e.g. a local model, or Walter's brain) |
| `VEIL_ENRICH_MODEL` | enricher model id (default `gpt-4o-mini`) |
| `VEIL_ENRICH_API_KEY` | optional bearer token for the enricher |
| `VEIL_NAV_TIMEOUT_MS` | navigation timeout before soft-fail to a partial graph (default 45000) |
| `VEIL_MAX_NODES` | node budget; low-value bulk links pruned above it (default 800, 0=off) |
| `VEIL_QUIET_MS` | event-driven settle: quiet window before an interaction is 'done' (default 40) |
| `VEIL_QUIESCE_CAP_MS` | hard cap for never-idle pages (default 12000) |

## Run — CLI (developer/debug tool)

Session-based; a background daemon holds Chrome alive across invocations.

```bash
SID=$(pnpm veil open https://github.com/login)   # → session id
pnpm veil graph $SID                              # compact text
pnpm veil graph $SID --json                       # JSON Graph Format
pnpm veil do $SID type textbox-username myuser
pnpm veil do $SID click button-sign-in
pnpm veil sessions
pnpm veil close $SID
pnpm veil daemon stop                             # stop the background daemon
```

## Debugging

- **`VEIL_DEBUG=1`** surfaces the intentional degradations (dropped CDP frames,
  React-detection fallbacks, enricher failures) on stderr instead of swallowing
  them silently.
- **Stale/odd behavior from the CLI?** The daemon is a long-lived process — after
  a rebuild, `pnpm veil daemon stop` so the next command relaunches on new code.
- **Graph looks empty / wrong on a real site?** Check for cross-origin iframes
  (not captured — see DECISIONS), a non-standard React root, or a login wall
  (`veil_auth` / `pnpm veil auth`).

## Layout

```
packages/
  core/         @veil/core — engine (browser + pipeline + graph). Zero deps.
    src/browser/    launcher, cdp-client, page, network-capture, interactions, auth
    src/pipeline/   stage-1..5, api-endpoints, enricher
    src/graph/      model, serializer, display-ids, differ, query
    integration/    Layer-2 real-Chrome tests + fixtures
  mcp/          @veil/mcp — MCP server (prime interface)
  cli/          @veil/cli — daemon + client (dev tool)
docs/           ARCHITECTURE.md · DECISIONS.md · RUNBOOK.md (+ marketing site)
```
