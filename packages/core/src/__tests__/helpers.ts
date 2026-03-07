import type { BehaviorNode, BehaviorGraph, EventBinding, NetworkEdge, ApiEndpoint, ComponentGroup, SemanticLabel } from "../graph/model.js";
import type { AXNode } from "../browser/page.js";

export function makeNode(overrides: Partial<BehaviorNode> & { id: string }): BehaviorNode {
  return {
    role: "button",
    name: "",
    description: "",
    state: {},
    value: "",
    backendDOMNodeId: 0,
    children: [],
    events: [],
    ...overrides,
  };
}

export function makeGraph(overrides: Partial<BehaviorGraph> = {}): BehaviorGraph {
  return {
    metadata: { url: "https://example.com", title: "Test", timestamp: Date.now(), route: "/" },
    version: 1,
    nodes: new Map(),
    roots: [],
    networkEdges: [],
    apiEndpoints: [],
    componentGroups: [],
    ...overrides,
  };
}

export function makeAXNode(overrides: Partial<AXNode> & { nodeId: string }): AXNode {
  return {
    ignored: false,
    role: { type: "role", value: "generic" },
    ...overrides,
  };
}

export function makeEvent(overrides: Partial<EventBinding> = {}): EventBinding {
  return {
    eventType: "click",
    category: "unknown",
    ...overrides,
  };
}

export function makeNetworkEdge(overrides: Partial<NetworkEdge> = {}): NetworkEdge {
  return {
    triggerNodeId: "",
    triggerEvent: "click",
    request: { method: "GET", url: "https://api.example.com/data" },
    ...overrides,
  };
}
