# Project Veil — System Architecture

## Vision

Project Veil is an AI-first browser that decomposes any webpage into a **Behavior Graph** — a structured representation of what a page *does*, not what it *looks like*. Instead of rendering pixels, Veil exposes interactive components, their event handlers, the API calls they make, and their semantic purpose.

An AI agent consuming a Veil behavior graph sees something like:

```
PAGE https://github.com/login "Sign in to GitHub"
STATE route:/login

NODES
  textbox-username [textbox] "Username or email address"
    on:input → dom_mutation
  textbox-password [textbox] "Password"
    on:input → dom_mutation
  button-sign-in [button] "Sign in"
    on:click → form_submit (POST /session)
    semantic: auth:login (0.95, heuristic)
  link-forgot-password [link] "Forgot password?"
    on:click → navigation

NETWORK
  button-sign-in on:click → POST /session → 302 (html)

APIS
  POST /session → 302 html
```

Instead of 50,000+ lines of HTML/CSS/JS.

---

## High-Level Architecture

```
┌──────────────────────────────────────────────────────────────────────┐
│                          PROJECT VEIL                                │
│                                                                     │
│  ┌──────────────┐    ┌───────────────┐    ┌──────────────────────┐  │
│  │  Browser      │    │ 5-Stage       │    │  Behavior Graph      │  │
│  │  Runtime      │───▶│ Pipeline      │───▶│  (In-Memory)         │  │
│  │  (Chromium)   │    │               │    │                      │  │
│  └──────────────┘    └───────────────┘    └──────────┬───────────┘  │
│        ▲                                             │              │
│        │ CDP                                         ▼              │
│  ┌──────────────┐                         ┌──────────────────────┐  │
│  │ Instrumentation│                        │  Consumer APIs       │  │
│  │ Layer         │                         │  ┌────────────────┐ │  │
│  │               │                         │  │ MCP Server     │ │  │
│  │ • AXTree      │                         │  │ HTTP/WS API    │ │  │
│  │ • Events      │                         │  │ TypeScript SDK │ │  │
│  │ • Network     │                         │  │ CLI            │ │  │
│  │ • Mutations   │                         │  └────────────────┘ │  │
│  └──────────────┘                         └──────────────────────┘  │
└──────────────────────────────────────────────────────────────────────┘
```

### Core Modules

| Module | Responsibility | Key Technology |
|--------|---------------|----------------|
| **Browser Runtime** | Chrome launch, CDP connection, page lifecycle | Chromium (headless) via raw CDP WebSocket |
| **Instrumentation** | Event listeners, network capture, DOM mutations | CDP domains + injected JS |
| **5-Stage Pipeline** | Transform raw signals → behavior graph | TypeScript pipeline stages |
| **Behavior Graph** | In-memory graph with serialization + querying | Custom graph model, display IDs |
| **Consumer APIs** | MCP, HTTP/WS, SDK, CLI access to graphs | MCP SDK, Hono, TypeScript |

---

## Module 1: Browser Runtime

### Design Decision: Raw CDP over Playwright/Puppeteer

We use **raw Chrome DevTools Protocol** directly via WebSocket.

**Rationale:**
- Playwright's Node.js relay adds a network hop on every CDP call — prohibitive for thousands of accessibility tree queries and event listener lookups
- CDP exposes event-driven subscriptions (real-time mutations, network events) that Playwright's request-response model obscures
- We need simultaneous control over Debugger, DOMDebugger, Accessibility, and Network domains
- No abstraction overhead — direct WebSocket to Chrome

### Launch Configuration

```typescript
// Actual flags from packages/core/src/browser/launcher.ts
const args = [
  "--headless=new",
  "--disable-gpu",
  "--no-first-run",
  "--no-default-browser-check",
  "--disable-extensions",
  "--disable-component-extensions-with-background-pages",
  "--disable-background-networking",
  "--disable-default-apps",
  "--disable-sync",
  "--metrics-recording-only",
  "--disable-blink-features=AutomationControlled",  // Stealth
  "--window-size=1920,1080",
  "--user-agent=Mozilla/5.0 ...",                    // Realistic UA
  "--remote-debugging-port=0",                       // Random port
];
```

Each browser gets a unique temp `--user-data-dir` for session isolation. Chrome binary is auto-detected (`CHROME_PATH` env, macOS default path, or `google-chrome` on Linux).

