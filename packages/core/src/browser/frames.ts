/**
 * Frames — the child documents a page's content actually lives in.
 *
 * A page is not one document. `Accessibility.getFullAXTree` with no `frameId`
 * walks the TOP document only, and `document.documentElement.outerHTML` excludes
 * child documents by spec — so a page whose whole point is an `<iframe>` (or a
 * `<frameset>`, whose top document has no content at all) perceives as empty.
 * Measured against the arena fixture: `/frameset` → `ACTIONS (0)`, 157 chars of
 * HTML, `veil_read` "almost no readable text (0 raw words)". Three receipts, all
 * "fine", none carrying the answer.
 *
 * Reachability is FRAME-TREE MEMBERSHIP, not an origin comparison. Measured
 * across three schemes:
 *
 *   | scheme                            | in Page.getFrameTree | AX by frameId |
 *   |-----------------------------------|----------------------|---------------|
 *   | same-origin                       | yes                  | yes           |
 *   | cross-ORIGIN, same SITE (port)    | yes                  | yes           |
 *   | cross-SITE (localhost vs 127.0.0.1)| NO (own OOPIF target)| n/a          |
 *
 * So an origin comparison would wrongly exclude the middle row, and a script-side
 * `contentDocument` splice would silently lose it (measured `null` there). We use
 * the frame tree, which gets that row for free and stays correct under
 * `--isolate-origins`. Cross-SITE frames remain genuinely unreachable — that is
 * DECISIONS' standing OOPIF gap. This module does not close it; it makes it
 * VISIBLE, which is the difference between a known gap and a false receipt.
 */
import type { CDPClient } from "./cdp-client.js";
import { debugLog } from "../debug.js";

/** One document in the frame tree. Depth 0 is the page itself. */
export interface FrameInfo {
  frameId: string;
  url: string;
  /** The `name` attribute — how a frameset addresses its own frames. */
  name: string;
  depth: number;
  parentFrameId?: string;
  /** backendNodeId of the `<iframe>`/`<frame>` ELEMENT in the PARENT document.
   * This is the splice point for HTML, and the owner set the unreachable diff
   * is computed against. */
  ownerBackendNodeId?: number;
}

interface RawFrame {
  id?: string;
  parentId?: string;
  url?: string;
  name?: string;
}
interface RawFrameTree {
  frame?: RawFrame;
  childFrames?: RawFrameTree[];
}

/**
 * Every document Chrome will let us into, depth-first in document order.
 *
 * Cost: one `Page.getFrameTree` (measured 0.65ms over 20 calls) plus one
 * `DOM.getFrameOwner` per child frame. A page with no frames pays exactly one
 * extra CDP call per graph build — that is the common case and it is why the
 * owner lookups are inside the loop rather than unconditional.
 */
export async function listFrames(client: CDPClient): Promise<FrameInfo[]> {
  let tree: RawFrameTree | undefined;
  try {
    const r = (await client.send("Page.getFrameTree")) as { frameTree?: RawFrameTree };
    tree = r.frameTree;
  } catch (err) {
    // Degradation-by-design, but never silent: VEIL_DEBUG=1 surfaces it. A page
    // whose frame tree we cannot read reports no frames, which is the same
    // receipt as today — not a worse one.
    debugLog("frames: Page.getFrameTree failed", err);
    return [];
  }
  if (!tree) return [];

  const out: FrameInfo[] = [];
  const walk = (node: RawFrameTree, depth: number, parentFrameId?: string): void => {
    const f = node.frame;
    if (f?.id) {
      out.push({
        frameId: f.id,
        url: f.url ?? "",
        name: (f.name ?? "").trim(),
        depth,
        ...(parentFrameId !== undefined && { parentFrameId }),
      });
    }
    for (const c of node.childFrames ?? []) walk(c, depth + 1, f?.id);
  };
  walk(tree, 0);

  for (const f of out) {
    if (f.depth === 0) continue;
    try {
      const r = (await client.send("DOM.getFrameOwner", { frameId: f.frameId })) as {
        backendNodeId?: number;
      };
      if (typeof r.backendNodeId === "number") f.ownerBackendNodeId = r.backendNodeId;
    } catch (err) {
      // An owner we cannot resolve costs us the splice position and the
      // unreachable diff for that frame — reported, not assumed away.
      debugLog(`frames: DOM.getFrameOwner failed for ${f.frameId}`, err);
    }
  }
  return out;
}

/**
 * Is the top document a `<frameset>`?
 *
 * Measured clean across four fixture pages: `/frameset` → `FRAMESET`, `/iframe`,
 * `/form` and `/search` → `BODY`. Zero false positives. It matters because a
 * frameset document has NO content of its own — "nothing on this page is
 * actionable" is true and completely useless there.
 */
