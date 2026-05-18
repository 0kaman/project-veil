import { describe, it, expect } from "vitest";
import { groupComponents } from "../pipeline/stage-4-components.js";
import { FakeCDPClient } from "./fixtures/fake-cdp.js";
import type { BehaviorGraph, BehaviorNode } from "../graph/model.js";

function node(id: string, role: string, name = "", children: string[] = []): BehaviorNode {
  return {
    id, role, name,
    description: "",
    state: {},
    value: "",
    backendDOMNodeId: 0,
    children,
    events: [],
  };
}

/**
 * Build a graph where a <main> contains a <form>, which contains <textbox> and <button>.
 * Caller controls the order nodes are inserted into the Map — that's the determinism
 * pivot under test.
 */
function makeFormGraph(insertionOrder: string[]): BehaviorGraph {
  const all = new Map<string, BehaviorNode>();
  all.set("main", node("main", "main", "", ["form"]));
  all.set("form", node("form", "form", "Login", ["input", "submit"]));
  all.set("input", node("input", "textbox", "Email"));
  all.set("submit", node("submit", "button", "Sign in"));

  const nodes = new Map<string, BehaviorNode>();
  for (const id of insertionOrder) {
    const n = all.get(id);
    if (!n) throw new Error(`unknown node id ${id}`);
    nodes.set(id, n);
  }
  return {
    metadata: { url: "https://x.com", title: "", timestamp: 0, route: "/" },
    version: 1,
    nodes,
    roots: ["main"],
    networkEdges: [],
    apiEndpoints: [],
    componentGroups: [],
  };
}

function summarizeGroups(graph: BehaviorGraph): string {
  // Deterministic, comparable summary independent of insertion order in arrays.
  return graph.componentGroups
    .map((g) => `${g.id} [${[...g.memberNodeIds].sort().join(",")}]`)
    .sort()
    .join("\n");
}

describe("Stage 4 — deterministic container grouping (A4)", () => {
  it("identical structure produces identical groups regardless of node insertion order", async () => {
    // Two graphs with the same nodes/edges but different Map insertion order.
    const a = makeFormGraph(["main", "form", "input", "submit"]);
    const b = makeFormGraph(["submit", "input", "form", "main"]);

    const cdp = new FakeCDPClient();
    // groupComponents calls Runtime.evaluate for framework detection;
    // empty result means "no React" — vanilla path runs.
    cdp.respond("Runtime.evaluate", { result: { value: { react: false } } });

    await groupComponents(a, cdp);
    await groupComponents(b, cdp);

    const summaryA = summarizeGroups(a);
    const summaryB = summarizeGroups(b);
    expect(summaryA).toBe(summaryB);
    expect(summaryA.length).toBeGreaterThan(0);
  });

  it("inner form claims the submit button, not outer main", async () => {
    // Both <main> and <form> qualify as containers. With depth-desc ordering,
    // the deeper form runs first and claims the button + input.
    const graph = makeFormGraph(["main", "form", "input", "submit"]);

    const cdp = new FakeCDPClient();
    cdp.respond("Runtime.evaluate", { result: { value: { react: false } } });

    await groupComponents(graph, cdp);

    const submit = graph.nodes.get("submit")!;
    const input = graph.nodes.get("input")!;
    expect(submit.componentId).toMatch(/^cg-vanilla-form-/);
    expect(input.componentId).toMatch(/^cg-vanilla-form-/);
    expect(submit.componentId).toBe(input.componentId);
  });
});
