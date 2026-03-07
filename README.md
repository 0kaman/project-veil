# Project Veil

An AI-first browser that decomposes webpages into **Behavior Graphs** — structured representations of what a page *does*, not what it *looks like*.

Instead of rendering pixels, Veil exposes interactive components, their event handlers, the API calls they trigger, and the semantic purpose of each element. An AI agent consuming a Veil behavior graph sees this:

```
PAGE github.com/login "Sign in to GitHub"
STATE route:/login

NODES
  textbox-username [textbox] "Username or email address"
    on:input → api_call (GET /u2f/login_fragment)
    semantic: form:api-trigger (0.50, heuristic)
  textbox-password [textbox] "Password"
  button-sign-in [button] "Sign in"
    semantic: form:submit (0.75, heuristic)

NETWORK
  textbox-username on:input → GET /u2f/login_fragment → 200 (html)

APIS
  GET /u2f/login_fragment → 200 html

COMPONENTS
  cg-vanilla-shared-1 [vanilla] "shared-handler-1"
    members: button-sign-in-with-a-passkey, button-manage-cookies
```

Instead of thousands of DOM nodes, CSS rules, and visual layout data.

## Why Veil?

Traditional web automation tools (Playwright, Puppeteer, Selenium) give AI agents raw DOM trees with thousands of nodes, most of which are visual noise. Agents waste tokens parsing irrelevant markup and struggle to understand *what things do*.

Veil solves this by:
- **Compressing** 3,000-10,000 DOM nodes into 50-300 behavior nodes using the Accessibility Tree
- **Revealing behavior** — every button, input, and link comes with its event handlers and what they do (API calls, navigation, DOM mutations)
- **Correlating network** — mapping which UI interaction triggers which API endpoint
- **Grouping components** — React component boundaries and vanilla container grouping
- **Labeling semantics** — `auth:login`, `search:input`, `navigation:primary`, `commerce:add-to-cart`
- **Outputting token-efficient text** — compact format designed for LLM context windows

## Quick Start

### Prerequisites

- Node.js 20+
- pnpm 10+
- Chromium/Chrome installed

### Install & Build

```bash
git clone git@github.com:0kaman/project-veil.git
cd project-veil
pnpm install
pnpm build
```

### CLI Usage — Session-Based (for LLM agents)

Sessions persist across CLI invocations. A background daemon holds Chromium alive.

```bash
# Open a page — returns a session UUID
SID=$(pnpm veil open https://github.com/login)

# View the behavior graph
pnpm veil graph $SID              # compact text (LLM-friendly)
pnpm veil graph $SID --json       # JSON Graph Format

# Interact with nodes — session state survives each call
pnpm veil do $SID type textbox-username myuser
pnpm veil do $SID type textbox-password mypass
pnpm veil do $SID click button-sign-in
# → Now logged in! Cookies, localStorage, DOM all persisted.

# Navigate within the same session
pnpm veil navigate $SID https://github.com/settings

# Search for nodes
pnpm veil find $SID button        # by role
pnpm veil find $SID submit        # by name or event

# Inspect a single node in detail
pnpm veil inspect $SID button-sign-in

# List / close sessions
pnpm veil sessions
pnpm veil close $SID
pnpm veil close --all

# Daemon management
pnpm veil daemon start|stop|status|restart

# Short session IDs work (prefix match)
pnpm veil graph 8d06              # matches 8d060512-c7e1-...
```

### CLI Usage — Legacy One-Shot (for humans)

```bash
# Decompose a webpage (no session persistence)
pnpm veil decompose https://github.com/login
pnpm veil decompose https://news.ycombinator.com --json
ANTHROPIC_API_KEY=sk-... pnpm veil decompose https://amazon.com --llm

# One-shot interact
pnpm veil interact https://github.com/login textbox-username type "myuser"

# Interactive REPL
pnpm veil shell https://github.com/login
```

### MCP Server (for AI agents)

Any MCP-compatible AI host (Claude Desktop, Cursor, Windsurf, etc.) can use Veil as a native tool.

#### Claude Desktop Config

Add to `~/Library/Application Support/Claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "veil": {
      "command": "node",
      "args": ["/path/to/project-veil/packages/mcp/dist/index.js"],
      "env": {
        "ANTHROPIC_API_KEY": "sk-..."
      }
    }
  }
}
```

#### Available Tools

