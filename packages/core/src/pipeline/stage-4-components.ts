import type { CDPClient } from "../browser/cdp-client.js";
import type { BehaviorGraph, ComponentGroup } from "../graph/model.js";
import { debugLog } from "../debug.js";

interface FrameworkInfo {
  react: boolean;
}

interface ReactComponentInfo {
  name: string;
  props: Record<string, unknown>;
}

// React internals to skip when walking Fiber tree
const REACT_INTERNALS = new Set([
  "Fragment",
  "Suspense",
  "StrictMode",
  "Profiler",
  "ForwardRef",
  "ContextConsumer",
  "ContextProvider",
  "Provider",
  "Consumer",
]);

// Container roles that group their descendants in vanilla heuristic
const CONTAINER_GROUPING_ROLES = new Set([
  "form",
  "navigation",
  "dialog",
  "alertdialog",
  "search",
  "toolbar",
  "menu",
  "menubar",
  "tablist",
  "tree",
  "grid",
]);

/**
 * Stage 4: Group related behavior nodes into logical components.
 * Detects frameworks (React) and applies grouping heuristics.
 */
export async function groupComponents(
  graph: BehaviorGraph,
  cdp: CDPClient,
): Promise<void> {
  // Clear any previous grouping
  graph.componentGroups = [];
  for (const node of graph.nodes.values()) {
    node.componentId = undefined;
  }

  const frameworks = await detectFrameworks(cdp);

  if (frameworks.react) {
    await buildReactGroups(graph, cdp);
  }

  // Vanilla heuristics for ungrouped nodes
  buildVanillaGroups(graph);
}

/**
 * Incremental re-grouping — clears and re-runs fully.
 * Component grouping is fast (~50-200ms) so full re-run is acceptable.
 */
export async function regroupComponents(
  graph: BehaviorGraph,
  cdp: CDPClient,
  _changedNodeIds: Set<string>,
): Promise<void> {
  await groupComponents(graph, cdp);
}

/**
 * Detect which frameworks are present on the page.
 */
async function detectFrameworks(cdp: CDPClient): Promise<FrameworkInfo> {
  try {
    const result = (await cdp.send("Runtime.evaluate", {
      expression: `(() => {
        // Check for React Fiber on root or first 50 elements
        const root = document.getElementById('root') || document.getElementById('app') || document.getElementById('__next');
        const elements = [root, ...Array.from(document.querySelectorAll('*')).slice(0, 50)].filter(Boolean);
        const hasReact = elements.some(el => Object.keys(el).some(k => k.startsWith('__reactFiber$') || k.startsWith('__reactInternalInstance$')));
        return { react: hasReact };
      })()`,
      returnByValue: true,
    })) as { result: { value?: FrameworkInfo } };
    return result.result?.value ?? { react: false };
  } catch {
    return { react: false };
  }
}

/**
 * Group nodes by their nearest React component ancestor via Fiber tree traversal.
 */
async function buildReactGroups(
  graph: BehaviorGraph,
  cdp: CDPClient,
): Promise<void> {
  // Collect component info for each node in batch via page evaluation
  const nodeEntries = Array.from(graph.nodes.values())
    .filter((n) => n.backendDOMNodeId !== 0);

  // Process nodes in parallel batches of 20
  const BATCH_SIZE = 20;
  const componentMap = new Map<string, ReactComponentInfo>(); // nodeId → component info

  for (let i = 0; i < nodeEntries.length; i += BATCH_SIZE) {
    const batch = nodeEntries.slice(i, i + BATCH_SIZE);
    const results = await Promise.all(
      batch.map((node) => getReactComponentForNode(cdp, node.backendDOMNodeId)),
    );

    for (let j = 0; j < batch.length; j++) {
      if (results[j]) {
        componentMap.set(batch[j].id, results[j]!);
      }
    }
  }

  // Group nodes by component name
  const groupsByName = new Map<string, { info: ReactComponentInfo; nodeIds: string[] }>();

  for (const [nodeId, info] of componentMap) {
    const existing = groupsByName.get(info.name);
    if (existing) {
      existing.nodeIds.push(nodeId);
    } else {
      groupsByName.set(info.name, { info, nodeIds: [nodeId] });
    }
  }

  // Create ComponentGroup for each React component
  const usedGroupIds = new Set<string>();
  for (const [name, { info, nodeIds }] of groupsByName) {
    // Production React bundles minify component names to "T", "N", "B", "R2"
    // etc. — useless to an AI consumer (a 71-member group called "T"). When
    // the name looks minified, synthesize a content-based name from the
    // group's dominant role + size instead.
    const componentName = isMinifiedName(name)
      ? synthesizeComponentName(nodeIds, graph)
      : name;

    let groupId = `cg-react-${componentName.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`;
    if (usedGroupIds.has(groupId)) {
      let i = 2;
      while (usedGroupIds.has(`${groupId}-${i}`)) i++;
      groupId = `${groupId}-${i}`;
    }
    usedGroupIds.add(groupId);

    const group: ComponentGroup = {
      id: groupId,
      framework: "react",
      componentName,
      ...(Object.keys(info.props).length > 0 && { props: info.props }),
      memberNodeIds: nodeIds,
    };
    graph.componentGroups.push(group);

    // Set back-reference on nodes
    for (const nodeId of nodeIds) {
      const node = graph.nodes.get(nodeId);
      if (node) node.componentId = groupId;
    }
  }
}

