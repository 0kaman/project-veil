import type { AXNode } from "../browser/page.js";
import type { CDPClient } from "../browser/cdp-client.js";
import type { BehaviorGraph, BehaviorNode, GraphDiff } from "../graph/model.js";

const INTERACTIVE_ROLES = new Set([
  "button",
  "link",
  "textbox",
  "checkbox",
  "radio",
  "combobox",
  "select",
  "listbox",
  "slider",
  "spinbutton",
  "switch",
  "tab",
  "menuitem",
  "menuitemcheckbox",
  "menuitemradio",
  "searchbox",
  "option",
  "treeitem",
]);

const CONTAINER_ROLES = new Set([
  "form",
  "navigation",
  "main",
  "dialog",
  "alertdialog",
  "banner",
  "complementary",
  "contentinfo",
  "region",
  "toolbar",
  "list",
  "menu",
  "menubar",
  "tablist",
  "tabpanel",
  "tree",
  "grid",
  "table",
  "group",
  "radiogroup",
  "article",
  "search",
  // Tabular / list body roles — without these, table and list CONTENT collapsed
  // to nothing (the container was kept but its rows/cells/items were dropped),
  // and stage-5's content-list rule counted listitem children that didn't survive.
  "row",
  "rowgroup",
  "gridcell",
  "cell",
  "columnheader",
  "rowheader",
  "listitem",
  // Live/measurement widgets that carry behavioral meaning.
  "alert",
  "status",
  "log",
  "progressbar",
  "meter",
]);

const HEADING_PATTERN = /^heading$/;

const SKIP_ROLES = new Set([
  "StaticText",
  "InlineTextBox",
  "LineBreak",
  "generic",
  "none",
  "presentation",
]);

const STATE_PROPERTIES = new Set([
  "disabled",
  "expanded",
  "checked",
  "selected",
  "focused",
  "required",
  "pressed",
  "readonly",
  "invalid",
  "modal",
  "multiselectable",
  "multiline",
  "haspopup",
  "autocomplete",
  "level",
  "orientation",
]);

export function shouldKeep(node: AXNode): boolean {
  if (node.ignored) return false;

  const role = node.role?.value ?? "";

  if (INTERACTIVE_ROLES.has(role)) return true;
  if (CONTAINER_ROLES.has(role)) return true;
  if (HEADING_PATTERN.test(role)) return true;

  // Keep images with names (meaningful images)
  if (role === "image" && node.name?.value) return true;

  // Skip known noise roles
  if (SKIP_ROLES.has(role)) return false;

  // Skip generic/unnamed nodes
  if (!node.name?.value) return false;

  // Keep anything else with a meaningful role and name
  return role !== "" && role !== "generic" && role !== "none";
}

export function extractState(
  node: AXNode,
): Record<string, string | boolean> {
  const state: Record<string, string | boolean> = {};
  if (!node.properties) return state;

  for (const prop of node.properties) {
    if (STATE_PROPERTIES.has(prop.name)) {
      const val = prop.value.value;
      if (val === "false" || val === false) continue;
      if (val === "true" || val === true) {
        state[prop.name] = true;
      } else if (val !== undefined && val !== null) {
        state[prop.name] = String(val);
      }
    }
  }

  return state;
}

function findKeptDescendants(
  nodeId: string,
  byId: Map<string, AXNode>,
  keptIds: Set<string>,
): string[] {
  const node = byId.get(nodeId);
  if (!node?.childIds) return [];

  const result: string[] = [];
  for (const childId of node.childIds) {
    if (keptIds.has(childId)) {
      result.push(childId);
    } else {
      result.push(...findKeptDescendants(childId, byId, keptIds));
    }
  }
  return result;
}

function hasKeptAncestor(
  nodeId: string,
  byId: Map<string, AXNode>,
  keptIds: Set<string>,
): boolean {
  const node = byId.get(nodeId);
  if (!node?.parentId) return false;
  if (keptIds.has(node.parentId)) return true;
  return hasKeptAncestor(node.parentId, byId, keptIds);
}