### CDP Client

`packages/core/src/browser/cdp-client.ts` — Lightweight WebSocket client wrapping CDP JSON-RPC. Provides:
- `send(method, params)` — typed CDP commands
- `on(event, handler)` / `off(event, handler)` — CDP event subscriptions
- Connection lifecycle management

### Page Handle

`packages/core/src/browser/page.ts` — Per-tab CDP session providing:
- AXTree fetching (`Accessibility.getFullAXTree`)
- Navigation (`Page.navigate`)
- Network capture start/stop/drain
- Title and URL queries
- `DOM.getDocument` for node resolution

### CDP Domains Enabled

| Domain | Purpose | Events Subscribed |
|--------|---------|-------------------|
| `Page` | Navigation, lifecycle | `loadEventFired`, `frameNavigated` |
| `DOM` | DOM structure, mutations | `childNodeInserted`, `childNodeRemoved`, `attributeModified`, `documentUpdated` |
| `DOMDebugger` | Event listener enumeration | (on-demand per node) |
| `Network` | Request/response capture | `requestWillBeSent`, `responseReceived`, `loadingFinished` |
| `Debugger` | Stack traces for network attribution | (async call stack depth) |
| `Accessibility` | Semantic tree | (on-demand via `getFullAXTree`) |
| `Runtime` | JS evaluation, node resolution | (on-demand) |

---

## Module 2: Instrumentation Layer

The instrumentation layer reads the page's wiring and observes consequences of agent actions.

### Network Capture (`packages/core/src/browser/network-capture.ts`)

Captures all network activity with full initiator stack traces:

```
Network.requestWillBeSent → {url, method, initiator.stack}
Network.responseReceived  → {status, contentType}
```

Requires `Debugger.enable` + `Debugger.setAsyncCallStackDepth({maxDepth: 32})` for full async chain attribution. This lets Stage 3 trace which UI node triggered each API call.

### Event Listener Enumeration (`packages/core/src/pipeline/stage-2-events.ts`)

For each interactive node:
1. Resolve `backendDOMNodeId` → `Runtime.RemoteObject` via `DOM.resolveNode`
2. Call `DOMDebugger.getEventListeners(objectId)` to get registered listeners
3. Categorize handler behavior via source analysis and injected instrumentation
4. For React apps: traverse `__reactFiber$` property on DOM elements to find component event props

### Mutation Watcher (`packages/core/src/browser/mutation-watcher.ts`)

Watches for DOM changes in real-time with three signal sources:

- **DOM mutations**: `childNodeInserted`, `childNodeRemoved`, `attributeModified` — debounced with 150ms window
- **Navigation**: `Page.navigatedWithinDocument` for SPA route changes — triggers full graph rebuild
- **Polling**: Periodic AXTree consistency check (5s default) — catches mutations missed by DOM events

Supports suppression during `interact()` calls to avoid conflicting updates.

### Interaction Dispatcher (`packages/core/src/browser/interactions.ts`)

Dispatches agent actions to DOM nodes via CDP:
- `click` → `DOM.getBoxModel` + `Input.dispatchMouseEvent`
- `type` → `DOM.focus` + `Input.dispatchKeyEvent` per character
- `clear` → select all + delete
- `select` → evaluate JS to set `<select>` value
- `focus` → `DOM.focus`
- `hover` → `Input.dispatchMouseEvent` (mouseover)

---

## Module 3: 5-Stage Decomposition Pipeline

```
┌─────────┐    ┌──────────┐    ┌───────────┐    ┌──────────┐    ┌──────────┐
│ Stage 1  │───▶│ Stage 2  │───▶│ Stage 3   │───▶│ Stage 4  │───▶│ Stage 5  │
│ AXTree   │    │ Event    │    │ Network   │    │Component │    │ Semantic │
│ Skeleton │    │ Binding  │    │ Correlation│   │ Grouping │    │ Inference│
└─────────┘    └──────────┘    └───────────┘    └──────────┘    └──────────┘
```

### Stage 1: AXTree Skeleton (`stage-1-axtree.ts`)

**Input:** `Accessibility.getFullAXTree()` response
**Output:** `BehaviorGraph` with initial `BehaviorNode` entries

