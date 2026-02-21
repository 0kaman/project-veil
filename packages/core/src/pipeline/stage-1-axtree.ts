import type { AXNode } from "../browser/page.js";
import type { BehaviorGraph, BehaviorNode } from "../graph/model.js";

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

function shouldKeep(node: AXNode): boolean {
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

function extractState(
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

  // For each kept node, find its kept children (skipping intermediate non-kept nodes)
  function findKeptDescendants(nodeId: string): string[] {
    const node = byId.get(nodeId);
    if (!node?.childIds) return [];

    const result: string[] = [];
    for (const childId of node.childIds) {
      if (keptIds.has(childId)) {
        result.push(childId);
      } else {
        // Collapse: skip this node, promote its children
        result.push(...findKeptDescendants(childId));
      }
    }
    return result;
  }

  // Find kept parent for root detection
  function hasKeptAncestor(nodeId: string): boolean {
    const node = byId.get(nodeId);
    if (!node?.parentId) return false;
    if (keptIds.has(node.parentId)) return true;
    return hasKeptAncestor(node.parentId);
  }

  for (const nodeId of keptIds) {
    const node = byId.get(nodeId)!;
    const children = findKeptDescendants(nodeId);

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

    if (!hasKeptAncestor(nodeId)) {
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
    nodes: behaviorNodes,
    roots,
  };
}
