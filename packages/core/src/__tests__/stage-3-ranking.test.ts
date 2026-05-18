import { describe, it, expect } from "vitest";
import { correlateNetwork } from "../pipeline/stage-3-network.js";
import type { BehaviorGraph, BehaviorNode, NetworkRequest, CallFrame } from "../graph/model.js";

function node(id: string, role: string, name: string, source: { url: string; line: number; col: number }, eventType = "click"): BehaviorNode {
  return {
    id, role, name,
    description: "",
    state: {},
    value: "",
    backendDOMNodeId: 1,
    children: [],
    events: [
      {
        eventType,
        category: "api_call",
        source: {
          scriptUrl: source.url,
          lineNumber: source.line,
          columnNumber: source.col,
          functionName: "",
        },
      },
    ],
  };
}

function graph(nodes: BehaviorNode[]): BehaviorGraph {
  return {
    metadata: { url: "https://x.com", title: "", timestamp: 0, route: "/" },
    version: 1,
    nodes: new Map(nodes.map((n) => [n.id, n])),
    roots: nodes.map((n) => n.id),
    networkEdges: [],
    apiEndpoints: [],
    componentGroups: [],
  };
}

function req(stack: CallFrame[]): NetworkRequest {
  return {
    requestId: "req-1",
    method: "POST",
    url: "https://api.example.com/action",
    initiatorType: "script",
    initiatorStack: stack,
    timestamp: 0,
    responseStatus: 200,
    responseContentType: "application/json",
  };
}

describe("Stage 3 — handler ranking (A2)", () => {
  it("exact (line, col) match wins over line-only candidates", () => {
    // Three handlers all at bundle.js:1, different columns.
    // Request's stack has exact col match for handler B.
    const g = graph([
      node("a", "button", "A", { url: "https://app.com/bundle.js", line: 1, col: 100 }),
      node("b", "button", "B", { url: "https://app.com/bundle.js", line: 1, col: 200 }),
      node("c", "button", "C", { url: "https://app.com/bundle.js", line: 1, col: 300 }),
    ]);

    correlateNetwork(g, [
      req([
        { scriptId: "s", url: "https://app.com/bundle.js", functionName: "f", lineNumber: 1, columnNumber: 200 },
      ]),
    ]);

    expect(g.networkEdges).toHaveLength(1);
    expect(g.networkEdges[0].triggerNodeId).toBe("b");
  });

  it("line-only fallback picks deterministically when only one candidate exists", () => {
    // Single handler at bundle.js:1. Stack points to bundle.js:1 with no exact col match.
    const g = graph([
      node("a", "button", "Only", { url: "https://app.com/bundle.js", line: 1, col: 5 }),
    ]);

    correlateNetwork(g, [
      req([
        { scriptId: "s", url: "https://app.com/bundle.js", functionName: "f", lineNumber: 1, columnNumber: 999 },
      ]),
    ]);

    expect(g.networkEdges).toHaveLength(1);
    expect(g.networkEdges[0].triggerNodeId).toBe("a");
  });

  it("line-only fallback picks the candidate whose scriptUrl appears most often in the stack", () => {
    // Two candidates both at line 1 of different scripts. Stack heavily references bundle.js.
    // The candidate at bundle.js should win — stack URL frequency disambiguates.
    const g = graph([
      node("vendor-handler", "button", "V", { url: "https://app.com/vendor.js", line: 1, col: 50 }),
      node("app-handler", "button", "A", { url: "https://app.com/bundle.js", line: 1, col: 50 }),
    ]);

    correlateNetwork(g, [
      req([
        { scriptId: "1", url: "https://app.com/bundle.js", functionName: "deep", lineNumber: 1, columnNumber: 800 },
        { scriptId: "1", url: "https://app.com/bundle.js", functionName: "mid",  lineNumber: 1, columnNumber: 500 },
        { scriptId: "1", url: "https://app.com/bundle.js", functionName: "shallow", lineNumber: 1, columnNumber: 100 },
        { scriptId: "2", url: "https://app.com/vendor.js", functionName: "lib",  lineNumber: 1, columnNumber: 60 },
      ]),
    ]);

    expect(g.networkEdges).toHaveLength(1);
    expect(g.networkEdges[0].triggerNodeId).toBe("app-handler");
  });

  it("deterministic tiebreak when frequency ties — lower nodeId wins", () => {
    // Two candidates at bundle.js:1 with identical signals.
    // Tiebreak: nodeId asc → "alpha" beats "beta".
    const g = graph([
      node("beta", "button", "Beta", { url: "https://app.com/bundle.js", line: 1, col: 100 }),
      node("alpha", "button", "Alpha", { url: "https://app.com/bundle.js", line: 1, col: 200 }),
    ]);

    correlateNetwork(g, [
      req([
        { scriptId: "1", url: "https://app.com/bundle.js", functionName: "f", lineNumber: 1, columnNumber: 999 },
      ]),
    ]);

    expect(g.networkEdges).toHaveLength(1);
    // Without the deterministic tiebreak, this depended on Map insertion order
    // and would have been "beta" (inserted first). Now it's stable: "alpha" wins.
    expect(g.networkEdges[0].triggerNodeId).toBe("alpha");
  });

  it("regression: line-only first-wins would have attributed wrong (proves A2 fixes a real case)", () => {
    // Simulate the bug scenario: 50 handlers all at bundle.js:1. Without A2,
    // whichever Stage 2 indexed first wins every request. With A2 + ranking,
    // we still need a signal — and if there is none, deterministic tiebreak.
    // This test asserts the OLD behavior (first-wins) is gone.
    const nodes: BehaviorNode[] = [];
    for (let i = 0; i < 50; i++) {
      nodes.push(node(`h${String(i).padStart(2, "0")}`, "button", `h${i}`, {
        url: "https://app.com/bundle.js",
        line: 1,
        col: 100 + i,
      }));
    }
    // Insert in REVERSE order so "first-wins" would pick h49.
    const g = graph([...nodes].reverse());

    correlateNetwork(g, [
      req([
        { scriptId: "1", url: "https://app.com/bundle.js", functionName: "f", lineNumber: 1, columnNumber: 9999 },
      ]),
    ]);

    expect(g.networkEdges).toHaveLength(1);
    // Old behavior: g.networkEdges[0].triggerNodeId === "h49" (last inserted = first in iteration)
    // New behavior: deterministic — h00 wins by lexicographic nodeId.
    expect(g.networkEdges[0].triggerNodeId).toBe("h00");
  });

  it("non-script initiator still emits unmatched edge (A3 + A2 compose)", () => {
    const g = graph([
      node("h", "button", "B", { url: "https://app.com/bundle.js", line: 1, col: 100 }),
    ]);

    correlateNetwork(g, [
      {
        requestId: "req-1",
        method: "GET",
        url: "https://api.example.com/hit",
        initiatorType: "parser",
        timestamp: 0,
      },
    ]);

    expect(g.networkEdges).toHaveLength(1);
    expect(g.networkEdges[0].triggerNodeId).toBe("");
    expect(g.networkEdges[0].triggerEvent).toBe("parser");
  });
});
