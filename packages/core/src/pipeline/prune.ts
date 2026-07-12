/**
 * Node-budget pruning — bound the graph on content-dense pages.
 *
 * The behavior graph targets 50–300 nodes for app-shaped pages, but a content
 * page (a Wikipedia article keeps ~1,800 named links) blows past that: the AX
 * filter keeps every link, and bulk navigation links are low behavioral value —
 * an agent cares about what a page DOES, not its 1,500th "see also" link.
 *
 * When the graph exceeds the budget we drop the LOWEST-value leaves first (plain
 * content/nav links with no behavioral handler), deepest-first, never touching a
 * form control, a button, a container, or anything with an api_call/form_submit/
 * dom_mutation handler. The count dropped is recorded on metadata (no silent cap).
 */
import type { BehaviorGraph, BehaviorNode } from "../graph/model.js";
import { debugLog } from "../debug.js";

// 0 disables the cap. Default leaves generous headroom over the 300 target while
// bounding the worst case.
export const MAX_NODES = Number(process.env.VEIL_MAX_NODES ?? 800);

// Roles whose bulk instances are low behavioral value when they carry no
// real handler (pure navigation / static content).
const LOW_VALUE_ROLES = new Set([
  "link",
  "listitem",
  "row",
  "cell",
  "gridcell",
  "columnheader",
  "rowheader",
  "option",
  "menuitem",
  "treeitem",
  "text",
  "paragraph",
]);

const BEHAVIORAL = new Set(["api_call", "form_submit", "dom_mutation"]);

/** A node is prunable only if it's a low-value leaf with no behavioral handler.
 * Form controls, buttons, containers, and event-bearing nodes are never pruned. */
function isPrunable(node: BehaviorNode): boolean {
  if (node.children.length > 0) return false; // only leaves — keep tree structure
  if (!LOW_VALUE_ROLES.has(node.role)) return false;
  return !node.events.some((e) => BEHAVIORAL.has(e.category));
}

export function pruneToNodeBudget(graph: BehaviorGraph, max = MAX_NODES): void {
  if (max <= 0 || graph.nodes.size <= max) return;

  const parentOf = buildParentMap(graph);
  let removed = 0;

  // Iterate: a low-value link that WRAPS content (a link around a span/text) is
  // not a leaf on the first pass, but becomes one once its low-value children are
  // pruned. Repeat leaf-pruning until we hit the budget or run out of safely
  // removable nodes — this collapses whole bulk-link subtrees, not just leaves.
  while (graph.nodes.size > max) {
    const depth = computeDepths(graph);
    const candidates = [...graph.nodes.values()]
      .filter(isPrunable)
      .sort((a, b) => (depth.get(b.id) ?? 0) - (depth.get(a.id) ?? 0));
    if (candidates.length === 0) break; // only high-value nodes remain — stop

    const budget = graph.nodes.size - max;
    for (const node of candidates.slice(0, budget)) {
      graph.nodes.delete(node.id);
      const parentId = parentOf.get(node.id);
      if (parentId) {
        const parent = graph.nodes.get(parentId);
        if (parent) parent.children = parent.children.filter((c) => c !== node.id);
      } else {
        graph.roots = graph.roots.filter((r) => r !== node.id);
      }
      removed++;
    }
  }

  if (removed > 0) {
    graph.metadata.nodesTrimmed = (graph.metadata.nodesTrimmed ?? 0) + removed;
    debugLog(
      `prune: dropped ${removed} low-value node(s) to meet the ${max} budget ` +
        `(${graph.nodes.size} remain)`,
    );
  }
}

function buildParentMap(graph: BehaviorGraph): Map<string, string> {
  const parent = new Map<string, string>();
  for (const node of graph.nodes.values()) {
    for (const childId of node.children) parent.set(childId, node.id);
  }
  return parent;
}

function computeDepths(graph: BehaviorGraph): Map<string, number> {
  const depth = new Map<string, number>();
  const walk = (id: string, d: number) => {
    depth.set(id, d);
    const node = graph.nodes.get(id);
    if (node) for (const c of node.children) walk(c, d + 1);
  };
  for (const root of graph.roots) walk(root, 0);
  return depth;
}
