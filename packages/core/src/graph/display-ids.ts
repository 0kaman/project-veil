import type { BehaviorGraph, BehaviorNode } from "./model.js";

/**
 * Build a stable, human-readable display ID for a node.
 *
 * Named nodes get `${role}-${nameSlug}` — content-derived and stable across
 * sessions. Unnamed nodes have no content to derive from; pass `ordinal` (a
 * deterministic tree-position index) to get a stable `${role}-${ordinal}`.
 * Without an ordinal, falls back to the runtime AX `node.id` — which is NOT
 * stable across sessions, so callers that need determinism must supply one.
 */
export function makeDisplayId(node: BehaviorNode, ordinal?: number): string {
  const name = node.name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 30);
  if (name) return `${node.role}-${name}`;
  return `${node.role}-${ordinal ?? node.id}`;
}

export interface DisplayIdRegistry {
  toInternal: Map<string, string>; // displayId → axId
  toDisplay: Map<string, string>;  // axId → displayId
}

export function buildDisplayIdRegistry(graph: BehaviorGraph): DisplayIdRegistry {
  const toInternal = new Map<string, string>();
  const toDisplay = new Map<string, string>();
  const usedIds = new Set<string>();

  // Assign a deterministic ordinal to every node via DFS from roots, in
  // document order. This is stable across sessions because tree structure
  // and child order are stable — unlike the runtime AX node IDs, which
  // Chrome reassigns each session. Orphans (unreachable from roots) get
  // ordinals afterward in Map order.
  const ordinal = new Map<string, number>();
  let counter = 0;
  const visit = (nodeId: string): void => {
    if (ordinal.has(nodeId)) return;
    ordinal.set(nodeId, counter++);
    const node = graph.nodes.get(nodeId);
    if (!node) return;
    for (const childId of node.children) visit(childId);
  };
  for (const rootId of graph.roots) visit(rootId);
  for (const id of graph.nodes.keys()) visit(id);

  // Iterate in ordinal order so collision suffixes (-2, -3) are deterministic.
  const orderedIds = [...graph.nodes.keys()].sort(
    (a, b) => (ordinal.get(a) ?? 0) - (ordinal.get(b) ?? 0),
  );

  for (const id of orderedIds) {
    const node = graph.nodes.get(id)!;
    let displayId = makeDisplayId(node, ordinal.get(id));
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
