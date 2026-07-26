/**
 * Stage 1 — the accessibility tree is the skeleton.
 *
 * `Accessibility.getFullAXTree` gives us roles, computed accessible names and
 * actionability states in ONE round trip: Chrome has already done the work of
 * deciding what a thing is and what it's called (the AccName algorithm). Walking
 * the DOM instead would mean reimplementing that badly.
 *
 * We keep only what an agent can act on — doers and navigational nodes — and
 * drop the containers, text and generic wrappers. Measured: wikipedia's 10,381
 * non-ignored AX nodes reduce to 1,031 interactive, of which 23 are doers.
 */
import type { CDPClient } from "../browser/cdp-client.js";
import { assignDisplayIds } from "../graph/ids.js";
import {
  DOER_ROLES,
  MODAL_ROLES,
  NAV_ROLES,
  type BehaviorNode,
  type NodeState,
} from "../graph/model.js";

interface RawAXValue {
  value?: unknown;
}
interface RawAXProperty {
  name: string;
  value?: RawAXValue;
}
interface RawAXNode {
  nodeId: string;
  ignored?: boolean;
  role?: RawAXValue;
  name?: RawAXValue;
  value?: RawAXValue;
  properties?: RawAXProperty[];
  backendDOMNodeId?: number;
  childIds?: string[];
  ignoredReasons?: RawAXProperty[];
}

const STATE_KEYS = new Set([
  "disabled",
  "required",
  "checked",
  "expanded",
  "invalid",
  "focused",
  "readonly",
]);

function str(v: RawAXValue | undefined): string {
  return typeof v?.value === "string" ? v.value : "";
}

/** Pull the actionability state we care about, dropping AX's many others. */
function stateOf(props: RawAXProperty[] | undefined): NodeState {
  const out: NodeState = {};
  for (const p of props ?? []) {
    if (!STATE_KEYS.has(p.name)) continue;
    const v = p.value?.value;
    // AX reports invalid as the string "false" rather than a boolean. Normalise,
    // and drop the negative cases entirely so the lean view stays lean.
    if (v === false || v === "false" || v === undefined) continue;
    (out as Record<string, unknown>)[p.name] = v === "true" ? true : v;
  }
  return out;
}

export interface Stage1Result {
  nodes: BehaviorNode[];
  /** Non-ignored AX nodes seen — the denominator the receipt reports. */
  axNodeCount: number;
  /** Accessible name of an open dialog, if one is holding the page. */
  dialog?: string;
}

/** Ids in a node's AX subtree, so "inside the dialog" is a fact, not a guess. */
function subtreeIds(root: RawAXNode, byId: Map<string, RawAXNode>): Set<string> {
  const out = new Set<string>();
  const stack = [...(root.childIds ?? [])];
  while (stack.length) {
    const id = stack.pop()!;
    if (out.has(id)) continue;
    out.add(id);
    const n = byId.get(id);
    if (n?.childIds) stack.push(...n.childIds);
  }
  return out;
}

/** Chrome's reasons for hiding a subtree behind a modal. */
const HIDDEN_BY_MODAL = /^(ariaHiddenSubtree|ariaHiddenElement|inertSubtree|inertElement)$/;

/**
 * Is a dialog actually HOLDING the page, or merely present?
 *
 * Presence alone is not enough — a page can carry a `role="dialog"` promo while
 * everything else stays usable, and calling that a blocking modal would be its
 * own false receipt. Two signals, because one alone misses a real case:
 *
 *   1. nothing interactive outside the dialog. Catches the clean `inert` modal.
 *   2. most of the tree hidden by aria-hidden/inert. Catches Google Flights,
 *      where the autocomplete listbox is portalled to <body> and so sits
 *      OUTSIDE the dialog while the page behind it is gone.
 *
 * Measured separation is wide, not a tuned threshold: Google with its dialog
 * open hides 508 of 561 nodes (90%); a non-blocking promo dialog hides 0.
 */
function findBlockingDialog(
  all: RawAXNode[],
  interactive: RawAXNode[],
  everyNode: RawAXNode[],
): string | undefined {
  const dialogs = all.filter((n) => MODAL_ROLES.has(str(n.role)));
  if (dialogs.length === 0) return undefined;

  let hidden = 0;
  for (const n of everyNode) {
    if (n.ignoredReasons?.some((r) => HIDDEN_BY_MODAL.test(r.name))) hidden++;
  }
  const mostlyHidden = everyNode.length > 0 && hidden / everyNode.length >= 0.5;

  const byId = new Map(all.map((n) => [n.nodeId, n]));
  for (const d of dialogs) {
    const inside = subtreeIds(d, byId);
    const outside = interactive.filter((n) => !inside.has(n.nodeId) && n.nodeId !== d.nodeId);
    if (outside.length === 0 || mostlyHidden) {
      return str(d.name).replace(/\s+/g, " ").trim() || "(unnamed)";
    }
  }
  return undefined;
}

export async function buildFromAXTree(client: CDPClient): Promise<Stage1Result> {
  const res = (await client.send("Accessibility.getFullAXTree")) as { nodes?: RawAXNode[] };
  const all = (res.nodes ?? []).filter((n) => !n.ignored);

  // Interactive only, in document order (getFullAXTree returns pre-order).
  const interactive = all.filter((n) => {
    const role = str(n.role);
    return DOER_ROLES.has(role) || NAV_ROLES.has(role);
  });

  const shaped = interactive.map((n) => ({
    role: str(n.role),
    name: str(n.name).replace(/\s+/g, " ").trim(),
    raw: n,
  }));

  const ids = assignDisplayIds(shaped);

  const nodes: BehaviorNode[] = shaped.map((s, i) => {
    const value = str(s.raw.value);
    return {
      id: ids[i],
      axId: s.raw.nodeId,
      backendNodeId: s.raw.backendDOMNodeId,
      role: s.role,
      name: s.name,
      ...(value && { value }),
      state: stateOf(s.raw.properties),
      events: [],
    };
  });

  // A dialog only counts as HOLDING the page when nothing outside it is
  // actionable — that is the condition an agent cares about, and it is what
  // makes the vanished nodes explicable. Mere presence is not enough: a page
  // can carry a `role="dialog"` promo while the rest stays perfectly usable,
  // and announcing that as a blocking modal would be its own false receipt.
  const dialog = findBlockingDialog(all, interactive, res.nodes ?? []);

  return { nodes, axNodeCount: all.length, ...(dialog !== undefined && { dialog }) };
}
