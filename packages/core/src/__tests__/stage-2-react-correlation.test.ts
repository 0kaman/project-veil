import { describe, it, expect } from "vitest";
import { FakeCDPClient } from "./fixtures/fake-cdp.js";
import { enrichGraphWithEvents } from "../pipeline/stage-2-events.js";
import { correlateNetwork } from "../pipeline/stage-3-network.js";
import type { BehaviorGraph, BehaviorNode, NetworkRequest } from "../graph/model.js";

function makeNode(overrides: Partial<BehaviorNode> = {}): BehaviorNode {
  return {
    id: "n1",
    role: "button",
    name: "Sign in",
    description: "",
    state: {},
    value: "",
    backendDOMNodeId: 42,
    children: [],
    events: [],
    ...overrides,
  };
}

function makeGraph(nodes: BehaviorNode[]): BehaviorGraph {
  return {
    metadata: { url: "https://app.example.com/login", title: "", timestamp: 0, route: "/login" },
    version: 1,
    nodes: new Map(nodes.map((n) => [n.id, n])),
    roots: nodes.map((n) => n.id),
    networkEdges: [],
    apiEndpoints: [],
    componentGroups: [],
  };
}

describe("Stage 2/3 — React handler correlation (A1)", () => {
  it("populates EventBinding.source on React handlers via [[FunctionLocation]]", async () => {
    const cdp = new FakeCDPClient();

    // Stage 2 starts with Debugger.disable + Debugger.enable to replay scriptParsed.
    // Then collectScriptUrls registers a listener and waits 50ms — we emit during that wait.
    cdp.on_send("Debugger.disable", () => ({}));
    cdp.on_send("Debugger.enable", () => {
      // Replay one parsed script after a microtask so the listener is attached.
      queueMicrotask(() => {
        cdp.emit("Debugger.scriptParsed", {
          scriptId: "script-7",
          url: "https://app.example.com/bundle.js",
        });
      });
      return {};
    });

    cdp.respond("Runtime.callFunctionOn", {
      result: {
        value: [
          {
            eventType: "click",
            handlerString: "function onClick(){ fetch('/api/login',{method:'POST'}) }",
            handlerKey: "_v0_0",
          },
        ],
      },
    });

    cdp.respond("Runtime.evaluate", {
      result: { objectId: "handler-objectid-1" },
    });

    cdp.respond("Runtime.getProperties", {
      internalProperties: [
        {
          name: "[[FunctionLocation]]",
          value: {
            value: {
              scriptId: "script-7",
              lineNumber: 120,
              columnNumber: 16,
            },
          },
        },
      ],
    });

    cdp.respond("DOM.resolveNode", { object: { objectId: "node-objectid-1" } });
    cdp.respond("DOMDebugger.getEventListeners", { listeners: [] });

    // queryInjectedRegistry calls Runtime.evaluate again with a different expression.
    // The respond() above returns the same payload for both — Stage 2's injected-data
    // path tolerates malformed values and produces an empty registry. That's fine
    // for this test; A1 specifically exercises [[FunctionLocation]] resolution.

    const node = makeNode();
    const graph = makeGraph([node]);

    await enrichGraphWithEvents(graph, cdp);

    const enriched = graph.nodes.get("n1")!;
    expect(enriched.events).toHaveLength(1);
    expect(enriched.events[0].eventType).toBe("click");
    expect(enriched.events[0].category).toBe("api_call");
    expect(enriched.events[0].source).toEqual({
      scriptUrl: "https://app.example.com/bundle.js",
      lineNumber: 120,
      columnNumber: 16,
      functionName: "",
    });
  });

  it("correlates a network request to the React handler that fired it", async () => {
    // Pre-populate a node with the source the fixed Stage 2 would produce.
    const node = makeNode({
      events: [
        {
          eventType: "click",
          category: "api_call",
          source: {
            scriptUrl: "https://app.example.com/bundle.js",
            lineNumber: 120,
            columnNumber: 16,
            functionName: "",
          },
        },
      ],
    });
    const graph = makeGraph([node]);

    const request: NetworkRequest = {
      requestId: "req-1",
      method: "POST",
      url: "https://app.example.com/api/login",
      initiatorType: "script",
      initiatorStack: [
        {
          scriptId: "script-7",
          url: "https://app.example.com/bundle.js",
          functionName: "onClick",
          lineNumber: 120,
          columnNumber: 16,
        },
      ],
      timestamp: 0,
      responseStatus: 200,
      responseContentType: "application/json",
    };

    correlateNetwork(graph, [request]);

    expect(graph.networkEdges).toHaveLength(1);
    const edge = graph.networkEdges[0];
    expect(edge.triggerNodeId).toBe("n1");
    expect(edge.triggerEvent).toBe("click");
    expect(edge.request.method).toBe("POST");
    expect(edge.request.url).toBe("https://app.example.com/api/login");

    const enrichedNode = graph.nodes.get("n1")!;
    expect(enrichedNode.events[0].estimatedEffect).toBe("POST /api/login");
  });

  it("gracefully handles missing [[FunctionLocation]] (bound functions, optimized-out source maps)", async () => {
    const cdp = new FakeCDPClient();

    cdp.on_send("Debugger.disable", () => ({}));
    cdp.on_send("Debugger.enable", () => {
      queueMicrotask(() => {
        cdp.emit("Debugger.scriptParsed", {
          scriptId: "script-9",
          url: "https://app.example.com/bundle.js",
        });
      });
      return {};
    });

    cdp.respond("Runtime.callFunctionOn", {
      result: {
        value: [
          {
            eventType: "click",
            handlerString: "function bound(){}",
            handlerKey: "_v0_0",
          },
        ],
      },
    });

    cdp.respond("Runtime.evaluate", {
      result: { objectId: "handler-objectid-2" },
    });

    // No internalProperties — the introspection didn't expose location.
    cdp.respond("Runtime.getProperties", {});

    cdp.respond("DOM.resolveNode", { object: { objectId: "node-objectid-2" } });
    cdp.respond("DOMDebugger.getEventListeners", { listeners: [] });

    const node = makeNode();
    const graph = makeGraph([node]);

    await enrichGraphWithEvents(graph, cdp);

    const enriched = graph.nodes.get("n1")!;
    // Event recorded, but source is undefined — and we didn't crash.
    expect(enriched.events).toHaveLength(1);
    expect(enriched.events[0].eventType).toBe("click");
    expect(enriched.events[0].source).toBeUndefined();
  });

  it("regression: React handlers WITHOUT source are invisible to Stage 3 (proves the bug)", async () => {
    // Hand-craft the pre-fix state: event with no source field.
    const node = makeNode({
      events: [
        {
          eventType: "click",
          category: "unknown",
          // intentionally no `source`
        },
      ],
    });
    const graph = makeGraph([node]);

    const request: NetworkRequest = {
      requestId: "req-1",
      method: "POST",
      url: "https://app.example.com/api/login",
      initiatorType: "script",
      initiatorStack: [
        {
          scriptId: "script-7",
          url: "https://app.example.com/bundle.js",
          functionName: "onClick",
          lineNumber: 120,
          columnNumber: 16,
        },
      ],
      timestamp: 0,
    };

    correlateNetwork(graph, [request]);

    // The request lands in networkEdges as unmatched ("" triggerNodeId).
    expect(graph.networkEdges).toHaveLength(1);
    expect(graph.networkEdges[0].triggerNodeId).toBe("");
    expect(graph.nodes.get("n1")!.events[0].estimatedEffect).toBeUndefined();
  });
});