/**
 * Detect a minified React component name. Production bundlers rename
 * components to short uppercase tokens: "T", "N", "B", "R2", "Av".
 */
export function isMinifiedName(name: string): boolean {
  if (name.length <= 2) return true;
  // Single capital + digits (e.g. "T3"), or all-caps short tokens
  if (/^[A-Z][0-9]*$/.test(name)) return true;
  return false;
}

/**
 * Build a content-based name from a group's members: dominant role + size.
 * "buttons-71", "links-16". Deterministic (role tiebreak by name).
 */
export function synthesizeComponentName(
  nodeIds: string[],
  graph: BehaviorGraph,
): string {
  const roleCounts = new Map<string, number>();
  for (const id of nodeIds) {
    const node = graph.nodes.get(id);
    if (!node) continue;
    roleCounts.set(node.role, (roleCounts.get(node.role) ?? 0) + 1);
  }

  let dominant = "node";
  let max = 0;
  for (const [role, count] of [...roleCounts].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    if (count > max) {
      max = count;
      dominant = role;
    }
  }

  return `${dominant}s-${nodeIds.length}`;
}

/**
 * Walk Fiber tree up from a DOM node to find the nearest React component.
 */
async function getReactComponentForNode(
  cdp: CDPClient,
  backendDOMNodeId: number,
): Promise<ReactComponentInfo | null> {
  try {
    const resolveResult = (await cdp.send("DOM.resolveNode", {
      backendNodeId: backendDOMNodeId,
    })) as { object: { objectId?: string } };

    const objectId = resolveResult.object?.objectId;
    if (!objectId) return null;

    const result = (await cdp.send("Runtime.callFunctionOn", {
      objectId,
      functionDeclaration: `function() {
        const el = this;
        const fiberKey = Object.keys(el).find(k => k.startsWith('__reactFiber$') || k.startsWith('__reactInternalInstance$'));
        if (!fiberKey) return null;

        const INTERNALS = ${JSON.stringify([...REACT_INTERNALS])};
        let fiber = el[fiberKey];

        for (let i = 0; i < 30 && fiber; i++) {
          // React function/class components have a type that is a function with a capitalized name
          const type = fiber.type;
          if (type) {
            let name = null;
            if (typeof type === 'function') {
              name = type.displayName || type.name;
            } else if (typeof type === 'object' && type.$$typeof) {
              // ForwardRef, memo wrappers
              const inner = type.render || type.type;
              if (typeof inner === 'function') {
                name = inner.displayName || inner.name;
              }
            }

            if (name && name[0] === name[0].toUpperCase() && !INTERNALS.includes(name)) {
              // Extract serializable props (primitives only, max 10)
              const props = {};
              let count = 0;
              const memoized = fiber.memoizedProps || {};
              for (const [k, v] of Object.entries(memoized)) {
                if (count >= 10) break;
                if (k === 'children') continue;
                const t = typeof v;
                if (t === 'string' || t === 'number' || t === 'boolean') {
                  props[k] = v;
                  count++;
                }
              }
              return { name, props };
            }
          }
          fiber = fiber.return;
        }
        return null;
      }`,
      returnByValue: true,
    })) as { result: { value?: ReactComponentInfo | null } };

    // Release object
    await cdp.send("Runtime.releaseObject", { objectId }).catch(() => {});

    return result.result?.value ?? null;
  } catch (err) {
    // A CDP hiccup here silently declasses a React page to vanilla grouping —
    // surface it under VEIL_DEBUG rather than swallowing blind.
    debugLog("stage-4: React component resolution failed", err);
    return null;
  }
}

/**
 * Vanilla heuristic grouping for nodes not already assigned by React grouping.
 *
 * Strategy 1: Container-based — form, navigation, dialog, etc. group their descendants.
 * Strategy 2: Shared handler source — nodes with identical event source are grouped.
 */
