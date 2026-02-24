import type { BehaviorGraph, BehaviorNode, NodeFilter } from "./model.js";

export function queryNodes(graph: BehaviorGraph, filter: NodeFilter): BehaviorNode[] {
  const results: BehaviorNode[] = [];

  for (const node of graph.nodes.values()) {
    if (filter.role && node.role !== filter.role) continue;

    if (filter.name !== undefined) {
      if (filter.name instanceof RegExp) {
        if (!filter.name.test(node.name)) continue;
      } else {
        if (node.name !== filter.name) continue;
      }
    }

    if (filter.hasEvent) {
      if (!node.events.some((e) => e.eventType === filter.hasEvent)) continue;
    }

    if (filter.state) {
      let stateMatch = true;
      for (const [key, val] of Object.entries(filter.state)) {
        if (node.state[key] !== val) {
          stateMatch = false;
          break;
        }
      }
      if (!stateMatch) continue;
    }

    if (filter.semanticCategory && node.semanticLabel?.category !== filter.semanticCategory) continue;
    if (filter.semanticAction && node.semanticLabel?.action !== filter.semanticAction) continue;
    if (filter.componentId && node.componentId !== filter.componentId) continue;

    results.push(node);
  }

  return results;
}