**Filtering rules:**
- Include: interactive roles (button, link, textbox, checkbox, combobox, slider, switch, tab, menuitem, etc.)
- Include: semantic containers (form, navigation, main, dialog, toolbar, list, region)
- Include: nodes with non-empty accessible names that are content landmarks
- Exclude: ignored nodes, decorative nodes, generic containers with no semantic role
- Collapse: chains of single-child generic containers

Also supports incremental patching via `patchGraphFromDiff()` for efficient updates.

**Expected compression:** 3,000-10,000 DOM nodes → 50-300 behavior nodes.

### Stage 2: Event Binding (`stage-2-events.ts`)

For each interactive node, enumerate its event handlers.

**Process:**
1. Resolve `backendDOMNodeId` → `Runtime.RemoteObject`
2. Call `DOMDebugger.getEventListeners(objectId)`
3. Categorize each handler:
   - **api_call**: handler triggers fetch/XHR
   - **navigation**: handler triggers URL change
   - **dom_mutation**: handler modifies DOM/state
   - **form_submit**: handler submits a form
   - **unknown**: opaque/minified handler
4. Extract `estimatedEffect` where possible (e.g., "POST /api/login")

**React handling:** React uses event delegation (single root listener). We traverse `__reactFiber$` on elements to find component-level `onClick`, `onChange` props.

Supports selective enrichment via `enrichSpecificNodesWithEvents()` for incremental updates.

### Stage 3: Network Correlation (`stage-3-network.ts`)

Map captured network requests to the graph nodes that triggered them.

**Process:**
1. From `Network.requestWillBeSent`, extract `initiator.stack` (full async chain)
2. Parse stack frames, resolve against graph nodes via `backendDOMNodeId`
3. Create `NetworkEdge` linking trigger node → request → response

Also runs **API endpoint extraction** (`api-endpoints.ts`):
- Groups requests by URL pattern (parameterized: `/api/users/123` → `/api/users/{id}`)
- Aggregates response shapes, status codes, content types
- Produces `ApiEndpoint[]` for the graph

### Stage 4: Component Grouping (`stage-4-components.ts`)

Groups related behavior nodes into logical components.

**Process:**
1. Detect framework (React via `__reactFiber$`, or vanilla fallback)
2. React: walk Fiber tree to find component boundaries, map behavior nodes to components
3. Vanilla: heuristic grouping via DOM proximity + shared containers + ARIA relationships
4. Assign `componentId` to each behavior node in a group

Supports incremental regrouping via `regroupComponents()`.

### Stage 5: Semantic Inference (`stage-5-semantics.ts`)

Add high-level semantic labels using heuristics + optional LLM enrichment.

**Heuristic rules:**
- Password field in form → `auth:login` or `auth:signup`
- `type=search` or `role=searchbox` → `search:input`
- Navigation landmark → `navigation:primary`
- Submit button near form → `form:submit`
- Cart/checkout patterns → `commerce:*`

**LLM enrichment** (optional, via `VeilConfig.llm`):
- Only consulted for nodes below `confidenceThreshold` (default 0.5)
- Uses Anthropic API (Claude) to label ambiguous nodes
- Labels include `source: 'llm'` for traceability
- Can be disabled for latency-sensitive use cases

---

## Module 4: Behavior Graph

### Data Model (`packages/core/src/graph/model.ts`)

