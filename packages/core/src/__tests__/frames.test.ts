/**
 * Layer 1 — merging per-frame AX trees, hermetically.
 *
 * The recorded shapes here are the ones Chrome actually produced (probe-iframe4
 * / probe-iframe8, Chrome 150.0.7871.187): the frame ELEMENT carries role
 * `Iframe` in the PARENT's tree and is a LEAF there (`children: 0`), which is
 * why the child's nodes have to be fetched separately and spliced back in.
 */
import { describe, it, expect } from "vitest";
import { mergeFrameTrees, type FrameAXTree } from "../pipeline/stage-1-axtree.js";
import { assignDisplayIds } from "../graph/ids.js";

type Raw = FrameAXTree["all"][number];

const ax = (nodeId: string, role: string, name: string, backendDOMNodeId?: number): Raw => ({
  nodeId,
  role: { value: role },
  name: { value: name },
  ...(backendDOMNodeId !== undefined && { backendDOMNodeId }),
});

const ROOT = "F_ROOT";

describe("mergeFrameTrees", () => {
  it("guard (the common path must not move): a page with ONE document is unchanged", () => {
    const only: FrameAXTree = {
      frameId: ROOT,
      url: "http://x.test/",
      depth: 0,
      all: [
        ax("1", "RootWebArea", "Login"),
        ax("2", "textbox", "User", 10),
        ax("3", "button", "Sign in", 11),
        ax("4", "link", "Help", 12),
      ],
    };
    const merged = mergeFrameTrees([only]);
    expect(merged.map((n) => n.name)).toEqual(["User", "Sign in", "Help"]);
    // no frame tag anywhere — this is what keeps every existing receipt byte-identical
    expect(merged.every((n) => n.frame === undefined)).toBe(true);
  });

  it("splices a child document's nodes at its OWNER's position, in document order", () => {
    const trees: FrameAXTree[] = [
      {
        frameId: ROOT,
        url: "http://x.test/iframe",
        depth: 0,
        all: [
          ax("1", "RootWebArea", "Dashboard"),
          ax("2", "button", "Before", 10),
          ax("3", "Iframe", "", 12), // the owner — a LEAF in the parent's tree
          ax("4", "button", "After", 13),
        ],
      },
      {
        frameId: "F_CHILD",
        url: "http://x.test/iframe-inner",
        depth: 1,
        parentFrameId: ROOT,
        ownerBackendNodeId: 12,
        all: [ax("c1", "RootWebArea", "Meter"), ax("c2", "button", "Acknowledge", 20)],
      },
    ];
    const merged = mergeFrameTrees(trees);
    // spliced BETWEEN the two, not appended after both
    expect(merged.map((n) => n.name)).toEqual(["Before", "Acknowledge", "After"]);
    expect(merged[1]!.frame).toEqual({ url: "http://x.test/iframe-inner", depth: 1 });
    expect(merged[0]!.frame).toBeUndefined();
  });

  it("reaches depth 2 — a frame inside a frame", () => {
    const trees: FrameAXTree[] = [
      { frameId: ROOT, url: "http://x.test/", depth: 0, all: [ax("1", "Iframe", "", 12)] },
      {
        frameId: "F_MID",
        url: "http://x.test/mid",
        depth: 1,
        parentFrameId: ROOT,
        ownerBackendNodeId: 12,
        all: [ax("m1", "button", "Mid", 20), ax("m2", "Iframe", "", 21)],
      },
      {
        frameId: "F_LEAF",
        url: "http://x.test/leaf",
        depth: 2,
        parentFrameId: "F_MID",
        ownerBackendNodeId: 21,
        all: [ax("l1", "button", "Leaf", 30)],
      },
    ];
    const merged = mergeFrameTrees(trees);
    expect(merged.map((n) => n.name)).toEqual(["Mid", "Leaf"]);
    expect(merged[1]!.frame).toEqual({ url: "http://x.test/leaf", depth: 2 });
  });

  it("keeps per-frame trees SEPARATE — deliberately overlapping nodeIds must not merge", () => {
    // Measured 0 nodeId collisions across three frames on Chrome 150. This test
    // is what stops that measurement being load-bearing: the ids below collide
    // on purpose, and the result must still be two distinct nodes.
    const trees: FrameAXTree[] = [
      {
        frameId: ROOT,
        url: "http://x.test/",
        depth: 0,
        all: [ax("7", "button", "Parent", 10), ax("8", "Iframe", "", 12)],
      },
      {
        frameId: "F_CHILD",
        url: "http://x.test/child",
        depth: 1,
        parentFrameId: ROOT,
        ownerBackendNodeId: 12,
        all: [ax("7", "button", "Child", 20)],
      },
    ];
    const merged = mergeFrameTrees(trees);
    expect(merged.map((n) => n.name)).toEqual(["Parent", "Child"]);
  });

  it("APPENDS a frame whose owner has no AX node rather than losing it", () => {
    // A display:none iframe has no AX node at all (measured: 4 iframes, 3
    // frame-ish AX nodes), so there is no position to splice at. Dropping it
    // would be a silent loss.
    const trees: FrameAXTree[] = [
      { frameId: ROOT, url: "http://x.test/", depth: 0, all: [ax("1", "button", "Only", 10)] },
      {
        frameId: "F_HIDDEN",
        url: "http://x.test/hidden",
        depth: 1,
        parentFrameId: ROOT,
        ownerBackendNodeId: 99, // never appears in the parent's tree
        all: [ax("h1", "button", "Hidden", 20)],
      },
    ];
    expect(mergeFrameTrees(trees).map((n) => n.name)).toEqual(["Only", "Hidden"]);
  });

  it("dedupes cross-frame name collisions the same way same-page ones are deduped", () => {
    const trees: FrameAXTree[] = [
      {
        frameId: ROOT,
        url: "http://x.test/",
        depth: 0,
        all: [ax("1", "button", "Submit", 10), ax("2", "Iframe", "", 12)],
      },
      {
        frameId: "F_CHILD",
        url: "http://x.test/child",
        depth: 1,
        parentFrameId: ROOT,
        ownerBackendNodeId: 12,
        all: [ax("c1", "button", "Submit", 20)],
      },
    ];
    expect(assignDisplayIds(mergeFrameTrees(trees))).toEqual(["button-submit", "button-submit-2"]);
  });

  it("returns nothing when there is no root document, instead of hanging", () => {
    expect(
      mergeFrameTrees([
        { frameId: "F", url: "u", depth: 1, parentFrameId: "gone", all: [ax("1", "button", "X")] },
      ]),
    ).toEqual([]);
  });
});
