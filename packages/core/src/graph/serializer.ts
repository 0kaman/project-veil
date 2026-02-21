import type { BehaviorGraph, BehaviorNode } from "./model.js";

function makeDisplayId(node: BehaviorNode): string {
  const name = node.name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 30);
  return name ? `${node.role}-${name}` : `${node.role}-${node.id}`;
}

export function serializeCompactText(graph: BehaviorGraph): string {
  const lines: string[] = [];
  const displayIds = new Map<string, string>();

  // Assign display IDs
  const usedIds = new Set<string>();
  for (const [id, node] of graph.nodes) {
    let displayId = makeDisplayId(node);
    if (usedIds.has(displayId)) {
      let i = 2;
      while (usedIds.has(`${displayId}-${i}`)) i++;
      displayId = `${displayId}-${i}`;
    }
    usedIds.add(displayId);
    displayIds.set(id, displayId);
  }

  lines.push(`PAGE ${graph.metadata.url} "${graph.metadata.title}"`);
  lines.push(`STATE route:${graph.metadata.route}`);
  lines.push("");
  lines.push("NODES");

  function printNode(nodeId: string, depth: number): void {
    const node = graph.nodes.get(nodeId);
    if (!node) return;

    const indent = "  ".repeat(depth + 1);
    const displayId = displayIds.get(nodeId) ?? nodeId;

    let line = `${indent}${displayId} [${node.role}]`;
    if (node.name) line += ` "${node.name}"`;
    lines.push(line);

    const stateEntries = Object.entries(node.state);
    if (stateEntries.length > 0) {
      const stateStr = stateEntries
        .map(([k, v]) => (v === true ? k : `${k}:${v}`))
        .join(", ");
      lines.push(`${indent}  state: ${stateStr}`);
    }

    if (node.value) {
      lines.push(`${indent}  value: "${node.value}"`);
    }

    for (const childId of node.children) {
      printNode(childId, depth + 1);
    }
  }

  for (const rootId of graph.roots) {
    printNode(rootId, 0);
  }

  return lines.join("\n") + "\n";
}

export function serializeJGF(
  graph: BehaviorGraph,
): Record<string, unknown> {
  const nodes: Record<string, unknown> = {};
  const edges: Array<Record<string, string>> = [];

  for (const [id, node] of graph.nodes) {
    nodes[id] = {
      label: node.name || node.role,
      metadata: {
        role: node.role,
        name: node.name,
        description: node.description,
        state: node.state,
        value: node.value,
        backendDOMNodeId: node.backendDOMNodeId,
      },
    };

    for (const childId of node.children) {
      edges.push({
        source: id,
        target: childId,
        relation: "contains",
      });
    }
  }

  return {
    graph: {
      type: "behavior-graph",
      metadata: graph.metadata,
      nodes,
      edges,
    },
  };
}
