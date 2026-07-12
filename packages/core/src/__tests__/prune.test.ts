import { describe, it, expect } from "vitest";
import { pruneToNodeBudget } from "../pipeline/prune.js";
import type { BehaviorGraph, BehaviorNode, EventBinding } from "../graph/model.js";

function node(id: string, role: string, opts: Partial<BehaviorNode> = {}): BehaviorNode {
  return {
    id, role, name: id, description: "", state: {}, value: "",
    backendDOMNodeId: 1, children: [], events: [], ...opts,
  };
}

function graphOf(nodes: BehaviorNode[]): BehaviorGraph {
  const parented = new Set(nodes.flatMap((n) => n.children));
  return {
    metadata: { url: "https://x.com", title: "T", route: "/", timestamp: 0 },
    version: 1,
    nodes: new Map(nodes.map((n) => [n.id, n])),
    roots: nodes.filter((n) => !parented.has(n.id)).map((n) => n.id),
    networkEdges: [], apiEndpoints: [], componentGroups: [],
  };
}

const behavioral: EventBinding = { eventType: "click", category: "api_call" };

describe("pruneToNodeBudget", () => {
  it("no-op when under budget", () => {
    const g = graphOf([node("a", "button"), node("b", "link")]);
    pruneToNodeBudget(g, 100);
    expect(g.nodes.size).toBe(2);
    expect(g.metadata.nodesTrimmed).toBeUndefined();
  });

  it("drops bulk plain links to meet the budget and records the count", () => {
    const links = Array.from({ length: 50 }, (_, i) =>
      node(`link${i}`, "link", { name: `Article ${i}` }));
    const container = node("nav", "navigation", { children: links.map((l) => l.id) });
    const g = graphOf([container, ...links]);
    pruneToNodeBudget(g, 20);
    expect(g.nodes.size).toBe(20);
    expect(g.metadata.nodesTrimmed).toBe(31); // 51 -> 20
    // the container survived (not a leaf); its children list was trimmed too
    expect(g.nodes.has("nav")).toBe(true);
    expect(g.nodes.get("nav")!.children.length).toBe(g.nodes.size - 1);
  });

  it("NEVER prunes behavioral nodes, form controls, or containers", () => {
    const keep = [
      node("form", "form", { children: ["input", "submit"] }),
      node("input", "textbox"),
      node("submit", "button"),
      node("apilink", "link", { events: [behavioral] }), // link WITH a handler
    ];
    const junk = Array.from({ length: 40 }, (_, i) => node(`j${i}`, "link"));
    const g = graphOf([...keep, ...junk]);
    pruneToNodeBudget(g, 5);
    // all high-value nodes survive; only plain links were cut
    for (const k of ["form", "input", "submit", "apilink"]) {
      expect(g.nodes.has(k), `${k} must survive`).toBe(true);
    }
  });

  it("stops at the low-value supply — never cuts into behavioral nodes even if still over budget", () => {
    const buttons = Array.from({ length: 30 }, (_, i) => node(`b${i}`, "button"));
    const g = graphOf(buttons);
    pruneToNodeBudget(g, 5);
    expect(g.nodes.size).toBe(30); // nothing prunable → left intact, not butchered
    expect(g.metadata.nodesTrimmed).toBeUndefined();
  });

  it("max=0 disables the cap", () => {
    const links = Array.from({ length: 20 }, (_, i) => node(`l${i}`, "link"));
    const g = graphOf(links);
    pruneToNodeBudget(g, 0);
    expect(g.nodes.size).toBe(20);
  });
});
