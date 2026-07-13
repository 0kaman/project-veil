export interface CallFrame {
  scriptId: string;
  url: string;
  functionName: string;
  lineNumber: number;   // 0-based from CDP
  columnNumber: number;  // 0-based from CDP
}

export interface NetworkRequest {
  requestId: string;
  method: string;
  url: string;
  initiatorType: "script" | "parser" | "other";
  initiatorStack?: CallFrame[];
  responseStatus?: number;
  responseContentType?: string;
  timestamp: number;
  responseBody?: string;    // Raw JSON body (truncated to 4KB)
  requestBody?: string;     // POST/PUT body (full, for replay — capped at 64KB)
  requestHeaders?: Record<string, string>;  // app-set headers, for replay
  resourceType?: string;    // XHR | Fetch | Document
}

/**
 * A replayable request template — the FULL real request an interaction fired,
 * captured so it can later be re-issued directly (with edited fields) instead of
 * re-simulating the click. The foundation of the direct-API fast path.
 */
export interface CapturedRequest {
  method: string;
  url: string;
  headers: Record<string, string>;
  body?: string;
  resourceType?: string;
  triggerNodeId: string;    // the node whose interaction produced this request
  triggerEvent: string;     // 'click' | 'submit' | ...
  timestamp: number;
}

export interface NetworkEdge {
  triggerNodeId: string;     // "" if unmatched
  triggerEvent: string;      // 'click', 'submit', 'script' (unmatched)
  request: { method: string; url: string };
  response?: {
    status: number;
    contentType: string;
    bodyShape?: Record<string, string>;  // { name: "string", id: "number" }
  };
  urlPattern?: string;  // /api/users/{id}
  replayable?: boolean; // a full CapturedRequest exists for this edge's node
}

export interface ApiEndpoint {
  pattern: string;                          // /api/users/{id}
  method: string;                           // GET
  responseShape?: Record<string, string>;   // { id: "number", name: "string" }
  requestShape?: Record<string, string>;    // POST body shape
  statusCodes: number[];                    // [200, 201]
  contentType?: string;                     // json, html
  count: number;                            // times observed
}

export interface EventBinding {
  eventType: string;
  category: "api_call" | "navigation" | "dom_mutation" | "form_submit" | "unknown";
  source?: {
    scriptUrl: string;
    lineNumber: number;
    columnNumber: number;
    functionName: string;
  };
  estimatedEffect?: string;
}

export interface SemanticLabel {
  category: string;    // 'auth', 'search', 'navigation', 'content', 'commerce', 'form', 'dynamic'
  action: string;      // 'login', 'signup', 'search', 'primary', 'add-to-cart', 'submit'
  confidence: number;  // 0-1
  source: 'heuristic' | 'inherited' | 'llm';  // 'inherited' = from component group; 'llm' = enricher
}

export interface ComponentGroup {
  id: string;                              // "cg-react-searchbar" or "cg-vanilla-form-login"
  framework: 'react' | 'vanilla';  // ('unknown' was never produced — removed)
  componentName: string;                   // "SearchBar", "LoginForm", "form-group-1"
  props?: Record<string, unknown>;         // Serializable props (React only, max 10 primitive keys)
  memberNodeIds: string[];                 // BehaviorNode IDs in this group
  semanticLabel?: SemanticLabel;           // Populated by Stage 5
}

export interface BehaviorNode {
  id: string;
  role: string;
  name: string;
  description: string;
  state: Record<string, string | boolean>;
  value: string;
  backendDOMNodeId: number;
  children: string[];
  events: EventBinding[];
  componentId?: string;
  semanticLabel?: SemanticLabel;
}

export interface BehaviorGraph {
  metadata: {
    url: string;
    title: string;
    timestamp: number;
    route: string;
    /** How many low-value nodes the budget prune dropped (0/absent = none).
     * Surfaced so a capped graph never looks complete. */
    nodesTrimmed?: number;
  };
  version: number;
  nodes: Map<string, BehaviorNode>;
  roots: string[];
  networkEdges: NetworkEdge[];
  apiEndpoints: ApiEndpoint[];
  componentGroups: ComponentGroup[];
}

export interface GraphDiff {
  added: string[];
  removed: string[];
  modified: string[];
}

export type GraphChangeCallback = (graph: BehaviorGraph, diff: GraphDiff) => void;

// --- Interaction types ---

export type InteractAction =
  | { action: "click" }
  | { action: "type"; text: string }
  | { action: "clear" }
  | { action: "select"; value: string }
  | { action: "focus" }
  | { action: "hover" };

export interface NodeFilter {
  role?: string;
  name?: string | RegExp;
  hasEvent?: string;
  state?: Record<string, string | boolean>;
  semanticCategory?: string;
  semanticAction?: string;
  componentId?: string;
}

export type VeilErrorCode =
  | "NODE_NOT_FOUND"
  | "NODE_NOT_INTERACTIVE"
  | "INTERACTION_FAILED";

export class VeilError extends Error {
  code: VeilErrorCode;

  constructor(code: VeilErrorCode, message: string) {
    super(message);
    this.name = "VeilError";
    this.code = code;
  }
}
