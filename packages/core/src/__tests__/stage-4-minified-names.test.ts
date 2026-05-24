import { describe, it, expect } from "vitest";
import { isMinifiedName, synthesizeComponentName } from "../pipeline/stage-4-components.js";
import type { BehaviorGraph, BehaviorNode } from "../graph/model.js";

function node(id: string, role: string): BehaviorNode {
  return {
    id, role,
    name: "",
    description: "",
    state: {},
    value: "",
    backendDOMNodeId: 0,
    children: [],
    events: [],
  };
}

function graphOf(nodes: BehaviorNode[]): BehaviorGraph {
  return {
    metadata: { url: "https://x.com", title: "", timestamp: 0, route: "/" },
    version: 1,
    nodes: new Map(nodes.map((n) => [n.id, n])),
    roots: [],
    networkEdges: [],
    apiEndpoints: [],
    componentGroups: [],
  };
}

describe("Stage 4 — minified component name detection (Fix 2)", () => {
  it("detects single/double-char minified names", () => {
    expect(isMinifiedName("T")).toBe(true);
    expect(isMinifiedName("N")).toBe(true);
    expect(isMinifiedName("Av")).toBe(true);
  });

  it("detects capital-letter-plus-digit minified names", () => {
    expect(isMinifiedName("T3")).toBe(true);
    expect(isMinifiedName("R")).toBe(true);
    expect(isMinifiedName("B2")).toBe(true);
  });

  it("does NOT flag real component names", () => {
    expect(isMinifiedName("SearchBar")).toBe(false);
    expect(isMinifiedName("LoginForm")).toBe(false);
    expect(isMinifiedName("NavigationMenuProvider")).toBe(false);
    expect(isMinifiedName("Footer")).toBe(false);
  });
});

describe("Stage 4 — synthesizeComponentName (Fix 2)", () => {
  it("names a group by its dominant role and size", () => {
    const nodes = [
      node("1", "button"),
      node("2", "button"),
      node("3", "button"),
      node("4", "link"),
    ];
    const g = graphOf(nodes);
    expect(synthesizeComponentName(["1", "2", "3", "4"], g)).toBe("buttons-4");
  });

  it("is deterministic on role ties (tiebreak by role name)", () => {
    // 2 buttons, 2 links — tie. Lower role name ("button") wins.
    const nodes = [node("1", "button"), node("2", "button"), node("3", "link"), node("4", "link")];
    const g = graphOf(nodes);
    expect(synthesizeComponentName(["1", "2", "3", "4"], g)).toBe("buttons-4");
    // Same inputs in different order → same output
    expect(synthesizeComponentName(["4", "3", "2", "1"], g)).toBe("buttons-4");
  });

  it("turns the real Linear '71-member T group' into something useful", () => {
    // Reproduces the experiment finding: a group minified to "T" with 71
    // mostly-button members should read as "buttons-71", not "T".
    const nodes: BehaviorNode[] = [];
    const ids: string[] = [];
    for (let i = 0; i < 71; i++) {
      const role = i < 60 ? "button" : "link";
      nodes.push(node(`n${i}`, role));
      ids.push(`n${i}`);
    }
    const g = graphOf(nodes);
    expect(isMinifiedName("T")).toBe(true);
    expect(synthesizeComponentName(ids, g)).toBe("buttons-71");
  });
});