export function buildGraphFromAXTree(
  axNodes: AXNode[],
  url: string,
  title: string,
): BehaviorGraph {
  // Index nodes by ID
  const byId = new Map<string, AXNode>();
  for (const node of axNodes) {
    byId.set(node.nodeId, node);
  }

  // Determine which nodes to keep
  const keptIds = new Set<string>();
  for (const node of axNodes) {
    if (shouldKeep(node)) {
      keptIds.add(node.nodeId);
    }
  }

  // Build behavior nodes and resolve parent-child in kept set
  const behaviorNodes = new Map<string, BehaviorNode>();
  const roots: string[] = [];

  for (const nodeId of keptIds) {
    const node = byId.get(nodeId)!;
    const children = findKeptDescendants(nodeId, byId, keptIds);

    const bNode: BehaviorNode = {
      id: nodeId,
      role: node.role?.value ?? "unknown",
      name: node.name?.value ?? "",
      description: node.description?.value ?? "",
      state: extractState(node),
      value: node.value?.value ?? "",
      backendDOMNodeId: node.backendDOMNodeId ?? 0,
      children,
      events: [],
    };

    behaviorNodes.set(nodeId, bNode);

    if (!hasKeptAncestor(nodeId, byId, keptIds)) {
      roots.push(nodeId);
    }
  }

  const parsedUrl = new URL(url);

  return {
    metadata: {
      url,
      title,
      timestamp: Date.now(),
      route: parsedUrl.pathname + parsedUrl.search,
    },
    version: 1,
    nodes: behaviorNodes,
    roots,
    networkEdges: [],
    apiEndpoints: [],
    componentGroups: [],
  };
}

export function patchGraphFromDiff(
  graph: BehaviorGraph,
  axNodes: AXNode[],
  diff: GraphDiff,
  url: string,
  title: string,
): void {
  const byId = new Map<string, AXNode>();
  for (const node of axNodes) {
    byId.set(node.nodeId, node);
  }

  const keptIds = new Set<string>();
  for (const node of axNodes) {
    if (shouldKeep(node)) {
      keptIds.add(node.nodeId);
    }
  }

  // Remove nodes
  for (const nodeId of diff.removed) {
    graph.nodes.delete(nodeId);
    // Clean from parent children arrays
    for (const [, node] of graph.nodes) {
      const idx = node.children.indexOf(nodeId);
      if (idx !== -1) {
        node.children.splice(idx, 1);
      }
    }
  }

  // Filter networkEdges for removed nodes
  if (diff.removed.length > 0) {
    const removedSet = new Set(diff.removed);
    graph.networkEdges = graph.networkEdges.filter(
      (e) => !removedSet.has(e.triggerNodeId),
    );
  }

  // Add new nodes
  for (const nodeId of diff.added) {
    const axNode = byId.get(nodeId);
    if (!axNode) continue;

    const children = findKeptDescendants(nodeId, byId, keptIds);
    const bNode: BehaviorNode = {
      id: nodeId,
      role: axNode.role?.value ?? "unknown",
      name: axNode.name?.value ?? "",
      description: axNode.description?.value ?? "",
      state: extractState(axNode),
      value: axNode.value?.value ?? "",
      backendDOMNodeId: axNode.backendDOMNodeId ?? 0,
      children,
      events: [],
    };
    graph.nodes.set(nodeId, bNode);
  }

  // Modify existing nodes — update properties but preserve events
  for (const nodeId of diff.modified) {
    const existing = graph.nodes.get(nodeId);
    const axNode = byId.get(nodeId);
    if (!existing || !axNode) continue;

    const children = findKeptDescendants(nodeId, byId, keptIds);
    existing.role = axNode.role?.value ?? "unknown";
    existing.name = axNode.name?.value ?? "";
    existing.description = axNode.description?.value ?? "";
    existing.state = extractState(axNode);
    existing.value = axNode.value?.value ?? "";
    existing.backendDOMNodeId = axNode.backendDOMNodeId ?? 0;
    existing.children = children;
    // events[] preserved
  }

  // Recompute roots
  graph.roots = [];
  for (const nodeId of graph.nodes.keys()) {
    if (!hasKeptAncestor(nodeId, byId, keptIds)) {
      graph.roots.push(nodeId);
    }
  }

  // Update metadata
  const parsedUrl = new URL(url);
  graph.metadata = {
    url,
    title,
    timestamp: Date.now(),
    route: parsedUrl.pathname + parsedUrl.search,
  };

  // NOTE: the version counter is owned by the Veil instance (a single monotonic
  // source of truth). The caller bumps it after patching — bumping graph.version
  // here would diverge from the full-build path and let version go backwards.
}