export async function isFrameset(client: CDPClient): Promise<boolean> {
  try {
    const r = (await client.send("Runtime.evaluate", {
      expression: "document.body && document.body.tagName",
      returnByValue: true,
    })) as { result?: { value?: unknown } };
    return r.result?.value === "FRAMESET";
  } catch (err) {
    debugLog("frames: frameset probe failed", err);
    return false;
  }
}

/** AX roles Chrome gives the `<iframe>`/`<frame>` ELEMENT. Measured: BOTH tags
 * report `Iframe`, in the PARENT's tree, and an OOPIF's owner is still there —
 * which is exactly what makes the diff below possible without a pierced DOM dump. */
const FRAME_AX_ROLES = new Set(["Iframe", "IframePresentational"]);

export interface FrameishNode {
  role?: { value?: unknown };
  backendDOMNodeId?: number;
}

/**
 * Which frame ELEMENTS have no document we can reach — i.e. cross-SITE OOPIFs.
 *
 * Pure, so it is Layer-1 testable. The evidence is data we already hold: the AX
 * nodes stage 1 fetched, and the owner set from `listFrames`. Measured
 * alternative rejected: `DOM.getDocument{depth:-1, pierce:true}` is fine on a
 * 4KB fixture and not on a news site, and `buildGraph` runs on EVERY act against
 * a 7–140ms budget.
 *
 * Known hole, stated rather than hidden: a `display:none` frame has no AX node
 * at all (measured: 4 iframes, 3 frame-ish AX nodes), so a hidden UNREACHABLE
 * frame is not reported. Harmless — it has no visible content — but it means
 * this is a floor on the unreachable count, not a ceiling.
 */
export function unreachableOwners(axNodes: FrameishNode[], owners: Set<number>): number[] {
  const out: number[] = [];
  for (const n of axNodes) {
    const role = typeof n.role?.value === "string" ? n.role.value : "";
    if (!FRAME_AX_ROLES.has(role)) continue;
    const id = n.backendDOMNodeId;
    if (typeof id !== "number" || owners.has(id)) continue;
    out.push(id);
  }
  return out;
}

// ── serializing the whole page, not just the top document ──────────────────

export interface ComposedHtml {
  html: string;
  /** Child documents whose content is IN `html`. */
  composed: number;
  /** Child documents skipped because their frame element has no rendered box —
   * `display:none` and zero-sized frames, which is what tracking pixels and most
   * ad slots are. A stated skip, never a silent one. */
  hidden: number;
  /** Frames whose owner could not be located in the parent's serialization, so
   * their content was APPENDED rather than placed. Content is present; document
   * order is not guaranteed for those. */
  appended: number;
}

async function outerHtml(client: CDPClient, backendNodeId: number): Promise<string> {
  try {
    const r = (await client.send("DOM.getOuterHTML", { backendNodeId })) as { outerHTML?: string };
    return r.outerHTML ?? "";
  } catch (err) {
    debugLog(`frames: DOM.getOuterHTML failed for ${backendNodeId}`, err);
    return "";
  }
}

/** The child document behind a frame element. `pierce` is what crosses it. */
async function contentDocumentId(
  client: CDPClient,
  ownerBackendNodeId: number,
): Promise<number | undefined> {
  try {
    const r = (await client.send("DOM.describeNode", {
      backendNodeId: ownerBackendNodeId,
      pierce: true,
    })) as { node?: { contentDocument?: { backendNodeId?: number } } };
    return r.node?.contentDocument?.backendNodeId;
  } catch (err) {
    debugLog(`frames: DOM.describeNode failed for ${ownerBackendNodeId}`, err);
    return undefined;
  }
}

/**
 * Does this frame element occupy any space? This is the tracking-pixel / dead-ad
 * filter — without it the render rung starts inlining ad-widget text into the
 * prose an agent reads.
 *
 * Measured exactly, on Chrome 150 (probe-quads.mts), rather than assumed:
 *
 *   | markup                                    | quads          | box   | here    |
 *   |-------------------------------------------|----------------|-------|---------|
 *   | `style="display:none"`                    | `[]`           | —     | SKIP    |
 *   | `width=0 height=0 frameborder=0`          | zero-area quad | 0×0   | SKIP    |
 *   | `width=0 height=0` (default 2px border)   | 4×4 quad       | 4×4   | COMPOSE |
 *   | `width=300 height=100`                    | 304×104        | 304×104 | COMPOSE |
 *
 * The first two are what real tracking pixels look like, and both are caught.
 * The third is a genuine, narrow HOLE, stated rather than papered over with a
 * minimum-area threshold: that would be a tuned number, and this project's
 * dialog heuristic earns its keep precisely by having a WIDE measured
 * separation instead of a tuned one. `visibility:hidden` also still returns a
 * full quad and is composed.
 */
