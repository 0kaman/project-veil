import { describe, it, expect } from "vitest";
import { FakeCDPClient } from "./fixtures/fake-cdp.js";
import { enrichStructuralEvents, resolveStructuralUrl } from "../pipeline/stage-1-axtree.js";
import type { BehaviorGraph, BehaviorNode, EventBinding } from "../graph/model.js";

function node(id: string, role: string, name: string, backendDOMNodeId = Number(id), events: EventBinding[] = []): BehaviorNode {
  return { id, role, name, description: "", state: {}, value: "", backendDOMNodeId, children: [], events };
}

function graphOf(nodes: BehaviorNode[], url = "https://news.ycombinator.com/"): BehaviorGraph {
  const parsed = new URL(url);
  return {
    metadata: { url, title: "", timestamp: 0, route: parsed.pathname + parsed.search },
    version: 1,
    nodes: new Map(nodes.map((n) => [n.id, n])),
    roots: nodes.map((n) => n.id),
    networkEdges: [],
    apiEndpoints: [],
    componentGroups: [],
  };
}

/** Build a fake CDP whose Runtime.callFunctionOn returns per-backend-node structural info. */
function fakeCdpWithAttrs(attrs: Record<number, { tag: string; href?: string; action?: string; method?: string }>): FakeCDPClient {
  const cdp = new FakeCDPClient();
  // resolveNode echoes the backendNodeId into the objectId so callFunctionOn can look it up
  cdp.on_send("DOM.resolveNode", (params) => {
    const backendNodeId = (params as { backendNodeId: number }).backendNodeId;
    return { object: { objectId: `obj-${backendNodeId}` } };
  });
  cdp.on_send("Runtime.callFunctionOn", (params) => {
    const objectId = (params as { objectId: string }).objectId;
    const backendNodeId = Number(objectId.replace("obj-", ""));
    const a = attrs[backendNodeId];
    return { result: { value: a ? { tag: a.tag, href: a.href ?? null, action: a.action ?? null, method: a.method ?? null } : null } };
  });
  cdp.on_send("Runtime.releaseObject", () => ({}));
  return cdp;
}

describe("Stage 1 — structural events for server-rendered pages (Fix 3)", () => {
  it("synthesizes a GET navigation event from a link's href", async () => {
    const link = node("525", "link", "hide");
    const g = graphOf([link]);
    const cdp = fakeCdpWithAttrs({ 525: { tag: "a", href: "hide?id=44178291&goto=news" } });

    await enrichStructuralEvents(g, cdp);

    expect(link.events).toHaveLength(1);
    expect(link.events[0]).toEqual({
      eventType: "click",
      category: "navigation",
      estimatedEffect: "GET /hide?id=44178291&goto=news",
    });
  });

  it("synthesizes a submit event from a form's action + method", async () => {
    const form = node("10", "form", "Login");
    const g = graphOf([form]);
    const cdp = fakeCdpWithAttrs({ 10: { tag: "form", action: "/login", method: "post" } });

    await enrichStructuralEvents(g, cdp);

    expect(form.events).toHaveLength(1);
    expect(form.events[0]).toEqual({
      eventType: "submit",
      category: "form_submit",
      estimatedEffect: "POST /login",
    });
  });

  it("does NOT overwrite nodes that already have JS events (SPA findings preserved)", async () => {
    const existing: EventBinding = { eventType: "click", category: "api_call", source: { scriptUrl: "app.js", lineNumber: 1, columnNumber: 0, functionName: "" } };
    const link = node("5", "link", "Sign up", 5, [existing]);
    const g = graphOf([link]);
    const cdp = fakeCdpWithAttrs({ 5: { tag: "a", href: "/signup" } });

    await enrichStructuralEvents(g, cdp);

    // Unchanged — Stage 2 owns this node.
    expect(link.events).toEqual([existing]);
  });

  it("skips javascript: and # hrefs", async () => {
    const a = node("1", "link", "noop");
    const b = node("2", "link", "anchor");
    const g = graphOf([a, b]);
    const cdp = fakeCdpWithAttrs({ 1: { tag: "a", href: "javascript:void(0)" }, 2: { tag: "a", href: "#" } });

    await enrichStructuralEvents(g, cdp);

    expect(a.events).toHaveLength(0);
    expect(b.events).toHaveLength(0);
  });

  it("keeps cross-origin links absolute, same-origin as path", async () => {
    const internal = node("1", "link", "past");
    const external = node("2", "link", "theregister.com");
    const g = graphOf([internal, external]);
    const cdp = fakeCdpWithAttrs({
      1: { tag: "a", href: "newest" },
      2: { tag: "a", href: "https://www.theregister.com/article" },
    });

    await enrichStructuralEvents(g, cdp);

    expect(internal.events[0].estimatedEffect).toBe("GET /newest");
    expect(external.events[0].estimatedEffect).toBe("GET https://www.theregister.com/article");
  });

  it("only processes the given nodeIds when scoped (incremental path)", async () => {
    const a = node("1", "link", "a");
    const b = node("2", "link", "b");
    const g = graphOf([a, b]);
    const cdp = fakeCdpWithAttrs({ 1: { tag: "a", href: "/a" }, 2: { tag: "a", href: "/b" } });

    await enrichStructuralEvents(g, cdp, new Set(["1"]));

    expect(a.events).toHaveLength(1);
    expect(b.events).toHaveLength(0); // not in scope
  });
});

describe("resolveStructuralUrl", () => {
  it("resolves relative to path+search for same origin", () => {
    expect(resolveStructuralUrl("vote?id=1", "https://news.ycombinator.com/")).toBe("/vote?id=1");
  });
  it("returns absolute for cross-origin", () => {
    expect(resolveStructuralUrl("https://other.com/x", "https://news.ycombinator.com/")).toBe("https://other.com/x");
  });
  it("falls back to raw on parse failure", () => {
    expect(resolveStructuralUrl("::::", "not a url")).toBe("::::");
  });
});
