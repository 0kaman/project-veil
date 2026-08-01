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
import {
  frameElementSrcs,
  isFrameset,
  listFrames,
  unreachableOwners,
  type FrameInfo,
} from "../browser/frames.js";
import { assignDisplayIds } from "../graph/ids.js";
import {
  DOER_ROLES,
  MODAL_ROLES,
  NAV_ROLES,
  type BehaviorNode,
  type FrameFacts,
  type NodeState,
} from "../graph/model.js";
import { debugLog } from "../debug.js";

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

/** One document's AX tree, plus where it hangs off its parent. */
export interface FrameAXTree {
  frameId: string;
  url: string;
  depth: number;
  parentFrameId?: string;
  /** backendNodeId of the `<iframe>`/`<frame>` element in the PARENT document. */
  ownerBackendNodeId?: number;
  /** Every non-ignored AX node of THIS document, in document order. */
  all: RawAXNode[];
}

export interface ShapedNode {
  role: string;
  name: string;
  raw: RawAXNode;
  /** Set when this node lives in a CHILD document. */
  frame?: { url: string; depth: number };
}

function isInteractive(role: string): boolean {
  return DOER_ROLES.has(role) || NAV_ROLES.has(role);
}

/**
 * Splice each child document's interactive nodes into its parent at the position
 * of the frame ELEMENT that owns it — so the merged list is in real document
 * order, which is what makes display ids stable and the lean view readable.
 *
 * PURE, deliberately: this is the part a Layer-1 test can pin. The per-frame
 * trees are kept SEPARATE rather than flat-merged before this point, because
 * `findBlockingDialog` builds `new Map(all.map(...))` and walks `childIds`
 * through it — a flat merge could walk a subtree across a frame boundary, and
 * the `mostlyHidden` 0.5 ratio would be computed over two different documents.
 * Measured 0 `nodeId` and 0 `backendDOMNodeId` collisions across three frames on
 * Chrome 150, but the design does not RELY on that; per-frame maps make the
 * collision question moot.
 *
 * A frame whose owner never appears in the parent's AX tree — a `display:none`
 * iframe has no AX node at all (measured: 4 iframes, 3 frame-ish AX nodes) — is
 * appended after the parent's nodes rather than dropped.
 */
export function mergeFrameTrees(trees: FrameAXTree[]): ShapedNode[] {
  const byParent = new Map<string, FrameAXTree[]>();
  for (const t of trees) {
    if (t.parentFrameId === undefined) continue;
    const list = byParent.get(t.parentFrameId);
    if (list) list.push(t);
    else byParent.set(t.parentFrameId, [t]);
  }

  const seen = new Set<string>();
  const shape = (n: RawAXNode, t: FrameAXTree): ShapedNode => ({
    role: str(n.role),
    name: str(n.name).replace(/\s+/g, " ").trim(),
    raw: n,
    ...(t.depth > 0 && { frame: { url: t.url, depth: t.depth } }),
  });

  const emit = (t: FrameAXTree): ShapedNode[] => {
    if (seen.has(t.frameId)) return []; // a cycle cannot happen, but never hang
    seen.add(t.frameId);

    const pending = new Map<number, FrameAXTree>();
    const orphans: FrameAXTree[] = [];
    for (const c of byParent.get(t.frameId) ?? []) {
      if (c.ownerBackendNodeId === undefined) orphans.push(c);
      else pending.set(c.ownerBackendNodeId, c);
    }

    const out: ShapedNode[] = [];
    for (const n of t.all) {
      if (isInteractive(str(n.role))) out.push(shape(n, t));
      const owned = n.backendDOMNodeId !== undefined ? pending.get(n.backendDOMNodeId) : undefined;
      if (owned) {
        pending.delete(n.backendDOMNodeId!);
        out.push(...emit(owned));
      }
    }
    // Owners we never saw: append rather than lose. Reaching here means the
    // frame exists and its element is invisible to AX — hidden, usually.
    for (const c of [...pending.values(), ...orphans]) out.push(...emit(c));
    return out;
  };

  const root = trees.find((t) => t.depth === 0);
  return root ? emit(root) : [];
}

