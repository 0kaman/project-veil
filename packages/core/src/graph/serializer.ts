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

    for (const event of node.events) {
      const effect = event.estimatedEffect
        ? ` (${event.estimatedEffect})`
        : "";
      lines.push(
        `${indent}  on:${event.eventType} → ${event.category}${effect}`,
      );
    }

    for (const childId of node.children) {
      printNode(childId, depth + 1);
    }
  }

  for (const rootId of graph.roots) {
    printNode(rootId, 0);
  }

  // NETWORK section
  if (graph.networkEdges.length > 0) {
    lines.push("");
    lines.push("NETWORK");
    for (const edge of graph.networkEdges) {
      const source = edge.triggerNodeId
        ? `${displayIds.get(edge.triggerNodeId) ?? edge.triggerNodeId} on:${edge.triggerEvent}`
        : `[page] ${edge.triggerEvent}`;
      const resp = edge.response
        ? ` → ${edge.response.status} (${shortContentType(edge.response.contentType)})`
        : "";
      lines.push(`  ${source} → ${edge.request.method} ${compactUrl(edge.request.url)}${resp}`);
    }
  }

  return lines.join("\n") + "\n";
}

function compactUrl(raw: string): string {
  try {
    const u = new URL(raw);
    const path = u.pathname;
    if (!u.search) return path;
    // Show first 60 chars of query string, truncate with ...
    const query = u.search.length > 60 ? u.search.slice(0, 60) + "..." : u.search;
    return path + query;
  } catch {
    return raw.length > 100 ? raw.slice(0, 100) + "..." : raw;
  }
}

function shortContentType(ct: string): string {
  if (ct.includes("json")) return "json";
  if (ct.includes("html")) return "html";
  if (ct.includes("javascript")) return "js";
  if (ct.includes("css")) return "css";
  if (ct.includes("xml")) return "xml";
  if (ct.includes("text/plain")) return "text";
  if (ct.includes("image/")) return "image";
  return ct.split(";")[0].trim() || "unknown";
}

export function serializeJGF(
  graph: BehaviorGraph,
): Record<string, unknown> {
  const nodes: Record<string, unknown> = {};
  const edges: Array<Record<string, unknown>> = [];

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
        ...(node.events.length > 0 && { events: node.events }),
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

  // Add network trigger edges
  for (const edge of graph.networkEdges) {
    edges.push({
      source: edge.triggerNodeId || "__page__",
      target: `${edge.request.method}:${edge.request.url}`,
      relation: "triggers",
      metadata: {
        triggerEvent: edge.triggerEvent,
        request: edge.request,
        ...(edge.response && { response: edge.response }),
      },
    });
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
