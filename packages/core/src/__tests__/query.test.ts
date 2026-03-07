import { describe, it, expect } from "vitest";
import { queryNodes } from "../graph/query.js";
import { makeGraph, makeNode, makeEvent } from "./helpers.js";
import type { BehaviorGraph } from "../graph/model.js";

function buildTestGraph(): BehaviorGraph {
  const nodes = new Map([
    ["n1", makeNode({
      id: "n1",
      role: "button",
      name: "Submit",
      events: [makeEvent({ eventType: "click", category: "api_call" })],
      state: { disabled: true },
      componentId: "cg-form",
      semanticLabel: { category: "form", action: "submit", confidence: 0.9, source: "heuristic" },
    })],
    ["n2", makeNode({
      id: "n2",
      role: "link",
      name: "Home",
      events: [makeEvent({ eventType: "click", category: "navigation" })],
      state: {},
      semanticLabel: { category: "navigation", action: "primary", confidence: 0.8, source: "heuristic" },
    })],
    ["n3", makeNode({
      id: "n3",
      role: "textbox",
      name: "Email",
      events: [makeEvent({ eventType: "input", category: "unknown" })],
      state: { required: true },
      componentId: "cg-form",
    })],
    ["n4", makeNode({
      id: "n4",
      role: "button",
      name: "Cancel",
      events: [],
      state: {},
    })],
    ["n5", makeNode({
      id: "n5",
      role: "checkbox",
      name: "Accept Terms",
      events: [makeEvent({ eventType: "change", category: "dom_mutation" })],
      state: { checked: true },
      componentId: "cg-form",
    })],
  ]);
  return makeGraph({ nodes, roots: ["n1", "n2", "n3", "n4", "n5"] });
}

describe("queryNodes", () => {
  it("filters by role (exact match)", () => {
    const graph = buildTestGraph();
    const results = queryNodes(graph, { role: "button" });
    expect(results).toHaveLength(2);
    expect(results.map((n) => n.id).sort()).toEqual(["n1", "n4"]);
  });

  it("filters by name (exact string match)", () => {
    const graph = buildTestGraph();
    const results = queryNodes(graph, { name: "Submit" });
    expect(results).toHaveLength(1);
    expect(results[0].id).toBe("n1");
  });

  it("filters by name (RegExp match)", () => {
    const graph = buildTestGraph();
    const results = queryNodes(graph, { name: /^[A-Z].*/ });
    // Submit, Home, Email, Cancel, Accept Terms all start with uppercase
    expect(results).toHaveLength(5);
  });

  it("filters by name (RegExp partial match)", () => {
    const graph = buildTestGraph();
    const results = queryNodes(graph, { name: /mail/ });
    expect(results).toHaveLength(1);
    expect(results[0].id).toBe("n3");
  });

  it("filters by hasEvent (exact event type match)", () => {
    const graph = buildTestGraph();
    const results = queryNodes(graph, { hasEvent: "click" });
    expect(results).toHaveLength(2);
    expect(results.map((n) => n.id).sort()).toEqual(["n1", "n2"]);
  });

  it("filters by state (key-value match)", () => {
    const graph = buildTestGraph();
    const results = queryNodes(graph, { state: { disabled: true } });
    expect(results).toHaveLength(1);
    expect(results[0].id).toBe("n1");
  });

  it("filters by semanticCategory", () => {
    const graph = buildTestGraph();
    const results = queryNodes(graph, { semanticCategory: "navigation" });
    expect(results).toHaveLength(1);
    expect(results[0].id).toBe("n2");
  });

  it("filters by semanticAction", () => {
    const graph = buildTestGraph();
    const results = queryNodes(graph, { semanticAction: "submit" });
    expect(results).toHaveLength(1);
    expect(results[0].id).toBe("n1");
  });

  it("filters by componentId", () => {
    const graph = buildTestGraph();
    const results = queryNodes(graph, { componentId: "cg-form" });
    expect(results).toHaveLength(3);
    expect(results.map((n) => n.id).sort()).toEqual(["n1", "n3", "n5"]);
  });

  it("combined filters (role + name + event)", () => {
    const graph = buildTestGraph();
    const results = queryNodes(graph, { role: "button", name: "Submit", hasEvent: "click" });
    expect(results).toHaveLength(1);
    expect(results[0].id).toBe("n1");
  });

  it("returns empty array when no matches", () => {
    const graph = buildTestGraph();
    const results = queryNodes(graph, { role: "slider" });
    expect(results).toEqual([]);
  });

  it("returns all nodes when filter is empty {}", () => {
    const graph = buildTestGraph();
    const results = queryNodes(graph, {});
    expect(results).toHaveLength(5);
  });

  it("does not match when state key exists but value differs", () => {
    const graph = buildTestGraph();
    const results = queryNodes(graph, { state: { checked: true, disabled: true } });
    expect(results).toHaveLength(0);
  });

  it("does not match semanticCategory on nodes without semanticLabel", () => {
    const graph = buildTestGraph();
    const results = queryNodes(graph, { semanticCategory: "form", role: "textbox" });
    // n3 textbox has no semanticLabel
    expect(results).toHaveLength(0);
  });
});