export interface Stage1Result {
  nodes: BehaviorNode[];
  /** Non-ignored AX nodes seen — the denominator the receipt reports. */
  axNodeCount: number;
  /** Accessible name of an open dialog, if one is holding the page. */
  dialog?: string;
  /** Child documents, when this page has any. */
  frames?: FrameFacts;
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

/**
 * What child documents exist, and how many of them this graph actually covers.
 *
 * `undefined` when the page has none — the common case, and the one that must
 * stay free of noise. Every field is measured, not inferred: the readable set is
 * `Page.getFrameTree`, the unreachable set is the frame-ish AX nodes whose
 * element owns no tree frame, and `frameset` is `document.body.tagName`.
 */
async function collectFrameFacts(
  client: CDPClient,
  frames: FrameInfo[],
  axNodes: RawAXNode[],
  perceived: number,
): Promise<FrameFacts | undefined> {
  const children = frames.filter((f) => f.depth > 0);
  const owners = new Set<number>();
  for (const f of frames) if (f.ownerBackendNodeId !== undefined) owners.add(f.ownerBackendNodeId);

  const orphans = unreachableOwners(axNodes, owners);
  if (children.length === 0 && orphans.length === 0) return undefined;

  const unreachable = orphans.length > 0 ? await frameElementSrcs(client, orphans) : [];
  return {
    frameset: await isFrameset(client),
    // The contract: total === readable.length + unreachable.length.
    total: children.length + unreachable.length,
    readable: children.map((f) => ({ name: f.name, url: f.url, depth: f.depth })),
    unreachable,
    perceived,
  };
}

/**
 * How many child documents we will walk in one build.
 *
 * `buildGraph` runs on EVERY act against a measured 7–140ms budget. A no-frames
 * page pays one extra CDP call; a news site with 30 ad iframes would pay 60+.
 * The cap keeps that bounded — and when it fires, `frames.perceived` is smaller
 * than `frames.readable.length`, which makes the lean view NAME the frames it
 * did not enter rather than quietly report fewer.
 */
const MAX_PERCEIVED_FRAMES = 12;

export async function buildFromAXTree(client: CDPClient): Promise<Stage1Result> {
  // The root tree is fetched with NO frameId, exactly as before, so a page with
  // no frames takes a byte-identical path.
  const res = (await client.send("Accessibility.getFullAXTree")) as { nodes?: RawAXNode[] };
  const all = (res.nodes ?? []).filter((n) => !n.ignored);

  // What documents does this page actually have? Cheap (measured 0.65ms) and
  // unconditional, because "this page has content I cannot see" is exactly the
  // fact the receipt was missing.
  let frames: FrameInfo[] = [];
  try {
    frames = await listFrames(client);
  } catch (err) {
    debugLog("stage-1: listFrames failed", err);
  }

  const root = frames.find((f) => f.depth === 0);
  const trees: FrameAXTree[] = [
    {
      frameId: root?.frameId ?? "__root__",
      url: root?.url ?? "",
      depth: 0,
      all,
    },
  ];

  // One getFullAXTree per CHILD document. This is the fix for the defect: the
  // no-argument call walks the top document only, so a page whose content is an
  // iframe perceived as "nothing on this page is actionable" while Chrome held
  // the answer one frameId away (measured: 10 root nodes, 12 more in the child).
  let capped = 0;
  for (const f of frames) {
    if (f.depth === 0) continue;
    if (trees.length > MAX_PERCEIVED_FRAMES) {
      capped++;
      continue;
    }
    try {
      const r = (await client.send("Accessibility.getFullAXTree", { frameId: f.frameId })) as {
        nodes?: RawAXNode[];
      };
      trees.push({
        frameId: f.frameId,
        url: f.url,
        depth: f.depth,
        ...(f.parentFrameId !== undefined && { parentFrameId: f.parentFrameId }),
        ...(f.ownerBackendNodeId !== undefined && { ownerBackendNodeId: f.ownerBackendNodeId }),
        all: (r.nodes ?? []).filter((n) => !n.ignored),
      });
    } catch (err) {
      // A frame we could list but not read. It stays in `readable` and out of
      // `perceived`, which is exactly the honest pair — the lean view then names
      // its URL as somewhere to go.
      debugLog(`stage-1: getFullAXTree failed for frame ${f.frameId}`, err);
    }
  }
  if (capped > 0) debugLog(`stage-1: capped at ${MAX_PERCEIVED_FRAMES} frames, skipped ${capped}`);

  const shaped = mergeFrameTrees(trees);
  // Display ids are assigned over the MERGED list, so a "Submit" in two frames
  // dedupes as button-submit / button-submit-2 exactly like two on one page.
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
      ...(s.frame && { frame: s.frame }),
    };
  });

  // A dialog only counts as HOLDING the page when nothing outside it is
  // actionable — that is the condition an agent cares about, and it is what
  // makes the vanished nodes explicable. Mere presence is not enough: a page
  // can carry a `role="dialog"` promo while the rest stays perfectly usable,
  // and announcing that as a blocking modal would be its own false receipt.
  //
  // ROOT FRAME ONLY, deliberately, and this is a NAMED PARTIAL: a dialog inside
  // an iframe does not make the page inert — everything outside that frame is
  // still perfectly actionable — so reporting one would print "the rest of the
  // page is inert until it is resolved", which is false. Byte-identical to
  // before this change. Expanding it needs a per-frame inertness model.
  const rootInteractive = all.filter((n) => isInteractive(str(n.role)));
  const dialog = findBlockingDialog(all, rootInteractive, res.nodes ?? []);

  // The unreachable diff runs over EVERY document we walked, not just the root:
  // a cross-site frame nested inside a same-origin one is exactly as invisible,
  // and its owner AX node lives in that child's tree.
  const perceived = trees.length - 1;
  const everyAxNode = trees.flatMap((t) => t.all);
  const frameFacts = await collectFrameFacts(client, frames, everyAxNode, perceived);

  return {
    nodes,
    // The SUM across the documents walked. `frames.perceived` says how many that
    // is, so the number never silently changes meaning.
    axNodeCount: trees.reduce((n, t) => n + t.all.length, 0),
    ...(dialog !== undefined && { dialog }),
    ...(frameFacts !== undefined && { frames: frameFacts }),
  };
}
