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
}

export interface NetworkEdge {
  triggerNodeId: string;     // "" if unmatched
  triggerEvent: string;      // 'click', 'submit', 'script' (unmatched)
  request: { method: string; url: string };
  response?: { status: number; contentType: string };
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
}

export interface BehaviorGraph {
  metadata: {
    url: string;
    title: string;
    timestamp: number;
    route: string;
  };
  nodes: Map<string, BehaviorNode>;
  roots: string[];
  networkEdges: NetworkEdge[];
}

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
