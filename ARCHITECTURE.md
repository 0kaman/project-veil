# Project Veil — System Architecture

## Vision

Project Veil is an AI-first browser that decomposes any webpage into a **Behavior Graph** — a structured representation of what a page *does*, not what it *looks like*. Instead of rendering pixels, Veil exposes interactive components, their event handlers, the API calls they make, the data flows between them, and the state transitions they trigger.

An AI agent consuming a Veil behavior graph sees something like:

```
google.com
├─ SearchInput [textbox]
│   ├─ onKeyUp → GET /complete/search?q={value}
│   ├─ onSubmit → GET /search?q={value}
│   └─ accepts: string
├─ Button["Google Search"]
│   └─ onClick → submits SearchInput → GET /search?q={value}
├─ Button["I'm Feeling Lucky"]
│   └─ onClick → GET /search?q={value}&btnI=1 → redirect
└─ NavLinks [Gmail, Images, Sign In]
    └─ each: onClick → navigate(href)
```

Instead of thousands of DOM nodes, CSS rules, and visual layout data.

---

## High-Level Architecture

```
┌──────────────────────────────────────────────────────────────────────┐
│                          PROJECT VEIL                                 │
│                                                                      │
│  ┌──────────────┐    ┌───────────────┐    ┌───────────────────────┐  │
│  │  Browser      │    │ Decomposition │    │  Behavior Graph       │  │
│  │  Runtime      │───▶│ Pipeline      │───▶│  Store                │  │
│  │  (Chromium)   │    │               │    │                       │  │
│  └──────────────┘    └───────────────┘    └───────────┬───────────┘  │
│        ▲                                              │              │
│        │ CDP                                          ▼              │
│  ┌──────────────┐                          ┌───────────────────────┐ │
│  │ Instrumentation                         │  Agent API            │ │
│  │ Layer         │                          │  (Query + Act)        │ │
│  │               │                          └───────────┬───────────┘│
│  │ Passive:      │                                      │            │
│  │  read wiring  │                                      │            │
│  │ Reactive:     │◀─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ┤            │
│  │  observe      │   (agent actions trigger             │            │
│  │  consequences │    observations)                     │            │
│  │ Ambient:      │                                      ▼            │
│  │  bg activity  │                             ┌────────────────┐   │
│  └──────────────┘                              │  AI Agents     │   │
│                                                │  (consumers)   │   │
│                                                └────────────────┘   │
└──────────────────────────────────────────────────────────────────────┘
```

### Core Modules

| Module | Responsibility | Key Technology |
|--------|---------------|----------------|
| **Browser Runtime** | JS execution, DOM construction, network | Chromium (headless) via CDP |
| **Instrumentation Layer** | Intercept events, API calls, DOM mutations | Injected JS + CDP domains |
| **Decomposition Pipeline** | Transform raw signals into behavior graph | TypeScript, AST analysis |
| **Behavior Graph Store** | Hold and update the live graph | In-memory graph structure |
| **Agent API** | Query the graph + execute actions | TypeScript SDK + HTTP/WebSocket |

---

## Module 1: Browser Runtime

### Design Decision: Raw CDP over Playwright/Puppeteer

We use **raw Chrome DevTools Protocol** directly, not Playwright or Puppeteer.

**Rationale:**
- Playwright's Node.js relay adds a network hop on every CDP call — prohibitive when making thousands of calls for event listeners, accessibility tree queries, and network monitoring
- CDP exposes event-driven subscriptions (real-time DOM mutations, network events, accessibility tree updates) that Playwright's request-response model obscures
- browser-use migrated from Playwright to raw CDP for exactly these reasons
- We need fine-grained control over Debugger domain, DOMDebugger, and Accessibility domain simultaneously

**What we use from Chromium:**
- V8 JavaScript engine (full JS execution — required for SPAs)
- DOM construction and mutation tracking
- Network stack (HTTP/2, WebSocket, fetch)
- Accessibility tree computation
- DevTools Protocol server

