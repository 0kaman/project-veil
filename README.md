# Project Veil

An **AI-first browser** that decomposes webpages into **Behavior Graphs** —
structured representations of what a page *does*, not what it *looks like*.

Instead of handing an AI agent thousands of DOM nodes, CSS rules, and layout
data, Veil exposes the interactive elements, their event handlers, the API calls
those trigger, and the semantic purpose of each — the ~50–300 things that
actually matter:

```
PAGE https://github.com/login "Sign in to GitHub"
STATE route:/login

NODES
  form-5 [form]
    on:submit → form_submit (POST /session)
    semantic: auth:login (0.85, heuristic)
    textbox-username [textbox] "Username or email address"
      semantic: auth:identifier-input (0.70, heuristic)
    textbox-password [textbox] "Password"
      semantic: auth:password-input (0.90, heuristic)
    button-sign-in [button] "Sign in"
      semantic: form:submit (0.75, heuristic)
  link-forgot-password [link] "Forgot password?"
    on:click → navigation (GET /password_reset)
```

## Why

Traditional automation tools (Playwright, Puppeteer, Selenium) give agents raw
DOM trees — thousands of nodes of mostly-visual noise. Agents burn tokens parsing
markup and still struggle to understand *what things do*. Veil instead:

- **Compresses** 3,000–10,000 DOM nodes into 50–300 behavior nodes (via the
  Accessibility Tree).
- **Reveals behavior** — every button/input/link carries its event handlers and
  their effects (API call, navigation, DOM mutation).
- **Correlates network** — which UI interaction triggers which API endpoint.
- **Groups components** and **labels semantics** (`auth:login`, `search:input`,
  `commerce:add-to-cart`, …).
- **Outputs a token-efficient format** built for LLM context windows.

## Install & build

Requires **Node ≥ 22**, **pnpm ≥ 10**, and **Chrome/Chromium**.

```bash
git clone git@github.com:0kaman/project-veil.git
cd project-veil
pnpm install
pnpm build
```

## Use it — as an MCP server (recommended)

Veil's primary interface is a **Model Context Protocol server**, so any MCP host
(Claude Code, Claude Desktop, agent runtimes) can use it as a native tool.

```bash
# Claude Code
claude mcp add veil -- node /ABS/PATH/project-veil/packages/mcp/dist/server.js
```

Tools: `veil_open`, `veil_graph`, `veil_do`, `veil_query`, `veil_auth`,
`veil_sessions`, `veil_close`. See [docs/RUNBOOK.md](docs/RUNBOOK.md) for config
JSON and env vars.

## Use it — from the CLI (developer tool)

Sessions persist across invocations via a background daemon.

```bash
SID=$(pnpm veil open https://github.com/login)
pnpm veil graph $SID            # compact text (LLM-friendly)
pnpm veil graph $SID --json     # JSON Graph Format
pnpm veil do $SID type textbox-username myuser
pnpm veil do $SID click button-sign-in
pnpm veil close $SID
```

## Use it — programmatically (`@veil/core`)

```ts
import { Veil } from "@veil/core";

const veil = new Veil();
const page = await veil.open("https://github.com/login");
console.log(await page.toCompactText());
await page.interact("textbox-username", { action: "type", text: "me" });
await veil.close();
```

Optional LLM semantic enrichment for ambiguous elements (any OpenAI-compatible
endpoint — a local model or your own brain socket):

```ts
const veil = new Veil({ enricher: myEnricher });
// …or set VEIL_ENRICH_BASE_URL and it's picked up automatically.
```

## Testing

```bash
pnpm test              # Layer 1 — hermetic (no Chrome)
pnpm test:integration  # Layer 2 — real headless Chrome vs local fixtures
```

## Docs

- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) — as-built design
- [docs/DECISIONS.md](docs/DECISIONS.md) — dated decision log
- [docs/RUNBOOK.md](docs/RUNBOOK.md) — build/test/run/debug

## Status

Solid alpha. The core decomposition pipeline, the MCP server, the CLI, and the
programmatic API all work end-to-end against real sites. Known limitations
(cross-origin iframes, shallow anti-bot stealth, English-only heuristics) are
tracked in [docs/DECISIONS.md](docs/DECISIONS.md).

## License

MIT