```typescript
interface BehaviorGraph {
  metadata: {
    url: string;
    title: string;
    timestamp: number;
    route: string;
  };
  version: number;
  nodes: Map<string, BehaviorNode>;
  roots: string[];
  networkEdges: NetworkEdge[];
  apiEndpoints: ApiEndpoint[];
  componentGroups: ComponentGroup[];
}

interface BehaviorNode {
  id: string;                              // Internal AX node ID
  role: string;                            // ARIA role: 'button', 'textbox', 'link'
  name: string;                            // Accessible name: "Sign in", "Username"
  description: string;                     // Accessible description
  state: Record<string, string | boolean>; // { disabled: false, checked: true }
  value: string;                           // Current value for inputs
  backendDOMNodeId: number;                // Link to DOM for CDP operations
  children: string[];                      // Child node IDs (containment)
  events: EventBinding[];                  // What happens on interaction
  componentId?: string;                    // Which ComponentGroup this belongs to
  semanticLabel?: SemanticLabel;           // High-level purpose label
}

interface EventBinding {
  eventType: string;        // 'click', 'submit', 'input', 'change'
  category: "api_call" | "navigation" | "dom_mutation" | "form_submit" | "unknown";
  source?: {                // Handler source location
    scriptUrl: string;
    lineNumber: number;
    columnNumber: number;
    functionName: string;
  };
  estimatedEffect?: string; // 'POST /api/login', 'navigate:/dashboard'
}

interface NetworkEdge {
  triggerNodeId: string;          // "" if unmatched
  triggerEvent: string;           // 'click', 'submit', 'script'
  request: { method: string; url: string };
  response?: {
    status: number;
    contentType: string;
    bodyShape?: Record<string, string>;
  };
  urlPattern?: string;            // /api/users/{id}
}

interface ApiEndpoint {
  pattern: string;                          // /api/users/{id}
  method: string;                           // GET, POST, etc.
  responseShape?: Record<string, string>;   // { id: "number", name: "string" }
  requestShape?: Record<string, string>;    // POST body shape
  statusCodes: number[];                    // [200, 201]
  contentType?: string;                     // json, html
  count: number;                            // Times observed
}

interface ComponentGroup {
  id: string;                              // "cg-react-searchbar"
  framework: 'react' | 'vanilla' | 'unknown';
  componentName: string;                   // "SearchBar", "LoginForm"
  props?: Record<string, unknown>;         // React props (sanitized)
  memberNodeIds: string[];                 // BehaviorNode IDs in this group
  semanticLabel?: SemanticLabel;           // Populated by Stage 5
}

interface SemanticLabel {
  category: string;    // 'auth', 'search', 'navigation', 'content', 'commerce'
  action: string;      // 'login', 'search', 'primary', 'add-to-cart'
  confidence: number;  // 0-1
  source: 'heuristic' | 'llm';
}
```

### Display IDs (`packages/core/src/graph/display-ids.ts`)

Internal AX node IDs are opaque numbers. Veil generates human-readable **display IDs** for each node:

```
"button-sign-in"     ← button with name "Sign in"
"textbox-username"   ← textbox with name "Username"
"link-forgot-password" ← link with name "Forgot password?"
```

The `DisplayIdRegistry` provides bidirectional mapping (`toDisplay` / `toInternal`) and handles collisions by appending numeric suffixes.

### Graph Differ (`packages/core/src/graph/differ.ts`)

Enables incremental graph updates by diffing AXTree snapshots:

1. `buildSnapshot(axNodes)` — creates a diffable snapshot from AX nodes
2. `diffSnapshots(old, new)` — produces `GraphDiff { added, removed, modified }`
3. `patchGraphFromDiff(graph, axNodes, diff)` — patches graph in-place

This avoids full pipeline rebuilds when only a few nodes change.

### Serialization (`packages/core/src/graph/serializer.ts`)

**Compact text format** (~70% fewer tokens than JSON):
```
PAGE https://example.com "Example"
STATE route:/

NODES
  button-sign-in [button] "Sign in"
    on:click → form_submit (POST /session)
    semantic: auth:login (0.95, heuristic)
  textbox-username [textbox] "Username"
    on:input → dom_mutation

NETWORK
  button-sign-in on:click → POST /session → 302 (html)

APIS
  POST /session → 302 html

COMPONENTS
  cg-react-loginform [react] "LoginForm" semantic:auth:login
    members: textbox-username, textbox-password, button-sign-in
```

Sections (NETWORK, APIS, COMPONENTS) are omitted when empty.

**JGF format** (JSON Graph Format for programmatic use):
```json
{
  "graph": {
    "type": "behavior-graph",
    "metadata": { "url": "...", "title": "...", "timestamp": 0, "route": "/" },
    "version": 1,
    "nodes": { "n1": { "label": "Sign in", "metadata": { "role": "button", ... } } },
    "edges": [
      { "source": "n1", "target": "POST:/session", "relation": "triggers" }
    ],
    "apiEndpoints": [...],
    "componentGroups": [...]
  }
}
```

### Query Engine (`packages/core/src/graph/query.ts`)

Filter nodes by any combination of properties:

