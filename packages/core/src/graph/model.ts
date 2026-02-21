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
}