interface StructuralInfo {
  tag: string;
  href: string | null;
  action: string | null;
  method: string | null;
}

/**
 * Structural behavior enrichment for server-rendered pages.
 *
 * Classic (non-SPA) sites encode behavior in HTML, not JS: `<a href="vote?id=1">`,
 * `<form action="/login" method="post">`. Stage 2 captures JS event listeners
 * and finds nothing on these — leaving every link/form behavior-less. Here we
 * lift the structural URL into a synthetic `click`/`submit` event with an
 * estimatedEffect, so the graph reflects what the element actually does.
 *
 * Only nodes that Stage 2 left event-less are touched, so SPA findings
 * (real JS handlers) are never overwritten. Targets `link` and `form` roles.
 */
export async function enrichStructuralEvents(
  graph: BehaviorGraph,
  cdp: CDPClient,
  nodeIds?: Iterable<string>,
): Promise<void> {
  const targets = nodeIds
    ? [...nodeIds].map((id) => graph.nodes.get(id)).filter((n): n is BehaviorNode => !!n)
    : [...graph.nodes.values()];

  for (const node of targets) {
    if (node.events.length > 0) continue; // Stage 2 already found JS handlers
    if (node.backendDOMNodeId === 0) continue;
    if (node.role !== "link" && node.role !== "form") continue;

    let info: StructuralInfo | null;
    try {
      info = await getStructuralInfo(cdp, node.backendDOMNodeId);
    } catch {
      continue; // node may have been removed; skip
    }
    if (!info) continue;

    if (node.role === "link" && info.href) {
      const href = info.href.trim();
      // Skip in-page anchors and JS links. A fragment link ("#section", a "back
      // to top" or accordion toggle) is NOT a navigation — resolveStructuralUrl
      // drops the hash and would emit a phantom "GET /current-path" edge.
      if (!href || href.startsWith("#") || href.startsWith("javascript:")) continue;
      node.events.push({
        eventType: "click",
        category: "navigation",
        estimatedEffect: `GET ${resolveStructuralUrl(href, graph.metadata.url)}`,
      });
    } else if (node.role === "form" && info.action) {
      const method = (info.method ?? "GET").toUpperCase();
      node.events.push({
        eventType: "submit",
        category: "form_submit",
        estimatedEffect: `${method} ${resolveStructuralUrl(info.action, graph.metadata.url)}`,
      });
    }
  }
}

async function getStructuralInfo(
  cdp: CDPClient,
  backendDOMNodeId: number,
): Promise<StructuralInfo | null> {
  const resolved = (await cdp.send("DOM.resolveNode", {
    backendNodeId: backendDOMNodeId,
  })) as { object: { objectId?: string } };

  const objectId = resolved.object?.objectId;
  if (!objectId) return null;

  try {
    const r = (await cdp.send("Runtime.callFunctionOn", {
      objectId,
      functionDeclaration: `function() {
        const tag = this.tagName ? this.tagName.toLowerCase() : '';
        const attr = (n) => (this.getAttribute ? this.getAttribute(n) : null);
        return { tag, href: attr('href'), action: attr('action'), method: attr('method') };
      }`,
      returnByValue: true,
    })) as { result: { value?: StructuralInfo } };
    return r.result?.value ?? null;
  } finally {
    await cdp.send("Runtime.releaseObject", { objectId }).catch(() => {});
  }
}

/** Resolve a possibly-relative URL against the page URL. Same-origin → path+search; cross-origin → absolute. */
export function resolveStructuralUrl(raw: string, pageUrl: string): string {
  try {
    const resolved = new URL(raw, pageUrl);
    const page = new URL(pageUrl);
    if (resolved.origin === page.origin) {
      return resolved.pathname + resolved.search;
    }
    return resolved.href;
  } catch {
    return raw;
  }
}