async function hasBox(client: CDPClient, backendNodeId: number): Promise<boolean> {
  try {
    const r = (await client.send("DOM.getContentQuads", { backendNodeId })) as {
      quads?: number[][];
    };
    for (const q of r.quads ?? []) {
      if (q.length < 8) continue;
      const xs = [q[0]!, q[2]!, q[4]!, q[6]!];
      const ys = [q[1]!, q[3]!, q[5]!, q[7]!];
      if (Math.max(...xs) - Math.min(...xs) > 0 && Math.max(...ys) - Math.min(...ys) > 0) {
        return true;
      }
    }
  } catch (err) {
    debugLog(`frames: DOM.getContentQuads failed for ${backendNodeId}`, err);
    // Unknown is not the same as hidden. Compose it and say nothing false.
    return true;
  }
  return false;
}

const attr = (s: string): string => s.replace(/&/g, "&amp;").replace(/"/g, "&quot;");

/**
 * The page's HTML including its child documents.
 *
 * `document.documentElement.outerHTML` excludes child documents BY SPEC — that
 * is not a Chrome quirk and no amount of waiting fixes it. Measured on the arena
 * fixture: the `/iframe` page serializes to 216 chars with none of its prose,
 * and `/frameset` to 157 chars of `<frameset>` markup with no content at all.
 * Both then read as `status: ok` "thin page … nothing further to escalate to",
 * which is a receipt asserting completeness it does not have.
 *
 * Each frame's document is spliced in at its owner's position by EXACT SUBSTRING
 * replacement — measured safe: `DOM.getOuterHTML` of the owner is byte-for-byte
 * a substring of the parent's serialization, including attributes containing
 * `>` and quotes, and including `<frame>` inside a `<frameset>`. Two identical
 * iframes produce two hits, which a moving cursor disambiguates. No regex, no
 * HTML parsing. A substring that is not found is APPENDED and counted, never
 * dropped.
 *
 * The wrapper is a `<div data-veil-frame>` and deliberately NOT an `iframe` or
 * `frame` element: @veil/read strips those as boilerplate, which would throw
 * away the very content this exists to recover.
 */
export async function composeFrameHtml(
  client: CDPClient,
  frames: FrameInfo[],
  rootHtml: string,
): Promise<ComposedHtml> {
  const root = frames.find((f) => f.depth === 0);
  if (!root || frames.length <= 1) {
    return { html: rootHtml, composed: 0, hidden: 0, appended: 0 };
  }

  const byParent = new Map<string, FrameInfo[]>();
  for (const f of frames) {
    if (f.parentFrameId === undefined) continue;
    const list = byParent.get(f.parentFrameId);
    if (list) list.push(f);
    else byParent.set(f.parentFrameId, [f]);
  }

  let composed = 0;
  let hidden = 0;
  let appended = 0;
  const seen = new Set<string>();

  const render = async (f: FrameInfo): Promise<string | null> => {
    if (seen.has(f.frameId) || f.ownerBackendNodeId === undefined) return null;
    seen.add(f.frameId);
    if (!(await hasBox(client, f.ownerBackendNodeId))) {
      hidden++;
      return null;
    }
    const docId = await contentDocumentId(client, f.ownerBackendNodeId);
    if (docId === undefined) return null;
    const inner = await outerHtml(client, docId);
    if (!inner) return null;
    composed++;
    return `<div data-veil-frame="${attr(f.url)}">${await splice(f.frameId, inner)}</div>`;
  };

  const splice = async (frameId: string, parentHtml: string): Promise<string> => {
    let out = parentHtml;
    let cursor = 0;
    for (const child of byParent.get(frameId) ?? []) {
      const wrapper = await render(child);
      if (wrapper === null) continue;
      const owner =
        child.ownerBackendNodeId !== undefined
          ? await outerHtml(client, child.ownerBackendNodeId)
          : "";
      const at = owner ? out.indexOf(owner, cursor) : -1;
      if (at >= 0) {
        out = out.slice(0, at) + wrapper + out.slice(at + owner.length);
        cursor = at + wrapper.length;
      } else {
        out += wrapper;
        appended++;
      }
    }
    return out;
  };

  return { html: await splice(root.frameId, rootHtml), composed, hidden, appended };
}

/** Recover the `src` of a frame element we could not enter, so the receipt can
 * NAME what is missing rather than only counting it. One `DOM.describeNode` per
 * unreachable frame — few by construction. */
export async function frameElementSrcs(
  client: CDPClient,
  backendNodeIds: number[],
): Promise<string[]> {
  const out: string[] = [];
  for (const backendNodeId of backendNodeIds) {
    let src = "";
    try {
      const r = (await client.send("DOM.describeNode", { backendNodeId })) as {
        node?: { attributes?: string[] };
      };
      const attrs = r.node?.attributes ?? [];
      for (let i = 0; i + 1 < attrs.length; i += 2) {
        if (attrs[i] === "src") {
          src = attrs[i + 1] ?? "";
          break;
        }
      }
    } catch (err) {
      debugLog(`frames: DOM.describeNode failed for ${backendNodeId}`, err);
    }
    out.push(src || "(src unknown)");
  }
  return out;
}