```typescript
interface NodeFilter {
  role?: string;
  name?: string | RegExp;
  hasEvent?: string;
  state?: Record<string, string | boolean>;
  semanticCategory?: string;
  semanticAction?: string;
  componentId?: string;
}
```

### Dynamic Updates

The graph is maintained in real-time via `MutationWatcher` and `VeilPage.incrementalUpdate()`:

| Signal | Graph Action |
|--------|-------------|
| DOM mutation (debounced 150ms) | Incremental: diff AXTree → patch nodes → selective event enrichment |
| SPA navigation (`navigatedWithinDocument`) | Full rebuild for new route |
| Full-page navigation (`frameNavigated`) | Cache clear + full rebuild |
| Network request captured | Correlate to trigger node |
| Agent `interact()` call | Dispatch action → wait for settle → incremental or full update |
| Periodic poll (5s) | Consistency check via AXTree diff |

**Incremental update pipeline:**
1. Fetch fresh AXTree
2. Diff against last snapshot
3. Patch graph (add/remove/modify nodes)
4. Selective event enrichment (Stage 2 on changed nodes only)
5. Correlate new network requests (Stage 3)
6. Re-group components (Stage 4)
7. Re-infer semantics (Stage 5, heuristics only — preserves LLM labels)
8. Notify change listeners

---

## Module 5: Consumer APIs

### VeilPage SDK (`packages/core/src/index.ts`)

The primary interface for programmatic use:

```typescript
import { Veil } from '@veil/core';  // or '@veil/sdk' (re-export)

const veil = new Veil();
const page = await veil.open('https://github.com/login');

// Query the behavior graph
const graph = await page.getGraph();
const buttons = await page.query({ role: 'button' });
const loginNodes = await page.query({ semanticCategory: 'auth' });
const node = await page.getNode('button-sign-in');

// Serialization
const compact = await page.toCompactText();
const json = await page.toJSON();

// Interact
await page.interact('textbox-username', { action: 'type', text: 'user@example.com' });
await page.interact('button-sign-in', { action: 'click' });

// Real-time updates
const unsub = page.onGraphChange((graph, diff) => {
  console.log(`Changed: +${diff.added.length} -${diff.removed.length} ~${diff.modified.length}`);
});

const updated = await page.waitForGraphUpdate(30_000);

page.close();
await veil.close();
```

**Interaction types:**
```typescript
type InteractAction =
  | { action: "click" }
  | { action: "type"; text: string }
  | { action: "clear" }
  | { action: "select"; value: string }
  | { action: "focus" }
  | { action: "hover" };
```

`interact()` handles navigation detection: if a click triggers a page navigation (e.g., form POST → 302 redirect), it waits for the new page to load and does a full graph rebuild. Otherwise, it runs an incremental update.

### MCP Server (`packages/mcp/`)

Exposes Veil as native AI tools via the **Model Context Protocol** (stdio transport):

| Tool | Description |
|------|-------------|
| `veil_open` | Open a URL in a new browser session |
| `veil_graph` | Get behavior graph (compact or JSON) |
| `veil_interact` | Click, type, select, etc. on page elements |
| `veil_navigate` | Navigate to a new URL within a session |
| `veil_find` | Search nodes by role, name, or event type |
| `veil_inspect` | Get detailed info about a specific node |
| `veil_sessions` | List active browser sessions |
| `veil_close` | Close a session or all sessions |

Runs in-process with `SessionManager` — no daemon required. Works with Claude Desktop, Cursor, and any MCP-compatible host.

### HTTP/WebSocket API (`packages/server/`)

Built with **Hono** web framework:

```
# REST
POST /api/sessions              → create session (body: { url })
GET  /api/sessions              → list sessions
DELETE /api/sessions/:id        → close session

GET  /api/sessions/:id/graph                → compact text
GET  /api/sessions/:id/graph?format=json    → JGF JSON
GET  /api/sessions/:id/graph/find?q=button  → search nodes

POST /api/sessions/:id/interact → { nodeId, action, value? }
POST /api/sessions/:id/navigate → { url }

# WebSocket (real-time graph diffs)
WS   /ws/sessions/:id/graph
```

Includes a built-in web visualizer at `/` for debugging.

### CLI (`packages/cli/`)

