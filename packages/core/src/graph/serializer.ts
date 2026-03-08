import type { BehaviorGraph, SemanticLabel } from "./model.js";
import { buildDisplayIdRegistry } from "./display-ids.js";

export function serializeCompactText(graph: BehaviorGraph): string {
  const lines: string[] = [];
  const { toDisplay: displayIds } = buildDisplayIdRegistry(graph);

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
        ? ` (${compactEffect(event.estimatedEffect)})`
        : "";
      lines.push(
        `${indent}  on:${event.eventType} → ${event.category}${effect}`,
      );
    }

    if (node.semanticLabel) {
      lines.push(
        `${indent}  semantic: ${formatSemanticLabel(node.semanticLabel)}`,
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
      const url = edge.urlPattern ?? compactUrl(edge.request.url);
      const resp = edge.response
        ? ` → ${edge.response.status} (${shortContentType(edge.response.contentType)})`
        : "";
      lines.push(`  ${source} → ${edge.request.method} ${url}${resp}`);
    }
  }

  // APIS section
  if (graph.apiEndpoints && graph.apiEndpoints.length > 0) {
    lines.push("");
    lines.push("APIS");
    for (const ep of graph.apiEndpoints) {
      const status = ep.statusCodes.join(",");
      const ct = ep.contentType ?? "unknown";
      let shape = "";
      if (ep.responseShape) {
        const entries = Object.entries(ep.responseShape)
          .map(([k, v]) => `${k}: ${v}`)
          .join(", ");
        shape = ` { ${entries} }`;
      }
      lines.push(`  ${ep.method} ${ep.pattern} → ${status} ${ct}${shape}`);
    }
  }

  // COMPONENTS section
  if (graph.componentGroups && graph.componentGroups.length > 0) {
    lines.push("");
    lines.push("COMPONENTS");
    for (const group of graph.componentGroups) {
      const semantic = group.semanticLabel
        ? ` semantic:${group.semanticLabel.category}:${group.semanticLabel.action}`
        : "";
      lines.push(
        `  ${group.id} [${group.framework}] "${group.componentName}"${semantic}`,
      );
      const memberDisplayIds = group.memberNodeIds.map(
        (id) => displayIds.get(id) ?? id,
      );
      lines.push(`    members: ${memberDisplayIds.join(", ")}`);
    }
  }

  return lines.join("\n") + "\n";
}

function formatSemanticLabel(label: SemanticLabel): string {
  return `${label.category}:${label.action} (${label.confidence.toFixed(2)}, ${label.source})`;
}

/**
 * Strip query params from URLs in estimatedEffect strings.
 * "POST /ajax/bz?__a=1&__ccg=EXCELLENT&..." → "POST /ajax/bz"
 * "navigates to /dashboard" → "navigates to /dashboard" (unchanged)
 */
function compactEffect(effect: string): string {
  // Match "METHOD /path?query" pattern
  const match = effect.match(/^((?:GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\s+\S+?)(\?[^\s]*)(.*)$/i);
  if (match) {
    return match[1] + (match[3] || "");
  }
  return effect;
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
        ...(node.componentId && { componentId: node.componentId }),
        ...(node.semanticLabel && { semanticLabel: node.semanticLabel }),
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
        ...(edge.urlPattern && { urlPattern: edge.urlPattern }),
      },
    });
  }

  return {
    graph: {
      type: "behavior-graph",
      metadata: graph.metadata,
      version: graph.version,
      nodes,
      edges,
      ...(graph.apiEndpoints && graph.apiEndpoints.length > 0 && {
        apiEndpoints: graph.apiEndpoints,
      }),
      ...(graph.componentGroups && graph.componentGroups.length > 0 && {
        componentGroups: graph.componentGroups,
      }),
    },
  };
}
