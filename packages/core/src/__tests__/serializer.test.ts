import { describe, it, expect } from "vitest";
import { serializeCompactText, serializeJGF } from "../graph/serializer.js";
import { makeGraph, makeNode, makeEvent, makeNetworkEdge } from "./helpers.js";
import type { BehaviorGraph, ComponentGroup, ApiEndpoint } from "../graph/model.js";

function graphWith(...args: Parameters<typeof makeNode>[]): BehaviorGraph {
  const nodes = new Map(args.map((a) => [a[0].id, makeNode(a[0])]));
  return makeGraph({ nodes, roots: [args[0][0].id] });
}

describe("serializeCompactText", () => {
  it("outputs PAGE header with url and title", () => {
    const graph = makeGraph();
    const text = serializeCompactText(graph);
    expect(text).toContain('PAGE https://example.com "Test"');
  });

  it("outputs STATE with route", () => {
    const graph = makeGraph();
    const text = serializeCompactText(graph);
    expect(text).toContain("STATE route:/");
  });

  it("outputs NODES section", () => {
    const graph = makeGraph();
    const text = serializeCompactText(graph);
    expect(text).toContain("NODES");
  });

  it("shows node role and name", () => {
    const nodes = new Map([["n1", makeNode({ id: "n1", role: "button", name: "Submit" })]]);
    const graph = makeGraph({ nodes, roots: ["n1"] });
    const text = serializeCompactText(graph);
    expect(text).toContain('[button] "Submit"');
  });

  it("shows state properties (booleans as key, others as key:value)", () => {
    const nodes = new Map([
      ["n1", makeNode({ id: "n1", role: "checkbox", name: "Accept", state: { checked: true, level: "3" } })],
    ]);
    const graph = makeGraph({ nodes, roots: ["n1"] });
    const text = serializeCompactText(graph);
    expect(text).toContain("state: checked, level:3");
  });

  it("shows value when present", () => {
    const nodes = new Map([
      ["n1", makeNode({ id: "n1", role: "textbox", name: "Email", value: "user@example.com" })],
    ]);
    const graph = makeGraph({ nodes, roots: ["n1"] });
    const text = serializeCompactText(graph);
    expect(text).toContain('value: "user@example.com"');
  });

  it("shows events with category and estimatedEffect", () => {
    const nodes = new Map([
      ["n1", makeNode({
        id: "n1",
        role: "button",
        name: "Save",
        events: [makeEvent({ eventType: "click", category: "api_call", estimatedEffect: "POST /api/save" })],
      })],
    ]);
    const graph = makeGraph({ nodes, roots: ["n1"] });
    const text = serializeCompactText(graph);
    expect(text).toMatch(/on:click → api_call \(POST \/api\/save\)/);
  });

  it("shows semantic labels", () => {
    const nodes = new Map([
      ["n1", makeNode({
        id: "n1",
        role: "button",
        name: "Login",
        semanticLabel: { category: "auth", action: "login", confidence: 0.95, source: "heuristic" },
      })],
    ]);
    const graph = makeGraph({ nodes, roots: ["n1"] });
    const text = serializeCompactText(graph);
    expect(text).toContain("semantic: auth:login (0.95, heuristic)");
  });

  it("handles nested children with increasing indentation", () => {
    const child = makeNode({ id: "child1", role: "link", name: "Click" });
    const parent = makeNode({ id: "parent1", role: "navigation", name: "Nav", children: ["child1"] });
    const nodes = new Map([["parent1", parent], ["child1", child]]);
    const graph = makeGraph({ nodes, roots: ["parent1"] });
    const text = serializeCompactText(graph);
    const lines = text.split("\n");
    const parentLine = lines.find((l) => l.includes("[navigation]"))!;
    const childLine = lines.find((l) => l.includes("[link]"))!;
    const parentIndent = parentLine.match(/^(\s*)/)![1].length;
    const childIndent = childLine.match(/^(\s*)/)![1].length;
    expect(childIndent).toBeGreaterThan(parentIndent);
  });

  it("outputs NETWORK section when edges exist", () => {
    const nodes = new Map([["n1", makeNode({ id: "n1", role: "button", name: "Fetch" })]]);
    const graph = makeGraph({
      nodes,
      roots: ["n1"],
      networkEdges: [makeNetworkEdge({ triggerNodeId: "n1", triggerEvent: "click" })],
    });
    const text = serializeCompactText(graph);
    expect(text).toContain("NETWORK");
    expect(text).toContain("GET");
  });

  it("outputs APIS section when apiEndpoints exist", () => {
    const ep: ApiEndpoint = {
      pattern: "/api/users/{id}",
      method: "GET",
      responseShape: { id: "number", name: "string" },
      statusCodes: [200],
      contentType: "json",
      count: 5,
    };
    const graph = makeGraph({ apiEndpoints: [ep] });
    const text = serializeCompactText(graph);
    expect(text).toContain("APIS");
    expect(text).toContain("GET /api/users/{id}");
    expect(text).toContain("id: number");
  });

  it("outputs COMPONENTS section when componentGroups exist", () => {
    const nodes = new Map([["n1", makeNode({ id: "n1", role: "button", name: "Go" })]]);
    const cg: ComponentGroup = {
      id: "cg-react-search",
      framework: "react",
      componentName: "SearchBar",
      memberNodeIds: ["n1"],
    };
    const graph = makeGraph({ nodes, roots: ["n1"], componentGroups: [cg] });
    const text = serializeCompactText(graph);
    expect(text).toContain("COMPONENTS");
    expect(text).toContain('cg-react-search [react] "SearchBar"');
  });

  it("skips empty NETWORK section", () => {
    const graph = makeGraph();
    const text = serializeCompactText(graph);
    expect(text).not.toContain("NETWORK");
  });

  it("skips empty APIS section", () => {
    const graph = makeGraph();
    const text = serializeCompactText(graph);
    expect(text).not.toContain("APIS");
  });

  it("skips empty COMPONENTS section", () => {
    const graph = makeGraph();
    const text = serializeCompactText(graph);
    expect(text).not.toContain("COMPONENTS");
  });
});

