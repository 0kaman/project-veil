/**
 * Request capture — turning correlated network requests into replayable
 * templates. Pure-function tests over a graph + captured requests (no browser).
 */
import { describe, it, expect } from "vitest";
import { buildCapturedRequests, indexByNode } from "../pipeline/capture.js";
import type { BehaviorGraph, NetworkEdge, NetworkRequest } from "../graph/model.js";

function graphWithEdges(edges: NetworkEdge[]): BehaviorGraph {
  return {
    metadata: { url: "https://x.com", title: "T", route: "/", timestamp: 0 },
    version: 1,
    nodes: new Map(),
    roots: [],
    networkEdges: edges,
    apiEndpoints: [],
    componentGroups: [],
  };
}

function req(partial: Partial<NetworkRequest>): NetworkRequest {
  return {
    requestId: "r1",
    method: "POST",
    url: "https://api.x.com/cart",
    initiatorType: "script",
    timestamp: 1,
    ...partial,
  };
}

describe("buildCapturedRequests", () => {
  it("captures a correlated POST with full headers + body and flags the edge", () => {
    const edge: NetworkEdge = {
      triggerNodeId: "btn-cart",
      triggerEvent: "click",
      request: { method: "POST", url: "https://api.x.com/cart" },
    };
    const graph = graphWithEdges([edge]);
    const captured = buildCapturedRequests(graph, [
      req({
        method: "POST",
        url: "https://api.x.com/cart",
        requestBody: '{"sku":"wh-1","qty":1}',
        requestHeaders: { "content-type": "application/json", "x-csrf-token": "abc123" },
        resourceType: "Fetch",
      }),
    ]);
    expect(captured).toHaveLength(1);
    expect(captured[0]).toMatchObject({
      method: "POST",
      url: "https://api.x.com/cart",
      body: '{"sku":"wh-1","qty":1}',
      triggerNodeId: "btn-cart",
      triggerEvent: "click",
    });
    expect(captured[0].headers["x-csrf-token"]).toBe("abc123"); // full fidelity
    expect(edge.replayable).toBe(true); // the graph edge is flagged
  });

  it("does NOT capture ambient (uncorrelated) requests", () => {
    // an analytics beacon with no triggering node
    const graph = graphWithEdges([
      { triggerNodeId: "", triggerEvent: "script", request: { method: "POST", url: "https://api.x.com/track" } },
    ]);
    const captured = buildCapturedRequests(graph, [
      req({ method: "POST", url: "https://api.x.com/track", requestBody: "{}" }),
    ]);
    expect(captured).toHaveLength(0);
  });

  it("captures GET XHR/Fetch API calls (not just mutations)", () => {
    const graph = graphWithEdges([
      { triggerNodeId: "search", triggerEvent: "input", request: { method: "GET", url: "https://api.x.com/search?q=a" } },
    ]);
    const captured = buildCapturedRequests(graph, [
      req({ method: "GET", url: "https://api.x.com/search?q=a", resourceType: "XHR" }),
    ]);
    expect(captured).toHaveLength(1);
    expect(captured[0].method).toBe("GET");
  });

  it("ignores non-API requests (no body, non-XHR, non-mutating)", () => {
    const graph = graphWithEdges([
      { triggerNodeId: "link", triggerEvent: "click", request: { method: "GET", url: "https://x.com/page" } },
    ]);
    const captured = buildCapturedRequests(graph, [
      req({ method: "GET", url: "https://x.com/page", resourceType: "Document" }),
    ]);
    expect(captured).toHaveLength(0);
  });
});

describe("indexByNode", () => {
  it("groups captured requests by triggering node", () => {
    const idx = indexByNode([
      { method: "POST", url: "u1", headers: {}, triggerNodeId: "a", triggerEvent: "click", timestamp: 1 },
      { method: "POST", url: "u2", headers: {}, triggerNodeId: "a", triggerEvent: "click", timestamp: 2 },
      { method: "GET", url: "u3", headers: {}, triggerNodeId: "b", triggerEvent: "input", timestamp: 3 },
    ]);
    expect(idx.get("a")).toHaveLength(2);
    expect(idx.get("b")).toHaveLength(1);
    expect(idx.get("a")!.map((c) => c.url)).toEqual(["u1", "u2"]);
  });
});
