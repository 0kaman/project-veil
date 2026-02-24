import type { BehaviorGraph, BehaviorNode, SemanticLabel, VeilConfig } from "../graph/model.js";
import { serializeCompactText } from "../graph/serializer.js";
import { buildDisplayIdRegistry } from "../graph/display-ids.js";

/**
 * Stage 5: Infer semantic labels for nodes and component groups.
 * Uses heuristic rules + optional LLM enrichment via Anthropic API.
 */
export async function inferSemantics(
  graph: BehaviorGraph,
  config?: VeilConfig,
): Promise<void> {
  // 1. Apply heuristics to individual nodes
  applyNodeHeuristics(graph);

  // 2. Apply heuristics to component groups
  applyGroupHeuristics(graph);

  // 3. Propagate group labels to unlabeled member nodes (at 0.8x confidence)
  propagateGroupLabels(graph);

  // 4. Optional LLM enrichment
  if (config?.llm?.enabled && config.llm.apiKey) {
    await enrichWithLLM(graph, config);
  }
}

/**
 * Re-run heuristics only (fast, <1ms). Used for incremental updates.
 * LLM labels from initial getGraph() are preserved.
 */
export function reinferSemantics(graph: BehaviorGraph): void {
  // Preserve LLM labels
  const llmLabels = new Map<string, SemanticLabel>();
  for (const [id, node] of graph.nodes) {
    if (node.semanticLabel?.source === "llm") {
      llmLabels.set(id, node.semanticLabel);
    }
  }

  const groupLlmLabels = new Map<string, SemanticLabel>();
  for (const group of graph.componentGroups) {
    if (group.semanticLabel?.source === "llm") {
      groupLlmLabels.set(group.id, group.semanticLabel);
    }
  }

  // Clear heuristic labels
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

  // Re-apply heuristics
  applyNodeHeuristics(graph);
  applyGroupHeuristics(graph);
  propagateGroupLabels(graph);

  // Restore LLM labels (they override heuristic if present)
  for (const [id, label] of llmLabels) {
    const node = graph.nodes.get(id);
    if (node) node.semanticLabel = label;
  }
  for (const [groupId, label] of groupLlmLabels) {
    const group = graph.componentGroups.find((g) => g.id === groupId);
    if (group) group.semanticLabel = label;
  }
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
      // Primary if it has many links or is the first/main nav
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

      // Count text input fields to distinguish login vs signup
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
      // Check name patterns
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
    if (node.semanticLabel) continue; // Already labeled (e.g. by LLM)

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

    // Check component name patterns
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
      if (!node || node.semanticLabel) continue; // Don't override existing labels

      node.semanticLabel = {
        ...group.semanticLabel,
        confidence: group.semanticLabel.confidence * 0.8,
      };
    }
  }
}

// --- LLM Enrichment ---

interface LLMNodeLabel {
  nodeId: string;
  category: string;
  action: string;
  confidence: number;
}

interface LLMResponse {
  labels: LLMNodeLabel[];
}

async function enrichWithLLM(
  graph: BehaviorGraph,
  config: VeilConfig,
): Promise<void> {
  const llmConfig = config.llm!;
  const threshold = llmConfig.confidenceThreshold ?? 0.5;

  // Find nodes/groups below confidence threshold
  const lowConfidenceNodes: string[] = [];
  for (const [id, node] of graph.nodes) {
    if (!node.semanticLabel || node.semanticLabel.confidence < threshold) {
      lowConfidenceNodes.push(id);
    }
  }

  if (lowConfidenceNodes.length === 0) return;

  try {
    // Build context: compact text of the graph
    const compactText = serializeCompactText(graph);
    const { toDisplay } = buildDisplayIdRegistry(graph);

    // Build display ID → internal ID map for response parsing
    const displayToInternal = new Map<string, string>();
    for (const [internalId, displayId] of toDisplay) {
      displayToInternal.set(displayId, internalId);
    }

    const baseUrl = llmConfig.baseUrl ?? "https://api.anthropic.com";
    const model = llmConfig.model ?? "claude-sonnet-4-20250514";
    const maxTokens = llmConfig.maxTokens ?? 4096;

    const response = await fetch(`${baseUrl}/v1/messages`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": llmConfig.apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model,
        max_tokens: maxTokens,
        messages: [
          {
            role: "user",
            content: `Analyze this behavior graph and label each node with a semantic purpose.

${compactText}

For each node that lacks a clear label or has low confidence, provide a semantic label with:
- category: one of auth, search, navigation, content, commerce, form, dynamic, media, social
- action: specific action like login, signup, search, primary, add-to-cart, submit, etc.
- confidence: 0-1 how confident you are

Respond with ONLY valid JSON in this format:
{"labels":[{"nodeId":"display-id-here","category":"...","action":"...","confidence":0.9}]}

Focus on nodes that seem important for automation/interaction. Skip purely structural nodes.`,
          },
        ],
      }),
    });

    if (!response.ok) return; // Silently fail

    const data = (await response.json()) as {
      content: Array<{ type: string; text?: string }>;
    };

    const textBlock = data.content?.find((c) => c.type === "text");
    if (!textBlock?.text) return;

    // Parse JSON from response (handle markdown code blocks)
    const jsonText = textBlock.text
      .replace(/^```json?\s*/m, "")
      .replace(/\s*```$/m, "")
      .trim();

    const parsed = JSON.parse(jsonText) as LLMResponse;
    if (!Array.isArray(parsed.labels)) return;

    // Apply LLM labels
    for (const label of parsed.labels) {
      // Map display ID to internal ID
      const internalId = displayToInternal.get(label.nodeId) ?? label.nodeId;
      const node = graph.nodes.get(internalId);
      if (!node) continue;

      // LLM labels override heuristic labels below threshold
      if (!node.semanticLabel || node.semanticLabel.confidence < threshold) {
        node.semanticLabel = {
          category: label.category,
          action: label.action,
          confidence: label.confidence,
          source: "llm",
        };
      }
    }
  } catch {
    // Silently fail — heuristic labels remain
  }
}

// --- Helpers ---

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