```bash
# Session-based (via daemon)
veil open <url> [--llm]                 # Open URL, print session ID
veil sessions                            # List active sessions
veil graph <session-id> [--json]        # Print behavior graph
veil find <session-id> <query>          # Search nodes
veil inspect <session-id> <nodeId>      # Node detail
veil do <session-id> <action> <nodeId> [value]  # Interact
veil navigate <session-id> <url>        # Navigate within session
veil close <session-id | --all>         # Close session(s)
veil daemon start|stop|status|restart   # Manage daemon

# Legacy (one-shot, no session persistence)
veil decompose <url> [--timeout N] [--json] [--llm]
veil shell <url> [--llm] [--json]       # Interactive REPL
```

**Session persistence:** The CLI connects to a background daemon (`packages/cli/src/daemon.ts`) that keeps browser sessions alive across CLI invocations. This enables multi-step AI workflows (open → interact → inspect → interact → close) without re-launching Chrome each time.

---

## Session Management (`packages/server/src/sessions.ts`)

`SessionManager` is the central session lifecycle manager, used by both MCP and HTTP servers:

- Creates sessions with `crypto.randomUUID()` IDs
- Enforces `maxSessions` limit (default 10)
- Supports `navigateSession()` that properly re-wires graph change listeners
- Provides `addChangeListener()` for persistent listeners across navigation
- Graceful `shutdown()` closes all pages and the browser

Session ID prefix resolution allows short IDs (e.g., `8d06` instead of `8d060512-c7e1-...`) in both MCP and CLI.

---

## Configuration

```typescript
interface VeilConfig {
  llm?: {
    enabled: boolean;
    apiKey: string;                  // Anthropic API key
    model?: string;                  // default: "claude-sonnet-4-20250514"
    baseUrl?: string;                // default: "https://api.anthropic.com"
    maxTokens?: number;              // default: 4096
    confidenceThreshold?: number;    // default: 0.5
  };
}
```

LLM enrichment is opt-in. Without it, Stage 5 uses heuristic rules only.

---

## Tech Stack

| Layer | Technology | Rationale |
|-------|-----------|-----------|
| **Browser** | Chromium (headless) | Full JS execution; most sites target Chrome |
| **CDP client** | Raw WebSocket | Direct control, no abstraction overhead |
| **Core runtime** | TypeScript (Node.js) | Same language as CDP ecosystem, async-native |
| **HTTP server** | Hono + @hono/node-server | Lightweight, fast, TypeScript-native |
| **WebSocket** | @hono/node-ws | Real-time graph streaming |
| **MCP server** | @modelcontextprotocol/sdk | AI tool protocol standard |
| **Schema validation** | Zod | MCP tool parameter validation |
| **Build** | tsup + esbuild | Fast TypeScript bundling |
| **Test** | Vitest | Fast test runner, ESM-native |
| **Package manager** | pnpm workspaces | Monorepo-friendly, fast, strict |
| **Serialization** | JGF + compact text | JGF for SDK, compact text for LLMs |

---

## Project Structure

