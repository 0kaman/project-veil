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
  responseBody?: string;   // Raw JSON body (truncated to 4KB)
  requestBody?: string;    // POST/PUT body (truncated to 4KB)
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
  source: 'heuristic' | 'llm';
}

export interface ComponentGroup {
  id: string;                              // "cg-react-searchbar" or "cg-vanilla-form-login"
  framework: 'react' | 'vanilla' | 'unknown';
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