describe("serializeJGF", () => {
  it("returns object with graph key", () => {
    const graph = makeGraph();
    const result = serializeJGF(graph);
    expect(result).toHaveProperty("graph");
  });

  it("graph.type is behavior-graph", () => {
    const graph = makeGraph();
    const result = serializeJGF(graph) as { graph: Record<string, unknown> };
    expect(result.graph.type).toBe("behavior-graph");
  });

  it("graph.metadata matches input", () => {
    const graph = makeGraph();
    const result = serializeJGF(graph) as { graph: { metadata: typeof graph.metadata } };
    expect(result.graph.metadata).toEqual(graph.metadata);
  });

  it("graph.nodes maps id to label+metadata", () => {
    const nodes = new Map([["n1", makeNode({ id: "n1", role: "button", name: "OK" })]]);
    const graph = makeGraph({ nodes, roots: ["n1"] });
    const result = serializeJGF(graph) as { graph: { nodes: Record<string, { label: string; metadata: Record<string, unknown> }> } };
    expect(result.graph.nodes["n1"]).toBeDefined();
    expect(result.graph.nodes["n1"].label).toBe("OK");
    expect(result.graph.nodes["n1"].metadata.role).toBe("button");
  });

  it("graph.edges includes contains edges for children", () => {
    const child = makeNode({ id: "c1", role: "link", name: "A" });
    const parent = makeNode({ id: "p1", role: "navigation", name: "Nav", children: ["c1"] });
    const nodes = new Map([["p1", parent], ["c1", child]]);
    const graph = makeGraph({ nodes, roots: ["p1"] });
    const result = serializeJGF(graph) as { graph: { edges: Array<{ source: string; target: string; relation: string }> } };
    const containsEdge = result.graph.edges.find((e) => e.relation === "contains" && e.source === "p1" && e.target === "c1");
    expect(containsEdge).toBeDefined();
  });

  it("graph.edges includes triggers edges for networkEdges", () => {
    const nodes = new Map([["n1", makeNode({ id: "n1", role: "button", name: "Go" })]]);
    const graph = makeGraph({
      nodes,
      roots: ["n1"],
      networkEdges: [makeNetworkEdge({ triggerNodeId: "n1", triggerEvent: "click" })],
    });
    const result = serializeJGF(graph) as { graph: { edges: Array<{ source: string; target: string; relation: string }> } };
    const triggerEdge = result.graph.edges.find((e) => e.relation === "triggers");
    expect(triggerEdge).toBeDefined();
    expect(triggerEdge!.source).toBe("n1");
  });

  it("includes apiEndpoints when non-empty", () => {
    const ep: ApiEndpoint = {
      pattern: "/api/data",
      method: "GET",
      statusCodes: [200],
      count: 1,
    };
    const graph = makeGraph({ apiEndpoints: [ep] });
    const result = serializeJGF(graph) as { graph: { apiEndpoints?: ApiEndpoint[] } };
    expect(result.graph.apiEndpoints).toHaveLength(1);
  });

  it("includes componentGroups when non-empty", () => {
    const cg: ComponentGroup = {
      id: "cg-1",
      framework: "react",
      componentName: "Foo",
      memberNodeIds: [],
    };
    const graph = makeGraph({ componentGroups: [cg] });
    const result = serializeJGF(graph) as { graph: { componentGroups?: ComponentGroup[] } };
    expect(result.graph.componentGroups).toHaveLength(1);
  });

  it("omits apiEndpoints when empty", () => {
    const graph = makeGraph();
    const result = serializeJGF(graph) as { graph: Record<string, unknown> };
    expect(result.graph.apiEndpoints).toBeUndefined();
  });

  it("omits componentGroups when empty", () => {
    const graph = makeGraph();
    const result = serializeJGF(graph) as { graph: Record<string, unknown> };
    expect(result.graph.componentGroups).toBeUndefined();
  });

  it("uses role as label when name is empty", () => {
    const nodes = new Map([["n1", makeNode({ id: "n1", role: "navigation", name: "" })]]);
    const graph = makeGraph({ nodes, roots: ["n1"] });
    const result = serializeJGF(graph) as { graph: { nodes: Record<string, { label: string }> } };
    expect(result.graph.nodes["n1"].label).toBe("navigation");
  });
});