| Tool | Description |
|------|-------------|
| `veil_open` | Open a URL in a new browser session |
| `veil_graph` | Get the behavior graph (compact text or JSON) |
| `veil_interact` | Click, type, select, etc. on page elements |
| `veil_navigate` | Navigate to a new URL within a session |
| `veil_find` | Search for nodes by role, name, or event |
| `veil_inspect` | Get detailed info about a specific node |
| `veil_sessions` | List active browser sessions |
| `veil_close` | Close a session or all sessions |
| `veil_screenshot` | Take a screenshot of the current page |

### SDK Usage (TypeScript)

```typescript
import { Veil } from "@veil/sdk";

const veil = new Veil();
const page = await veil.open("https://github.com/login");

// Get the behavior graph
const graph = await page.getGraph();

// Query nodes by role, semantic label, or component
const buttons = await page.query({ role: "button" });
const loginFields = await page.query({ semanticCategory: "auth" });

// Get LLM-friendly representations
const compact = await page.toCompactText();   // Token-efficient text
const json = await page.toJSON();             // Full JSON Graph Format

// Interact through the graph
await page.interact("textbox-username", { action: "type", text: "user@example.com" });
await page.interact("button-sign-in", { action: "click" });

// Graph updates automatically after interaction
const updatedGraph = await page.getGraph();

await veil.close();
```

### HTTP/WebSocket API

Start the server:

```bash
node packages/server/dist/index.js
# Veil server listening on http://127.0.0.1:3100
```

Use the REST API:

```bash
# Create a session
curl -X POST http://127.0.0.1:3100/api/sessions \
  -H 'Content-Type: application/json' \
  -d '{"url":"https://github.com/login"}'

# Get compact text graph
curl http://127.0.0.1:3100/api/sessions/<id>/graph/compact

# Get JSON graph
curl http://127.0.0.1:3100/api/sessions/<id>/graph

# Query nodes
curl "http://127.0.0.1:3100/api/sessions/<id>/graph/nodes?role=button"

# Interact with a node
curl -X POST http://127.0.0.1:3100/api/sessions/<id>/interact \
  -H 'Content-Type: application/json' \
  -d '{"nodeId":"button-sign-in","action":{"action":"click"}}'

# Navigate to a new URL
curl -X POST http://127.0.0.1:3100/api/sessions/<id>/navigate \
  -H 'Content-Type: application/json' \
  -d '{"url":"https://example.com"}'
```

WebSocket for real-time graph updates:

```
ws://127.0.0.1:3100/ws/sessions/<id>/graph
```

## Architecture

### Session Persistence

The CLI is a thin HTTP client. A background daemon (the existing `@veil/server`) holds Chromium sessions alive across CLI invocations:

```
LLM tool calls: veil open → veil do → veil graph → veil do → ...
        │
        ▼
   CLI process (thin HTTP client)
        │  ensureDaemon() → auto-starts if not running
        │  fetch(localhost:3100/api/...)
        ▼
   Daemon (@veil/server, background process, PID file at ~/.veil/)
        │  SessionManager: Map<uuid, { VeilPage, browser }>
        │  Sessions survive across all CLI calls
        ▼
   Chromium (headless, CDP)
        │  Cookies, localStorage, DOM state — all persisted
```

### Decomposition Pipeline

Veil uses a **5-stage decomposition pipeline** that runs on raw Chrome DevTools Protocol, not Playwright or Puppeteer:

```
┌─────────┐    ┌──────────┐    ┌───────────┐    ┌──────────┐    ┌──────────┐
│ Stage 1  │───>│ Stage 2  │───>│ Stage 3   │───>│ Stage 4  │───>│ Stage 5  │
│ AXTree   │    │ Event    │    │ Network   │    │Component │    │ Semantic │
│ Skeleton │    │ Binding  │    │ Correlation│   │ Grouping │    │ Inference│
└─────────┘    └──────────┘    └───────────┘    └──────────┘    └──────────┘
```

| Stage | What it does |
|-------|-------------|
| **1. AXTree Skeleton** | Extracts the Accessibility Tree, filters to interactive/meaningful nodes, builds initial graph (3K-10K DOM nodes → 50-300 behavior nodes) |
| **2. Event Binding** | Enumerates event listeners on each node via CDP + React Fiber traversal, categorizes handlers (API call, navigation, DOM mutation, form submit) |
| **3. Network Correlation** | Matches network requests to triggering UI nodes via initiator stack traces, builds API endpoint catalog with URL patterns and response shapes |
| **4. Component Grouping** | Groups nodes by React component boundaries (Fiber tree) and vanilla heuristics (container roles, shared handler sources) |
| **5. Semantic Inference** | Labels nodes with semantic purposes (auth:login, search:input, etc.) via 8 heuristic rules + optional LLM enrichment via Anthropic API |