**What we skip:**
- Blink rendering engine (layout, paint, composite)
- GPU process (no visual output)
- CSS computation beyond what affects DOM structure (display:none matters, colors don't)

### Launch Configuration

```typescript
// Chromium launch flags for Veil
const VEIL_CHROME_FLAGS = [
  '--headless=new',           // New headless mode (Chromium 112+)
  '--disable-gpu',            // No GPU compositing
  '--disable-software-rasterizer',
  '--disable-extensions',
  '--disable-background-networking',
  '--disable-default-apps',
  '--disable-sync',
  '--disable-translate',
  '--no-first-run',
  '--disable-popup-blocking',
  // Performance: disable visual features
  '--disable-image-loading',       // Optional: skip image decode
  '--blink-settings=imagesEnabled=false', // No image rendering
  '--run-all-compositor-stages-before-draw', // Skip compositor
  // Enable necessary features
  '--enable-features=Accessibility', // Full AXTree support
];
```

### CDP Domains Enabled

| Domain | Purpose | Events Subscribed |
|--------|---------|-------------------|
| `Page` | Navigation, lifecycle | `loadEventFired`, `navigatedWithinDocument`, `frameNavigated` |
| `DOM` | DOM structure, mutations | `documentUpdated`, `childNodeInserted`, `childNodeRemoved`, `attributeModified` |
| `DOMSnapshot` | Full DOM capture | (on-demand, not event-driven) |
| `DOMDebugger` | Event listener enumeration | (on-demand per node) |
| `Network` | Request/response interception | `requestWillBeSent`, `responseReceived`, `loadingFinished` |
| `Debugger` | Stack traces, async chains | `scriptParsed` (for source maps) |
| `Accessibility` | Semantic tree | `loadComplete`, `nodesUpdated` |
| `Runtime` | JS evaluation, object inspection | (on-demand) |

---

## Module 2: Instrumentation Layer

The instrumentation layer reads the page's wiring and observes consequences of agent actions. It does **not** listen for human interaction — there is no human. Instead, it operates in three modes:

- **Passive:** Intercept handler *registrations* at page load to know what's wired up before anything fires
- **Reactive:** Observe *consequences* of agent-initiated actions (API calls, DOM changes, navigation)
- **Ambient:** Capture page self-initiated behaviors (background polling, WebSocket connections, auto-redirects, timer-based fetches)

It operates at two levels: **CDP-level observation** (external, non-invasive) and **injected script instrumentation** (internal, more detailed).

### 2a. CDP-Level Observation

These run outside the page context, observing through the protocol:

**Network Monitor (Reactive + Ambient)**

Captures all network activity — both page-initiated (background polling, resource loading) and consequence of agent actions (API calls triggered by programmatic clicks/submits).
```
Network.requestWillBeSent → capture {url, method, headers, initiator.stack}
Network.responseReceived  → capture {status, headers, mimeType}
Network.loadingFinished   → capture {encodedDataLength, timing}
```
Every network request is captured with its full initiator stack trace (requires `Debugger.enable` + `Debugger.setAsyncCallStackDepth({maxDepth: 32})`). This lets us trace which JS function/component triggered each API call. When an agent triggers `page.interact('search-btn', { action: 'click' })`, the network monitor observes what API calls fire as a consequence and maps them back to the triggering node.

**Accessibility Tree Observer (Passive + Reactive)**
```
Accessibility.loadComplete → full AXTree snapshot (passive: read page structure at load)
Accessibility.nodesUpdated → incremental node patches (reactive: graph updates after agent actions)
```
The AXTree is the structural skeleton of our behavior graph. It strips visual noise and provides semantic roles, accessible names, interactive states, and ARIA relationships.

**DOM Mutation Observer (Reactive + Ambient)**

Tracks DOM changes that result from agent actions or page self-initiated behavior:
```
DOM.childNodeInserted → new interactive elements appeared (e.g., after agent navigated)
DOM.childNodeRemoved  → components removed (e.g., modal closed)
DOM.attributeModified → state changes (disabled, hidden, etc.)
```

### 2b. Injected Script Instrumentation

Injected via `Page.addScriptToEvaluateOnNewDocument` before any page script runs. This captures signals invisible to CDP.

**Handler Registration Interceptor (Passive)**

Wraps `addEventListener`/`removeEventListener` to build a complete map of what's wired up at page load time — *before* any interaction happens. This is how we know "this button has a click handler" without ever clicking it.

```javascript
// Fires when page JS registers a handler, NOT when the event occurs
// e.g., React calling addEventListener('click', dispatcher) on the root
// e.g., Vanilla JS attaching onclick to a button during page init
```

**API Proxy Layer (Reactive + Ambient)**

Wraps network and navigation APIs to capture both page-initiated background activity and consequences of agent actions:

| API | Mode | Why |
|-----|------|-----|
| `window.fetch` | Reactive + Ambient | Capture API calls with caller stack — whether triggered by agent action or page's own timers |
| `XMLHttpRequest.open/send` | Reactive + Ambient | Legacy API calls |
| `history.pushState/replaceState` | Reactive + Ambient | SPA navigation — whether agent-triggered or auto-redirect |
| `EventTarget.prototype.addEventListener` | Passive | Track handler *registrations* at page load, not events themselves |
| `EventTarget.prototype.removeEventListener` | Passive | Track handler lifecycle (handler removed = graph edge removed) |
| `window.postMessage` | Ambient | Cross-frame communication happening in the background |
| `localStorage/sessionStorage` | Reactive | Client-side state persistence after agent actions |
| `document.cookie` setter | Reactive | Auth state changes after login/logout actions |

**Framework Detection & Component Bridge (Passive)**
```javascript
// Auto-detect framework on page load
function detectFramework(document) {
  if (findReactRoot(document))  return 'react';
  if (findVueApp(document))     return 'vue';
  if (findAngularApp(document)) return 'angular';
  return 'vanilla';
}

// React: traverse __reactFiber$ to recover component tree
// Vue: traverse __vue_app__ / __vue__ instances
// Angular: use ng.getComponent() (dev mode only)
// Vanilla: rely purely on AXTree + event listeners
```

**Handler Registration Registry (Passive)**

By wrapping `addEventListener` before page scripts run, we maintain a complete registry of what's wired up. This fires during page initialization when the page's JS attaches handlers — not when a user or agent interacts:
```typescript
type ListenerRecord = {
  element: WeakRef<EventTarget>;
  type: string;         // 'click', 'submit', 'keyup', etc.
  handler: Function;
  options: AddEventListenerOptions;
  stackAtRegistration: string;  // Where in the page's code the handler was attached
  componentName?: string;       // Resolved from framework bridge
};
```

For React (which uses event delegation — single listener on root, not per-element), we bypass this by traversing the Fiber tree directly to find `onClick`, `onChange`, etc. props on each Fiber node.

---

## Module 3: Decomposition Pipeline

The pipeline transforms raw signals into the behavior graph. It runs in stages, each enriching the graph.

```
┌─────────┐    ┌──────────┐    ┌───────────┐    ┌──────────┐    ┌──────────┐
│ Stage 1  │───▶│ Stage 2  │───▶│ Stage 3   │───▶│ Stage 4  │───▶│ Stage 5  │
│ AXTree   │    │ Event    │    │ Network   │    │Component │    │ Semantic │
│ Skeleton │    │ Binding  │    │ Correlation│   │ Grouping │    │ Inference│
└─────────┘    └──────────┘    └───────────┘    └──────────┘    └──────────┘
```

### Stage 1: AXTree Skeleton

Extract the accessibility tree and create the initial graph nodes.

**Input:** `Accessibility.getFullAXTree()` response
**Output:** Graph nodes for each meaningful AXNode

**Filtering rules:**
- Include: all nodes with interactive roles (button, link, textbox, checkbox, select, slider, switch, tab, menuitem, etc.)
- Include: all semantic containers (form, navigation, main, dialog, alertdialog, toolbar, list)
- Include: all nodes with non-empty accessible names that represent content landmarks
- Exclude: ignored nodes, purely decorative nodes, generic containers with no semantic role
- Collapse: chains of single-child generic containers (div > div > div > button → button)

**Node creation:**
```typescript
interface BehaviorNode {
  id: string;                    // Stable identifier (AXNodeId + fallback heuristic)
  role: string;                  // ARIA role: 'button', 'textbox', 'link', etc.
  name: string;                  // Accessible name: "Google Search", "Email input"
  description?: string;          // Accessible description if available
  state: Record<string, any>;    // { disabled: false, expanded: true, checked: false }
  value?: string;                // Current value for inputs
  backendDOMNodeId: number;      // Link back to DOM (for enrichment in later stages)

  // Populated in later stages:
  eventHandlers: EventEdge[];
  networkCalls: NetworkEdge[];
  dataFlows: DataFlowEdge[];
  componentInfo?: ComponentInfo;
}
```

**Expected compression:** A typical page with 3,000-10,000 DOM nodes reduces to 50-300 behavior graph nodes.

### Stage 2: Event Binding

For each interactive node, enumerate what happens when you interact with it.

**Process:**
1. Resolve `backendDOMNodeId` → `Runtime.RemoteObject` via `DOM.resolveNode`
2. Call `DOMDebugger.getEventListeners(objectId)` to get registered listeners
3. For each listener, extract: event type, handler source location, handler function reference
4. Categorize the handler's likely behavior via lightweight static analysis of the handler source:
   - **API call**: handler contains `fetch(`, `axios.`, `$.ajax`, `XMLHttpRequest`
   - **Navigation**: handler contains `location.href`, `history.push`, `router.navigate`
   - **DOM mutation**: handler contains `innerHTML`, `appendChild`, `setState`, `dispatch`
   - **Form submission**: handler contains `form.submit()`, `event.target.submit`
   - **Unknown**: handler is opaque (minified, closure-captured)

**For React apps** (event delegation):
1. Resolve `backendDOMNodeId` → DOM element
2. Find `__reactFiber$` key on element → Fiber node
3. Walk up Fiber tree to find component with relevant event props (`onClick`, `onChange`, `onSubmit`)
4. Extract the prop function and analyze it

**Edge creation:**
```typescript
interface EventEdge {
  eventType: string;        // 'click', 'submit', 'keyup', 'change'
  handlerCategory: string;  // 'api_call', 'navigation', 'dom_mutation', 'form_submit', 'unknown'
  handlerSource?: {         // Source location if available
    scriptUrl: string;
    lineNumber: number;
    columnNumber: number;
    functionName: string;
  };
  estimatedEffect?: string; // 'POST /api/login', 'navigate:/dashboard', 'update:resultsList'
}
```

### Stage 3: Network Correlation

Map API calls to the components that trigger them and the components that consume their responses.

**Process:**
1. From `Network.requestWillBeSent`, extract `initiator.stack` (full async call chain)
2. Parse stack frames → find the user-authored frame (skip framework internals)
3. Match the source location to a handler identified in Stage 2
4. Create the full edge: `Node → EventHandler → API Call → Response`

**Correlation data:**
```typescript
interface NetworkEdge {
  triggerNodeId: string;       // Which behavior node initiated this
  triggerEvent: string;        // What user action triggered it ('click', 'submit', 'auto')
  request: {
    method: string;            // GET, POST, PUT, DELETE
    url: string;               // /api/search?q=...
    urlPattern: string;        // /api/search?q={searchInput.value}
    contentType?: string;
    bodyShape?: object;        // { email: 'string', password: 'string' }
  };
  response: {
    status: number;
    contentType: string;
    bodyShape?: object;        // Inferred JSON shape: { token: 'string', user: {...} }
  };
  affectedNodes?: string[];    // Nodes whose content/state changed after this response
}
```

**URL pattern inference:** When the same endpoint is called multiple times with different parameters, infer the URL pattern (e.g., `/api/users/123` → `/api/users/{id}`).

### Stage 4: Component Grouping

Group related behavior nodes into logical components when framework information is available.

**Process:**
1. If React detected: walk Fiber tree, create component groups matching React component boundaries
2. If Vue detected: walk `__vue_app__` instance tree
3. If Angular detected (dev mode): use `ng.getComponent()`
4. If vanilla/unknown: use heuristic grouping based on DOM proximity + shared event handlers + ARIA relationships (`aria-controls`, `aria-owns`)

**Component node:**
```typescript
interface ComponentInfo {
  framework: 'react' | 'vue' | 'angular' | 'vanilla' | 'unknown';
  componentName: string;       // 'SearchBar', 'LoginForm', 'ProductCard'
  props?: Record<string, any>; // Current props (sanitized — no secrets)
  state?: Record<string, any>; // Current state (sanitized)
  childNodeIds: string[];      // Behavior nodes inside this component
}
```

### Stage 5: Semantic Inference

Add high-level semantic labels using heuristics + optional LLM pass.

**Heuristic rules:**
- Form with `type=password` field → `auth:login` or `auth:signup`
- Input with `type=search` or `role=searchbox` → `search:input`
- List of similar items with links → `content:list` (product list, article list, etc.)
- Navigation landmark with links → `navigation:primary` or `navigation:secondary`
- Button near a form with `type=submit` → `form:submit`
- Element with `aria-live` → `dynamic:live-region`

**Optional LLM enrichment:**
For pages where heuristics are insufficient, pass the partial behavior graph to an LLM with the prompt: "Given this behavior graph, label each node with its functional purpose in the page." This is optional and can be disabled for latency-sensitive use cases.

```typescript
interface SemanticLabel {
  category: string;    // 'auth', 'search', 'navigation', 'content', 'commerce', etc.
  action: string;      // 'login', 'search', 'filter', 'add-to-cart', 'checkout'
  confidence: number;  // 0-1, how confident the inference is
  source: 'heuristic' | 'llm';
}
```

---

## Module 4: Behavior Graph Store

### Data Model

The behavior graph is a directed property graph with two node types (BehaviorNode, ComponentGroup) and four edge types.

```typescript
interface BehaviorGraph {
  // Metadata
  url: string;
  title: string;
  timestamp: number;
  pageState: PageState;

  // Graph structure
  nodes: Map<string, BehaviorNode>;
  components: Map<string, ComponentInfo>;
  edges: {
    events: EventEdge[];          // Node → action (click triggers API call)
    network: NetworkEdge[];       // Node → API → response → Node
    dataFlow: DataFlowEdge[];     // Node A's value flows to Node B
    containment: ContainmentEdge[]; // Component contains Nodes
  };

  // Convenience indexes
  nodesByRole: Map<string, BehaviorNode[]>;     // 'button' → [all buttons]
  nodesBySemantic: Map<string, BehaviorNode[]>; // 'auth:login' → [login form nodes]
  apiEndpoints: Map<string, NetworkEdge[]>;     // '/api/search' → [related edges]
}
```

### Page State Machine

The page itself is modeled as a state machine. Each state has its own behavior subgraph.

```typescript
interface PageState {
  id: string;
  route: string;                    // Current URL path
  authState: 'unknown' | 'authenticated' | 'unauthenticated';
  activeOverlays: string[];         // Open modals, popovers, dropdowns
  previousState?: string;           // Link to previous state ID
  transitionCause?: string;         // What triggered this state
}
```

State transitions create new graph versions:
```
v1 (route:/login, unauth)
  → user submits login form
  → POST /api/auth/login → 200 OK
v2 (route:/dashboard, auth)
  → new behavior subgraph with dashboard components
```

### Dynamic Updates

The graph is maintained in real-time as the page changes:

| Signal Source | Update Trigger | Graph Action |
|--------------|----------------|--------------|
| `Accessibility.nodesUpdated` | AXTree node changed | Update/add/remove behavior nodes |
| `DOM.childNodeInserted` | New element added | Re-run Stage 1-2 for subtree |
| `DOM.childNodeRemoved` | Element removed | Remove behavior nodes + edges |
| `Network.requestWillBeSent` | New API call | Add network edge |
| `Page.navigatedWithinDocument` | SPA navigation | Create new page state + rebuild subgraph |
| Injected: `history.pushState` intercepted | SPA route change | Create new page state |
| Injected: `addEventListener` intercepted | New listener registered | Add event edge to node |

**Debouncing:** DOM mutations are batched with a 150ms debounce window. After the last mutation in a burst, the pipeline re-runs Stages 1-3 on the affected subtree (not the full page).

**Consistency check:** Every 5 seconds (configurable), a full AXTree snapshot is diffed against the current graph to catch any mutations that slipped through incremental updates.

### Storage

**Primary: In-memory** — The active page's behavior graph lives in memory. A typical graph (300 nodes, 1000 edges) is <1MB. Sub-millisecond query latency.

**Optional: Persistent knowledge layer** — For cross-session learning ("I've visited this site before, here's the behavior pattern"), store graph snapshots in a lightweight embedded database (SQLite with JSON columns, or an embedded graph like DuckDB). Not needed for MVP.

---

## Module 5: Agent API

The Agent API is how AI agents consume the behavior graph and interact with pages.

### Serialization Format

The graph is serialized in **JSON Graph Format (JGF)** for structured consumption, with a **compact text format** optimized for LLM context windows.

**JGF format** (for programmatic SDK use):
```json
{
  "graph": {
    "metadata": { "url": "https://google.com", "title": "Google" },
    "nodes": {
      "search-input": {
        "metadata": {
          "role": "textbox",
          "name": "Search",
          "events": [
            { "type": "keyup", "effect": "GET /complete/search?q={value}" },
            { "type": "submit", "effect": "GET /search?q={value}" }
          ]
        }
      }
    },
    "edges": [
      { "source": "search-btn", "target": "search-input", "relation": "submits" },
      { "source": "search-input", "target": "api:/complete/search", "relation": "triggers" }
    ]
  }
}
```

**Compact text format** (for LLM prompts — ~70% fewer tokens):
```
PAGE google.com "Google"
STATE route:/ auth:unknown

NODES
  search-input [textbox] "Search"
    on:keyup → GET /complete/search?q={value}
    on:submit → GET /search?q={value}
  search-btn [button] "Google Search"
    on:click → submits search-input
  lucky-btn [button] "I'm Feeling Lucky"
    on:click → GET /search?q={value}&btnI=1 → redirect
  nav [navigation] "Main"
    link "Gmail" → navigate:https://mail.google.com
    link "Images" → navigate:https://images.google.com
    link "Sign In" → navigate:/accounts/signin

APIS
  GET /complete/search?q={q} → JSON {suggestions: string[]}
  GET /search?q={q} → HTML (search results page)

FLOWS
  search-input.value → search-btn.click → /search?q={value}
```

### SDK Interface

```typescript
import { Veil } from '@project-veil/sdk';

// Initialize
const veil = new Veil();
const page = await veil.open('https://google.com');

// Query the behavior graph
const graph = await page.getGraph();                    // Full graph
const inputs = await page.query({ role: 'textbox' });   // Find by role
const loginForm = await page.query({ semantic: 'auth:login' }); // Find by semantic
const apiCalls = await page.getAPICalls();              // All detected API endpoints

// Get LLM-friendly representation
const compact = await page.toCompactText();   // Token-efficient text format
const json = await page.toJSON();             // Full JGF

// Interact with the page through the graph
await page.interact('search-input', {
  action: 'type',
  value: 'project veil browser'
});
await page.interact('search-btn', { action: 'click' });

// Wait for graph to update after interaction
const newGraph = await page.waitForGraphUpdate();

// Observe state transitions
page.onStateChange((oldState, newState) => {
  console.log(`Page transitioned: ${oldState.route} → ${newState.route}`);
});

// Direct API interaction (bypass UI entirely)
const suggestions = await page.callAPI('GET /complete/search', { q: 'veil' });
```

### HTTP/WebSocket API (for non-TypeScript agents)

```
# REST endpoints
GET  /api/page                     → current page info
GET  /api/graph                    → full behavior graph (JGF)
GET  /api/graph/compact            → compact text format
GET  /api/graph/nodes              → all nodes
GET  /api/graph/nodes?role=button  → filter by role
GET  /api/graph/nodes?semantic=auth:login → filter by semantic
GET  /api/graph/apis               → all detected API endpoints
POST /api/interact                 → { nodeId, action, value? }
POST /api/navigate                 → { url }

# WebSocket (real-time graph updates)
WS   /ws/graph                     → stream of graph diffs
```

---

## Tech Stack

| Layer | Technology | Rationale |
|-------|-----------|-----------|
| **Browser engine** | Chromium (headless) | Full JS execution required; most sites target Chrome |
| **CDP client** | Raw WebSocket to CDP | Direct control, no abstraction overhead |
| **Core runtime** | TypeScript (Node.js) | Same language as CDP, rich ecosystem, async-native |
| **Injected scripts** | TypeScript → bundled JS | Runs in page context for API proxying |
| **AST analysis** | Babel parser + traverse | For static analysis of event handler source code |
| **Graph structure** | In-memory (graphlib or custom) | Sub-ms queries, <1MB per page graph |
| **Serialization** | JSON (JGF) + compact text | JGF for SDK, compact text for LLMs |
| **SDK** | TypeScript | Matches AI agent ecosystem (LangChain, etc.) |
| **HTTP API** | Fastify or Hono | Lightweight, fast, TypeScript-native |
| **WebSocket** | ws (Node.js) | Real-time graph streaming |
| **Build** | tsup + esbuild | Fast builds for injected scripts |
| **Package manager** | pnpm | Monorepo-friendly, fast |
| **Monorepo** | pnpm workspaces + turborepo | Multiple packages (core, sdk, cli) |

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
│   │   │   │   └── page.ts            # Page abstraction (CDP session per tab)
│   │   │   │
│   │   │   ├── instrumentation/
│   │   │   │   ├── network-monitor.ts  # Network.* event handling
│   │   │   │   ├── axtree-observer.ts  # Accessibility.* event handling
│   │   │   │   ├── dom-observer.ts     # DOM.* event handling
│   │   │   │   ├── event-tracer.ts     # DOMDebugger.getEventListeners
│   │   │   │   └── framework-bridge.ts # React/Vue/Angular component detection
│   │   │   │
│   │   │   ├── injected/
│   │   │   │   ├── api-proxy.ts        # fetch/XHR/history wrappers
│   │   │   │   ├── listener-registry.ts# addEventListener wrapper
│   │   │   │   ├── framework-detect.ts # Framework auto-detection
│   │   │   │   └── bridge.ts           # Communication with core (via CDP Runtime.evaluate)
│   │   │   │
│   │   │   ├── pipeline/
│   │   │   │   ├── stage-1-axtree.ts     # AXTree → initial graph nodes
│   │   │   │   ├── stage-2-events.ts     # Event listener binding
│   │   │   │   ├── stage-3-network.ts    # Network correlation
│   │   │   │   ├── stage-4-components.ts # Component grouping
│   │   │   │   ├── stage-5-semantic.ts   # Semantic inference
│   │   │   │   └── pipeline.ts           # Orchestrates stages 1-5
│   │   │   │
│   │   │   ├── graph/
│   │   │   │   ├── model.ts            # BehaviorGraph, BehaviorNode, Edge types
│   │   │   │   ├── store.ts            # In-memory graph with indexes
│   │   │   │   ├── differ.ts           # Graph diffing for updates
│   │   │   │   ├── serializer.ts       # JGF + compact text serialization
│   │   │   │   └── query.ts            # Graph query engine
│   │   │   │
│   │   │   └── index.ts               # Public API: Veil class
│   │   │
│   │   ├── tests/
│   │   └── package.json
│   │
│   ├── sdk/                           # TypeScript SDK for agents
│   │   ├── src/
│   │   │   ├── client.ts              # High-level Veil client
│   │   │   ├── types.ts               # Public type definitions
│   │   │   └── index.ts
│   │   └── package.json
│   │
│   ├── server/                        # HTTP/WS API server
│   │   ├── src/
│   │   │   ├── routes/                # REST endpoints
│   │   │   ├── ws.ts                  # WebSocket graph streaming
│   │   │   └── index.ts
│   │   └── package.json
│   │
│   └── cli/                           # CLI tool
│       ├── src/
│       │   └── index.ts               # `veil open https://google.com`
│       └── package.json
│
├── pnpm-workspace.yaml
├── turbo.json
├── tsconfig.base.json
├── ARCHITECTURE.md                    # This file
└── package.json
```

---

## MVP Scope

### What the MVP does

Given a URL, Veil:
1. Opens it in headless Chromium
2. Waits for page load + JS execution
3. Runs the decomposition pipeline (stages 1-3; skip 4-5 for MVP)
4. Outputs a behavior graph in both JGF and compact text format
5. Allows basic interaction (click, type) through the SDK

### MVP stages included

| Stage | MVP? | Rationale |
|-------|------|-----------|
| Stage 1: AXTree Skeleton | Yes | Foundation — must have |
| Stage 2: Event Binding | Yes | Core differentiator — what buttons do |
| Stage 3: Network Correlation | Yes | High value — API discovery |
| Stage 4: Component Grouping | No | Nice-to-have, framework-dependent |
| Stage 5: Semantic Inference | No | Requires LLM integration, can add later |

### MVP milestones

**M1 — Foundation (Week 1-2)**
- Chrome launcher with Veil flags
- Raw CDP client (WebSocket)
- Basic page lifecycle (open, wait for load, close)
- AXTree extraction (Stage 1) → initial graph nodes
- Compact text serializer
- CLI: `veil decompose https://google.com` → prints graph

**M2 — Event Tracing (Week 3-4)**
- Event listener enumeration via DOMDebugger
- Injected scripts: addEventListener wrapper, fetch/XHR proxy
- Stage 2: bind events to graph nodes
- Basic handler categorization (API call, navigation, DOM mutation)
- React event delegation handling (Fiber tree traversal)

**M3 — Network Correlation (Week 5-6)**
- Network monitor with full initiator stack traces
- Stack trace → source location → handler → node correlation
- Stage 3: network edges in the graph
- URL pattern inference for repeated API calls
- JGF serializer

**M4 — Agent API (Week 7-8)**
- TypeScript SDK: open, query, interact, observe
- HTTP API server (REST endpoints)
- WebSocket graph streaming (real-time updates)
- Basic interaction: click, type, select
- Dynamic graph updates (DOM mutation → graph patch)

### What success looks like for MVP

Run this:
```bash
veil decompose https://google.com
```

Get this:
```
PAGE google.com "Google"
STATE route:/ auth:unknown

NODES
  search-input [textbox] "Search"
    on:keyup → GET /complete/search?q={value}
    on:submit → GET /search?q={value}
  search-btn [button] "Google Search"
    on:click → submits:search-input
  lucky-btn [button] "I'm Feeling Lucky"
    on:click → GET /search?q={value}&btnI=1
  ...

APIS
  GET /complete/search — autocomplete suggestions
  GET /search — search results
```

And an AI agent can:
```typescript
const veil = new Veil();
const page = await veil.open('https://google.com');
const graph = await page.getGraph();

// Agent sees the graph, decides to search
await page.interact('search-input', { action: 'type', value: 'AI browser' });
await page.interact('search-btn', { action: 'click' });

// Graph updates after navigation
const results = await page.waitForGraphUpdate();
// → new graph with search result nodes
```

---

## Key Risks and Mitigations

| Risk | Impact | Mitigation |
|------|--------|------------|
| **React synthetic events** — event delegation means `getEventListeners` shows nothing on individual elements | High — React powers ~40% of top sites | Fiber tree traversal to find component event props; fall back to root listener analysis |
| **Minified handler code** — can't statically analyze `function(e){t.a(e.target.value)}` | Medium — affects handler categorization | Use network correlation (what API calls fire after click) as the behavioral signal instead of source analysis |
| **Layout-dependent JS** — `getBoundingClientRect()`, `IntersectionObserver` | Medium — some features break without layout | Chromium headless still computes layout (just doesn't paint); provide mock values for edge cases |
| **Anti-bot detection** — sites detect headless browsers | Medium — blocks access to some sites | Use `--disable-blink-features=AutomationControlled`, realistic User-Agent; not a focus for MVP |
| **Performance on heavy SPAs** — Gmail, Figma have massive DOMs | Low for MVP — start with simpler sites | Lazy subgraph construction; debounced updates; configurable depth limits |
| **CDP protocol changes** — Chrome updates may break CDP calls | Low — CDP is stable and versioned | Pin Chrome version; use CDP protocol version parameter |

---

## Future Directions (Post-MVP)

1. **Semantic inference (Stage 5)** — LLM-powered labeling of node purposes
2. **Component grouping (Stage 4)** — Framework-aware component boundaries
3. **Cross-page knowledge graph** — "Sites with similar login flows to X"
4. **Action planning** — Agent asks "how do I checkout?" → Veil returns a step sequence
5. **Parallel page processing** — Multiple pages decomposed concurrently
6. **Browser extension mode** — Run Veil as a Chrome extension for debugging/development
7. **Record & replay** — Record a behavior graph session, replay interactions
8. **Visual diff** — Compare behavior graphs across page versions (regression detection)
