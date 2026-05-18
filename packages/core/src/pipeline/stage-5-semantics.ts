import type { BehaviorGraph, BehaviorNode, SemanticLabel } from "../graph/model.js";

/**
 * Stage 5: Infer semantic labels for nodes and component groups using heuristic rules.
 */
export async function inferSemantics(graph: BehaviorGraph): Promise<void> {
  applyNodeHeuristics(graph);
  applyGroupHeuristics(graph);
  propagateGroupLabels(graph);
}

/** Re-run heuristics. Used for incremental updates. */
export function reinferSemantics(graph: BehaviorGraph): void {
  for (const node of graph.nodes.values()) {
    if (node.semanticLabel?.source === "heuristic") {
      node.semanticLabel = undefined;
    }
  }
  for (const group of graph.componentGroups) {
    if (group.semanticLabel?.source === "heuristic") {
      group.semanticLabel = undefined;
    }
  }

  applyNodeHeuristics(graph);
  applyGroupHeuristics(graph);
  propagateGroupLabels(graph);
}

// --- Heuristic Rules ---

interface HeuristicRule {
  name: string;
  matchNode(node: BehaviorNode, graph: BehaviorGraph): SemanticLabel | null;
}

const RULES: HeuristicRule[] = [
  // Rule 1: Search input — highest confidence first
  {
    name: "search-input",
    matchNode(node) {
      if (node.role === "searchbox") {
        return { category: "search", action: "input", confidence: 0.95, source: "heuristic" };
      }
      if (node.role === "textbox" && /search/i.test(node.name)) {
        return { category: "search", action: "input", confidence: 0.80, source: "heuristic" };
      }
      return null;
    },
  },

  // Rule 2: Navigation landmark
  {
    name: "navigation-landmark",
    matchNode(node) {
      if (node.role !== "navigation") return null;
      const isSecondary = /secondary|footer|breadcrumb|sidebar/i.test(node.name);
      return {
        category: "navigation",
        action: isSecondary ? "secondary" : "primary",
        confidence: 0.90,
        source: "heuristic",
      };
    },
  },

  // Rule 3: Dynamic live region
  {
    name: "dynamic-live-region",
    matchNode(node) {
      const liveRoles = new Set(["alert", "status", "log"]);
      if (liveRoles.has(node.role)) {
        return { category: "dynamic", action: "live-region", confidence: 0.90, source: "heuristic" };
      }
      if (node.state["aria-live"] || node.state["live"]) {
        return { category: "dynamic", action: "live-region", confidence: 0.90, source: "heuristic" };
      }
      return null;
    },
  },

  // Rule 4: Commerce
  {
    name: "commerce",
    matchNode(node) {
      if (node.role !== "button" && node.role !== "link") return null;
      const name = node.name.toLowerCase();
      if (/add\s*to\s*cart|add\s*to\s*bag/i.test(name)) {
        return { category: "commerce", action: "add-to-cart", confidence: 0.90, source: "heuristic" };
      }
      if (/checkout|buy\s*now|purchase/i.test(name)) {
        return { category: "commerce", action: "checkout", confidence: 0.85, source: "heuristic" };
      }
      return null;
    },
  },

  // Rule 5: Auth form — check if form contains a password field
  {
    name: "auth-form",
    matchNode(node, graph) {
      if (node.role !== "form") return null;
      const descendants = collectDescendantNodes(graph, node.id);
      const hasPassword = descendants.some(
        (d) => d.role === "textbox" && /password/i.test(d.name),
      );
      if (!hasPassword) return null;

      const inputCount = descendants.filter(
        (d) => d.role === "textbox" || d.role === "combobox",
      ).length;
      const action = inputCount > 2 ? "signup" : "login";
      return { category: "auth", action, confidence: 0.85, source: "heuristic" };
    },
  },

  // Rule 6: Form submit
  {
    name: "form-submit",
    matchNode(node) {
      if (node.role !== "button") return null;
      const hasFormSubmit = node.events.some((e) => e.category === "form_submit");
      if (hasFormSubmit) {
        return { category: "form", action: "submit", confidence: 0.80, source: "heuristic" };
      }
      if (/submit|sign\s*in|log\s*in|register|sign\s*up/i.test(node.name)) {
        return { category: "form", action: "submit", confidence: 0.75, source: "heuristic" };
      }
      return null;
    },
  },

  // Rule 7: Content list
  {
    name: "content-list",
    matchNode(node, graph) {
      if (node.role !== "list") return null;
      const children = node.children
        .map((id) => graph.nodes.get(id))
        .filter(Boolean) as BehaviorNode[];
      const linkOrItemCount = children.filter(
        (c) => c.role === "link" || c.role === "listitem",
      ).length;
      if (linkOrItemCount >= 3) {
        return { category: "content", action: "list", confidence: 0.75, source: "heuristic" };
      }
      return null;
    },
  },

  // Rule 8: API trigger — catch-all for nodes with events that have network edges
  {
    name: "api-trigger",
    matchNode(node, graph) {
      if (node.events.length === 0) return null;
      const hasNetworkEdge = graph.networkEdges.some(
        (e) => e.triggerNodeId === node.id,
      );
      if (hasNetworkEdge) {
        return { category: "form", action: "api-trigger", confidence: 0.50, source: "heuristic" };
      }
      return null;
    },
  },
];