```
project-veil/
├── packages/
│   ├── core/                          # The brain
│   │   ├── src/
│   │   │   ├── browser/
│   │   │   │   ├── launcher.ts        # Chrome launch + lifecycle
│   │   │   │   ├── cdp-client.ts      # Raw CDP WebSocket client
│   │   │   │   ├── page.ts            # Page handle (CDP session per tab)
│   │   │   │   ├── interactions.ts    # Click, type, select via CDP
│   │   │   │   ├── mutation-watcher.ts# Real-time DOM change detection
│   │   │   │   ├── network-capture.ts # Network request/response capture
│   │   │   │   └── instrumentation.ts # Injected JS for framework detection
│   │   │   │
│   │   │   ├── pipeline/
│   │   │   │   ├── stage-1-axtree.ts     # AXTree → initial graph nodes
│   │   │   │   ├── stage-2-events.ts     # Event listener binding
│   │   │   │   ├── stage-3-network.ts    # Network correlation
│   │   │   │   ├── stage-4-components.ts # Component grouping
│   │   │   │   ├── stage-5-semantics.ts  # Semantic inference
│   │   │   │   ├── api-endpoints.ts      # URL pattern extraction
│   │   │   │   └── utils.ts             # Shared utilities
│   │   │   │
│   │   │   ├── graph/
│   │   │   │   ├── model.ts            # All type definitions
│   │   │   │   ├── serializer.ts       # Compact text + JGF serialization
│   │   │   │   ├── differ.ts           # Snapshot diffing for incremental updates
│   │   │   │   ├── display-ids.ts      # Human-readable ID generation
│   │   │   │   └── query.ts            # Graph query engine (NodeFilter)
│   │   │   │
│   │   │   └── index.ts               # Public API: Veil + VeilPage classes
│   │   │
│   │   ├── src/__tests__/             # Core unit tests
│   │   └── package.json
│   │
│   ├── sdk/                           # Re-exports from @veil/core
│   │   └── package.json               # @veil/sdk → @veil/core bridge
│   │
│   ├── server/                        # HTTP/WS API server
│   │   ├── src/
│   │   │   ├── app.ts                 # Hono app setup
│   │   │   ├── sessions.ts            # SessionManager class
│   │   │   ├── routes/
│   │   │   │   ├── sessions.ts        # CRUD session endpoints
│   │   │   │   ├── graph.ts           # Graph query endpoints
│   │   │   │   └── interact.ts        # Interaction endpoints
│   │   │   ├── ws.ts                  # WebSocket graph streaming
│   │   │   ├── visualizer.ts          # Built-in web UI
│   │   │   ├── types.ts              # ServerConfig, SessionInfo
│   │   │   ├── errors.ts             # ServerError class
│   │   │   └── index.ts
│   │   └── package.json
│   │
│   ├── mcp/                           # MCP server (AI tool protocol)
│   │   ├── src/
│   │   │   ├── index.ts               # Entry point (stdio transport)
│   │   │   ├── tools.ts               # 8 tool definitions + handlers
│   │   │   └── session-resolver.ts    # Session ID prefix matching
│   │   ├── src/__tests__/
│   │   └── package.json
│   │
│   └── cli/                           # CLI tool
│       ├── src/
│       │   ├── index.ts               # Command parser + handlers
│       │   ├── daemon.ts              # Background daemon for sessions
│       │   └── client.ts              # HTTP client to daemon
│       ├── src/__tests__/
│       └── package.json
│
├── docs/
│   ├── index.html                     # Landing page (projectveil.site)
│   └── product-overview.html          # Technical deep-dive
│
├── pnpm-workspace.yaml
├── turbo.json
├── tsconfig.base.json
├── ARCHITECTURE.md                    # This file
└── package.json
```

---

## Key Risks and Mitigations

| Risk | Impact | Mitigation |
|------|--------|------------|
| **React synthetic events** — event delegation means `getEventListeners` shows nothing on individual elements | High — React powers ~40% of top sites | Fiber tree traversal via `__reactFiber$` to find component event props |
| **Minified handler code** — can't statically analyze obfuscated handlers | Medium — affects handler categorization | Use network correlation (what API calls fire after action) as behavioral signal |
| **Anti-bot detection** — sites detect headless browsers | Medium — blocks some sites | `--disable-blink-features=AutomationControlled`, realistic User-Agent, real window size |
| **Heavy SPAs** — Gmail, Figma have massive DOMs | Medium — performance | Incremental updates (diff-based), debounced mutations, selective enrichment |
| **Navigation races** — form POST → 302 redirect during settle wait | Medium — stale graph | Navigation-aware settle: abort idle wait on `frameNavigated`, then rebuild |

---

## Error Handling

```typescript
type VeilErrorCode =
  | "NODE_NOT_FOUND"
  | "NODE_NOT_INTERACTIVE"
  | "INTERACTION_FAILED";

class VeilError extends Error {
  code: VeilErrorCode;
}
```

All consumer APIs (MCP, HTTP, SDK) catch errors and return structured error responses. The MCP server returns `{ isError: true, content: [{ type: "text", text: "Error: ..." }] }`.

---

## Future Directions

1. **Cross-page knowledge graph** — "Sites with similar login flows to X"
2. **Action planning** — Agent asks "how do I checkout?" → Veil returns a step sequence
3. **Parallel page processing** — Multiple pages decomposed concurrently
4. **Vue/Angular component detection** — Currently React + vanilla only
5. **Browser extension mode** — Run Veil as a Chrome extension for debugging
6. **Record & replay** — Record behavior graph sessions, replay interactions
7. **Visual diff** — Compare behavior graphs across page versions (regression detection)
