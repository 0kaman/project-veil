export interface BehaviorNode {
  id: string;
  role: string;
  name: string;
  description: string;
  state: Record<string, string | boolean>;
  value: string;
  backendDOMNodeId: number;
  children: string[];
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