function applyNodeHeuristics(graph: BehaviorGraph): void {
  for (const [, node] of graph.nodes) {
    if (node.semanticLabel) continue;

    let bestLabel: SemanticLabel | null = null;

    for (const rule of RULES) {
      const label = rule.matchNode(node, graph);
      if (label && (!bestLabel || label.confidence > bestLabel.confidence)) {
        bestLabel = label;
      }
    }

    if (bestLabel) {
      node.semanticLabel = bestLabel;
    }
  }
}

function applyGroupHeuristics(graph: BehaviorGraph): void {
  for (const group of graph.componentGroups) {
    if (group.semanticLabel) continue;

    const name = group.componentName.toLowerCase();

    if (/login|signin|sign-in/i.test(name)) {
      group.semanticLabel = { category: "auth", action: "login", confidence: 0.85, source: "heuristic" };
    } else if (/signup|sign-up|register/i.test(name)) {
      group.semanticLabel = { category: "auth", action: "signup", confidence: 0.85, source: "heuristic" };
    } else if (/search/i.test(name)) {
      group.semanticLabel = { category: "search", action: "input", confidence: 0.80, source: "heuristic" };
    } else if (/nav|menu|header/i.test(name)) {
      group.semanticLabel = { category: "navigation", action: "primary", confidence: 0.75, source: "heuristic" };
    } else if (/cart|checkout/i.test(name)) {
      group.semanticLabel = { category: "commerce", action: "checkout", confidence: 0.75, source: "heuristic" };
    } else if (/form/i.test(name)) {
      group.semanticLabel = { category: "form", action: "submit", confidence: 0.70, source: "heuristic" };
    }
  }
}

function propagateGroupLabels(graph: BehaviorGraph): void {
  for (const group of graph.componentGroups) {
    if (!group.semanticLabel) continue;

    for (const nodeId of group.memberNodeIds) {
      const node = graph.nodes.get(nodeId);
      if (!node || node.semanticLabel) continue;

      node.semanticLabel = {
        ...group.semanticLabel,
        confidence: group.semanticLabel.confidence * 0.8,
      };
    }
  }
}

function collectDescendantNodes(
  graph: BehaviorGraph,
  nodeId: string,
): BehaviorNode[] {
  const result: BehaviorNode[] = [];
  const node = graph.nodes.get(nodeId);
  if (!node) return result;

  for (const childId of node.children) {
    const child = graph.nodes.get(childId);
    if (child) {
      result.push(child);
      result.push(...collectDescendantNodes(graph, childId));
    }
  }
  return result;
}
