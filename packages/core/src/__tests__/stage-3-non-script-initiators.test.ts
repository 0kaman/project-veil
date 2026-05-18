import { describe, it, expect } from "vitest";
import { correlateNetwork } from "../pipeline/stage-3-network.js";
import type { BehaviorGraph, NetworkRequest } from "../graph/model.js";

function emptyGraph(): BehaviorGraph {
  return {
    metadata: { url: "https://x.com", title: "", timestamp: 0, route: "/" },
    version: 1,
    nodes: new Map(),
    roots: [],
    networkEdges: [],
    apiEndpoints: [],
    componentGroups: [],
  };
}

function req(overrides: Partial<NetworkRequest>): NetworkRequest {
  return {
    requestId: "req-1",
    method: "GET",
    url: "https://api.example.com/data",
    initiatorType: "script",
    timestamp: 0,
    ...overrides,
  };
}

describe("Stage 3 — non-script initiators (A3)", () => {
  it("emits an unmatched edge for a parser-initiated request", () => {
    const graph = emptyGraph();
    correlateNetwork(graph, [
      req({ initiatorType: "parser", url: "https://example.com/embedded.json" }),
    ]);

    expect(graph.networkEdges).toHaveLength(1);
    expect(graph.networkEdges[0].triggerNodeId).toBe("");
    expect(graph.networkEdges[0].triggerEvent).toBe("parser");
    expect(graph.networkEdges[0].request.url).toBe("https://example.com/embedded.json");
  });

  it("emits an unmatched edge for an 'other' initiator (preload/beacon/etc)", () => {
    const graph = emptyGraph();
    correlateNetwork(graph, [
      req({ initiatorType: "other", url: "https://example.com/beacon" }),
    ]);

    expect(graph.networkEdges).toHaveLength(1);
    expect(graph.networkEdges[0].triggerNodeId).toBe("");
    expect(graph.networkEdges[0].triggerEvent).toBe("other");
  });

  it("preserves existing behavior: unmatched script-initiated request → triggerEvent='script'", () => {
    const graph = emptyGraph();
    correlateNetwork(graph, [
      req({ initiatorType: "script", initiatorStack: [] }),
    ]);

    expect(graph.networkEdges).toHaveLength(1);
    expect(graph.networkEdges[0].triggerNodeId).toBe("");
    expect(graph.networkEdges[0].triggerEvent).toBe("script");
  });

  it("emits one edge per request — script-matching pathway still wins when applicable", () => {
    const graph: BehaviorGraph = {
      metadata: { url: "https://x.com", title: "", timestamp: 0, route: "/" },
      version: 1,
      nodes: new Map([
        ["n1", {
          id: "n1",
          role: "button",
          name: "Go",
          description: "",
          state: {},
          value: "",
          backendDOMNodeId: 1,
          children: [],
          events: [
            {
              eventType: "click",
              category: "api_call",
              source: { scriptUrl: "https://example.com/app.js", lineNumber: 1, columnNumber: 0, functionName: "" },
            },
          ],
        }],
      ]),
      roots: ["n1"],
      networkEdges: [],
      apiEndpoints: [],
      componentGroups: [],
    };

    correlateNetwork(graph, [
      req({
        initiatorType: "script",
        url: "https://api.example.com/go",
        initiatorStack: [
          { scriptId: "1", url: "https://example.com/app.js", functionName: "f", lineNumber: 1, columnNumber: 0 },
        ],
      }),
      req({ requestId: "req-2", initiatorType: "parser", url: "https://example.com/embedded.json" }),
    ]);

    expect(graph.networkEdges).toHaveLength(2);
    const matched = graph.networkEdges.find((e) => e.triggerNodeId === "n1");
    const unmatched = graph.networkEdges.find((e) => e.triggerEvent === "parser");
    expect(matched).toBeDefined();
    expect(unmatched).toBeDefined();
  });
});