### Why Raw CDP?

Playwright's Node.js relay adds a network hop on every CDP call — prohibitive when making thousands of calls for event listeners, accessibility tree queries, and network monitoring. CDP exposes event-driven subscriptions that Playwright's request-response model obscures. We need simultaneous fine-grained control over Debugger, DOMDebugger, Accessibility, and Network domains.

### Incremental Updates

The graph is maintained in real-time. DOM mutations are debounced (150ms window) and trigger incremental pipeline re-runs — only affected nodes are re-processed through stages 1-5. Full rebuilds happen only on page navigation.

## Project Structure

```
project-veil/
├── packages/
│   ├── core/               # Browser runtime, instrumentation, pipeline, graph store
│   │   └── src/
│   │       ├── browser/    # Chrome launcher, CDP client, page abstraction, interactions
│   │       ├── pipeline/   # Stages 1-5 decomposition pipeline
│   │       └── graph/      # Model, serializer, query, display IDs, differ
│   ├── sdk/                # TypeScript SDK — re-exports core for agent consumption
│   ├── server/             # HTTP/WebSocket API server (Hono), session manager
│   ├── mcp/                # MCP server — native tool access for AI agents (Claude Desktop, Cursor, etc.)
│   └── cli/                # CLI tool
│       └── src/
│           ├── index.ts    # Command router (session + legacy commands)
│           ├── daemon.ts   # Daemon lifecycle (auto-start, PID file, health check)
│           └── client.ts   # HTTP client wrapping server REST API
├── docs/
│   └── product-overview.html  # Interactive visual product dashboard
├── scripts/
│   └── evolve.sh           # Continuous development loop (build → test → analyze)
├── ARCHITECTURE.md         # Detailed system architecture document
├── turbo.json
└── pnpm-workspace.yaml
```

## Output Formats

### Compact Text (for LLM context windows)

Designed for minimal token usage. ~70% fewer tokens than equivalent JSON:

```
PAGE example.com "Example"
STATE route:/

NODES
  textbox-search [textbox] "Search"
    on:keyup → api_call (GET /api/search)
    semantic: search:input (0.95, heuristic)
  button-search [button] "Search"
    on:click → form_submit
    semantic: form:submit (0.80, heuristic)

NETWORK
  textbox-search on:keyup → GET /api/search → 200 (json)

APIS
  GET /api/search → 200 json { results: "array", total: "number" }

COMPONENTS
  cg-vanilla-search [vanilla] "search" semantic:search:input
    members: textbox-search, button-search
```

### JSON Graph Format (for programmatic use)

Full structured data with node metadata, edges, component groups, semantic labels, and API endpoints.

## Test Coverage

260 tests across 14 files in 4 packages, all passing:

| Package | Tests | Files |
|---------|-------|-------|
| `@veil/core` | 180 | 9 (pipeline stages, serializer, query, display IDs, differ, API endpoints) |
| `@veil/server` | 38 | 2 (REST API routes, error handling) |
| `@veil/mcp` | 22 | 1 (MCP tool handlers, session resolution) |
| `@veil/cli` | 20 | 2 (HTTP client, daemon lifecycle) |

```bash
pnpm test          # Run all tests
pnpm test:watch    # Watch mode
```

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Browser engine | Chromium (headless) via raw CDP |
| Core runtime | TypeScript, Node.js |
| Build | tsup + esbuild, turborepo |
| Monorepo | pnpm workspaces |
| HTTP API | Hono |
| WebSocket | @hono/node-ws |

## Configuration

### VeilConfig

```typescript
const veil = new Veil({
  llm: {
    enabled: true,
    apiKey: "sk-...",           // Anthropic API key
    model: "claude-sonnet-4-20250514",  // default
    confidenceThreshold: 0.5,   // LLM consulted for labels below this
  },
});
```

### Semantic Labels

Nodes are labeled with a category + action pair at a confidence level:

| Category | Actions | Example Match |
|----------|---------|--------------|
| `auth` | `login`, `signup` | Form with password field |
| `search` | `input` | Searchbox role or textbox with "search" in name |
| `navigation` | `primary`, `secondary` | Navigation landmark |
| `form` | `submit`, `api-trigger` | Submit button, node triggering network requests |
| `content` | `list` | List with 3+ link/item children |
| `commerce` | `add-to-cart`, `checkout` | Button with cart/buy/checkout in name |
| `dynamic` | `live-region` | aria-live, alert/status/log roles |

## License

MIT
