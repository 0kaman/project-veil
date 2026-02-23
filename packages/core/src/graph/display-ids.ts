import type { BehaviorGraph, BehaviorNode } from "./model.js";

export function makeDisplayId(node: BehaviorNode): string {
  const name = node.name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 30);
  return name ? `${node.role}-${name}` : `${node.role}-${node.id}`;
}

export interface DisplayIdRegistry {
  toInternal: Map<string, string>; // displayId → axId
  toDisplay: Map<string, string>;  // axId → displayId
}

export function buildDisplayIdRegistry(graph: BehaviorGraph): DisplayIdRegistry {
  const toInternal = new Map<string, string>();
  const toDisplay = new Map<string, string>();
  const usedIds = new Set<string>();

  for (const [id, node] of graph.nodes) {
    let displayId = makeDisplayId(node);
    if (usedIds.has(displayId)) {
      let i = 2;
      while (usedIds.has(`${displayId}-${i}`)) i++;
      displayId = `${displayId}-${i}`;
    }
    usedIds.add(displayId);
    toInternal.set(displayId, id);
    toDisplay.set(id, displayId);
  }

  return { toInternal, toDisplay };
}