function buildVanillaGroups(graph: BehaviorGraph): void {
  // Strategy 1: Container-based grouping
  containerBasedGrouping(graph);

  // Strategy 2: Shared handler source grouping
  sharedHandlerGrouping(graph);
}

function containerBasedGrouping(graph: BehaviorGraph): void {
  // Build a stable ordering of container candidates:
  //   - by tree depth DESC (innermost first — inner forms claim their descendants
  //     before an outer <main> sweeps them up)
  //   - then by node id ASC (tiebreak — deterministic across runs)
  // Without this, iteration order of `graph.nodes` (Map insertion order) determines
  // grouping, and identical input can produce different output across runs.
  const depths = computeDepths(graph);
  const candidates: Array<{ id: string; depth: number }> = [];
  for (const [id, node] of graph.nodes) {
    if (!CONTAINER_GROUPING_ROLES.has(node.role)) continue;
    candidates.push({ id, depth: depths.get(id) ?? 0 });
  }
  candidates.sort((a, b) => {
    if (a.depth !== b.depth) return b.depth - a.depth;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });

  for (const { id } of candidates) {
    const node = graph.nodes.get(id);
    if (!node) continue;
    if (node.componentId) continue;

    const memberIds: string[] = [];
    collectUngroupedDescendants(graph, node.id, memberIds);
    if (memberIds.length === 0) continue;

    const namePart = node.name
      ? node.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 20)
      : String(graph.componentGroups.length + 1);

    const groupId = `cg-vanilla-${node.role}-${namePart}`;
    const allMembers = [node.id, ...memberIds];

    const group: ComponentGroup = {
      id: groupId,
      framework: "vanilla",
      componentName: `${node.role}-${namePart}`,
      memberNodeIds: allMembers,
    };
    graph.componentGroups.push(group);

    for (const memberId of allMembers) {
      const n = graph.nodes.get(memberId);
      if (n && !n.componentId) n.componentId = groupId;
    }
  }
}

/** Compute depth of every node from the graph roots. Disconnected nodes get 0. */
function computeDepths(graph: BehaviorGraph): Map<string, number> {
  const depths = new Map<string, number>();
  const visit = (nodeId: string, depth: number): void => {
    if (depths.has(nodeId)) return; // already visited via a shorter path
    depths.set(nodeId, depth);
    const node = graph.nodes.get(nodeId);
    if (!node) return;
    for (const childId of node.children) {
      visit(childId, depth + 1);
    }
  };
  for (const rootId of graph.roots) visit(rootId, 0);
  return depths;
}

function collectUngroupedDescendants(
  graph: BehaviorGraph,
  nodeId: string,
  result: string[],
): void {
  const node = graph.nodes.get(nodeId);
  if (!node) return;

  for (const childId of node.children) {
    const child = graph.nodes.get(childId);
    if (!child) continue;
    if (!child.componentId) {
      result.push(childId);
    }
    collectUngroupedDescendants(graph, childId, result);
  }
}

function sharedHandlerGrouping(graph: BehaviorGraph): void {
  // Build index: "scriptUrl:lineNumber" → nodeIds
  const sourceIndex = new Map<string, string[]>();

  for (const [nodeId, node] of graph.nodes) {
    if (node.componentId) continue; // Already assigned

    for (const event of node.events) {
      if (!event.source) continue;
      const key = `${event.source.scriptUrl}:${event.source.lineNumber}`;
      const existing = sourceIndex.get(key);
      if (existing) {
        existing.push(nodeId);
      } else {
        sourceIndex.set(key, [nodeId]);
      }
    }
  }

  // Create groups for sources with 2+ nodes
  let groupCounter = 0;
  for (const [, nodeIds] of sourceIndex) {
    // Deduplicate nodeIds (a node can appear multiple times if it has multiple events)
    const uniqueIds = [...new Set(nodeIds)];
    if (uniqueIds.length < 2) continue;

    // Skip if all nodes are already grouped
    const ungrouped = uniqueIds.filter((id) => !graph.nodes.get(id)?.componentId);
    if (ungrouped.length < 2) continue;

    groupCounter++;
    const groupId = `cg-vanilla-shared-${groupCounter}`;

    const group: ComponentGroup = {
      id: groupId,
      framework: "vanilla",
      componentName: `shared-handler-${groupCounter}`,
      memberNodeIds: ungrouped,
    };
    graph.componentGroups.push(group);

    for (const id of ungrouped) {
      const n = graph.nodes.get(id);
      if (n) n.componentId = groupId;
    }
  }
}
