import { describe, it, expect } from "vitest";
import { diffSnapshots, buildSnapshot } from "../graph/differ.js";
import type { DiffableSnapshot } from "../graph/differ.js";
import { makeAXNode } from "./helpers.js";
import type { AXNode } from "../browser/page.js";

function makeSnapshot(entries: Array<{
  nodeId: string;
  role?: string;
  name?: string;
  description?: string;
  value?: string;
  stateHash?: string;
  childIds?: string[];
}>): DiffableSnapshot {
  const fingerprints = new Map(
    entries.map((e) => [
      e.nodeId,
      {
        role: e.role ?? "button",
        name: e.name ?? "",
        description: e.description ?? "",
        value: e.value ?? "",
        stateHash: e.stateHash ?? "",
        childIds: e.childIds ?? [],
      },
    ]),
  );
  return { fingerprints };
}

describe("diffSnapshots", () => {
  it("detects added nodes", () => {
    const oldSnap = makeSnapshot([{ nodeId: "a" }]);
    const newSnap = makeSnapshot([{ nodeId: "a" }, { nodeId: "b" }]);
    const diff = diffSnapshots(oldSnap, newSnap);
    expect(diff.added).toEqual(["b"]);
    expect(diff.removed).toEqual([]);
    expect(diff.modified).toEqual([]);
  });

  it("detects removed nodes", () => {
    const oldSnap = makeSnapshot([{ nodeId: "a" }, { nodeId: "b" }]);
    const newSnap = makeSnapshot([{ nodeId: "a" }]);
    const diff = diffSnapshots(oldSnap, newSnap);
    expect(diff.removed).toEqual(["b"]);
    expect(diff.added).toEqual([]);
  });

  it("detects modified nodes (name change)", () => {
    const oldSnap = makeSnapshot([{ nodeId: "a", name: "Old" }]);
    const newSnap = makeSnapshot([{ nodeId: "a", name: "New" }]);
    const diff = diffSnapshots(oldSnap, newSnap);
    expect(diff.modified).toEqual(["a"]);
  });

  it("detects modified nodes (value change)", () => {
    const oldSnap = makeSnapshot([{ nodeId: "a", value: "hello" }]);
    const newSnap = makeSnapshot([{ nodeId: "a", value: "world" }]);
    const diff = diffSnapshots(oldSnap, newSnap);
    expect(diff.modified).toEqual(["a"]);
  });

  it("detects modified nodes (state change)", () => {
    const oldSnap = makeSnapshot([{ nodeId: "a", stateHash: "disabled=true" }]);
    const newSnap = makeSnapshot([{ nodeId: "a", stateHash: "" }]);
    const diff = diffSnapshots(oldSnap, newSnap);
    expect(diff.modified).toEqual(["a"]);
  });

  it("detects modified nodes (children change)", () => {
    const oldSnap = makeSnapshot([{ nodeId: "a", childIds: ["c1"] }]);
    const newSnap = makeSnapshot([{ nodeId: "a", childIds: ["c1", "c2"] }]);
    const diff = diffSnapshots(oldSnap, newSnap);
    expect(diff.modified).toEqual(["a"]);
  });

  it("detects modified nodes (children order change)", () => {
    const oldSnap = makeSnapshot([{ nodeId: "a", childIds: ["c1", "c2"] }]);
    const newSnap = makeSnapshot([{ nodeId: "a", childIds: ["c2", "c1"] }]);
    const diff = diffSnapshots(oldSnap, newSnap);
    expect(diff.modified).toEqual(["a"]);
  });

  it("returns empty diff for identical snapshots", () => {
    const snap = makeSnapshot([{ nodeId: "a", name: "X", value: "Y" }]);
    const diff = diffSnapshots(snap, snap);
    expect(diff.added).toEqual([]);
    expect(diff.removed).toEqual([]);
    expect(diff.modified).toEqual([]);
  });

  it("handles mix of added, removed, modified", () => {
    const oldSnap = makeSnapshot([
      { nodeId: "keep", name: "Same" },
      { nodeId: "modify", name: "Old" },
      { nodeId: "remove" },
    ]);
    const newSnap = makeSnapshot([
      { nodeId: "keep", name: "Same" },
      { nodeId: "modify", name: "New" },
      { nodeId: "add" },
    ]);
    const diff = diffSnapshots(oldSnap, newSnap);
    expect(diff.added).toEqual(["add"]);
    expect(diff.removed).toEqual(["remove"]);
    expect(diff.modified).toEqual(["modify"]);
  });

  it("detects modified nodes (role change)", () => {
    const oldSnap = makeSnapshot([{ nodeId: "a", role: "button" }]);
    const newSnap = makeSnapshot([{ nodeId: "a", role: "link" }]);
    const diff = diffSnapshots(oldSnap, newSnap);
    expect(diff.modified).toEqual(["a"]);
  });

  it("detects modified nodes (description change)", () => {
    const oldSnap = makeSnapshot([{ nodeId: "a", description: "Old desc" }]);
    const newSnap = makeSnapshot([{ nodeId: "a", description: "New desc" }]);
    const diff = diffSnapshots(oldSnap, newSnap);
    expect(diff.modified).toEqual(["a"]);
  });
});

describe("buildSnapshot", () => {
  it("creates fingerprints for kept nodes", () => {
    const axNodes: AXNode[] = [
      makeAXNode({ nodeId: "btn1", role: { type: "role", value: "button" }, name: { type: "computedString", value: "OK" } }),
    ];
    const snap = buildSnapshot(axNodes);
    expect(snap.fingerprints.has("btn1")).toBe(true);
    expect(snap.fingerprints.get("btn1")?.role).toBe("button");
    expect(snap.fingerprints.get("btn1")?.name).toBe("OK");
  });

  it("skips ignored/non-kept nodes", () => {
    const axNodes: AXNode[] = [
      makeAXNode({ nodeId: "text1", role: { type: "role", value: "StaticText" } }),
      makeAXNode({ nodeId: "ignored1", ignored: true, role: { type: "role", value: "button" } }),
    ];
    const snap = buildSnapshot(axNodes);
    expect(snap.fingerprints.has("text1")).toBe(false);
    expect(snap.fingerprints.has("ignored1")).toBe(false);
  });

  it("captures role, name, description, value, state, children", () => {
    const axNodes: AXNode[] = [
      makeAXNode({
        nodeId: "txt1",
        role: { type: "role", value: "textbox" },
        name: { type: "computedString", value: "Email" },
        description: { type: "computedString", value: "Enter email" },
        value: { type: "computedString", value: "test@test.com" },
        properties: [{ name: "required", value: { type: "boolean", value: true } }],
        childIds: ["child1"],
      }),
    ];
    const snap = buildSnapshot(axNodes);
    const fp = snap.fingerprints.get("txt1")!;
    expect(fp.role).toBe("textbox");
    expect(fp.name).toBe("Email");
    expect(fp.description).toBe("Enter email");
    expect(fp.value).toBe("test@test.com");
    expect(fp.stateHash).toBe("required=true");
    expect(fp.childIds).toEqual(["child1"]);
  });

  it("returns empty fingerprints for empty axNodes", () => {
    const snap = buildSnapshot([]);
    expect(snap.fingerprints.size).toBe(0);
  });
});
