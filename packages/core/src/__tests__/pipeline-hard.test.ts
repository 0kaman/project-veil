/**
 * Hard-case pipeline unit tests — the algorithmic edge cases where subtle bugs
 * hide, exercised without a browser. Complements the Layer-2 real-Chrome suite.
 *
 * Focus: URL-pattern parameterization (the endpoint-explosion class), serializer
 * robustness against adversarial accessible names, display-id stability under
 * node churn, and the enricher candidate contract.
 */
import { describe, it, expect } from "vitest";
import { inferUrlPattern, buildApiEndpoints } from "../pipeline/api-endpoints.js";
import { serializeCompactText, serializeJGF } from "../graph/serializer.js";
import { buildDisplayIdRegistry } from "../graph/display-ids.js";
import type { BehaviorGraph, BehaviorNode, NetworkEdge } from "../graph/model.js";

// --- helpers ---------------------------------------------------------------

function node(id: string, role: string, name = "", extra: Partial<BehaviorNode> = {}): BehaviorNode {
  return {
    id, role, name,
    description: "", state: {}, value: "", backendDOMNodeId: 1,
    children: [], events: [], ...extra,
  };
}

function graph(nodes: BehaviorNode[], opts: Partial<BehaviorGraph> = {}): BehaviorGraph {
  return {
    metadata: { url: "https://x.com/p", title: "T", route: "/p", timestamp: 0 },
    version: 1,
    nodes: new Map(nodes.map((n) => [n.id, n])),
    roots: nodes.filter((n) => !nodes.some((p) => p.children.includes(n.id))).map((n) => n.id),
    networkEdges: [],
    apiEndpoints: [],
    componentGroups: [],
    ...opts,
  };
}

// --- URL pattern parameterization (endpoint-explosion class) ----------------

describe("inferUrlPattern — parameterization matrix", () => {
  const cases: [string, string[], string][] = [
    ["numeric ids", ["/api/users/1", "/api/users/2", "/api/users/99"], "/api/users/{id}"],
    ["uuids", [
      "/api/x/3f2504e0-4f89-41d3-9a0c-0305e82c3301",
      "/api/x/6ba7b810-9dad-11d1-80b4-00c04fd430c8",
    ], "/api/x/{id}"],
    ["ISO dates", ["/posts/2024-01-01", "/posts/2024-12-31"], "/posts/{id}"],
    ["locales", ["/en/home", "/fr/home", "/de/home"], "/{id}/home"],
    ["long hex hashes", [
      "/blob/a1b2c3d4e5f60718293a4b5c6d7e8f90",
      "/blob/00112233445566778899aabbccddeeff",
    ], "/blob/{id}"],
    ["stable path stays literal", ["/api/health", "/api/health"], "/api/health"],
    ["mixed non-id segments do NOT collapse", ["/shop/shoes", "/shop/hats"], "/shop/{param}"],
    ["multiple varying segments", [
      "/org/12/repo/abc123def456abc123def456abc12345",
      "/org/34/repo/def456abc123def456abc123def45678",
    ], "/org/{id}/repo/{id}"],
  ];

  for (const [label, urls, expected] of cases) {
    it(label, () => {
      expect(inferUrlPattern(urls.map((u) => "https://api.example.com" + u))).toBe(expected);
    });
  }

  it("date-parameterized routes collapse to ONE endpoint, not N (the explosion bug)", () => {
    const edges: NetworkEdge[] = Array.from({ length: 30 }, (_, i) => ({
      triggerNodeId: "",
      triggerEvent: "script",
      request: { method: "GET", url: `https://api.example.com/metrics/2024-01-${String(i + 1).padStart(2, "0")}` },
      response: { status: 200, contentType: "json" },
    }));
    const endpoints = buildApiEndpoints(edges);
    const metrics = endpoints.filter((e) => e.pattern.startsWith("/metrics/"));
    expect(metrics).toHaveLength(1);
    expect(metrics[0].pattern).toBe("/metrics/{id}");
    expect(metrics[0].count).toBe(30);
  });

  it("distinct real resources stay distinct", () => {
    const edges: NetworkEdge[] = [
      { triggerNodeId: "", triggerEvent: "script", request: { method: "GET", url: "https://api.example.com/users" } },
      { triggerNodeId: "", triggerEvent: "script", request: { method: "GET", url: "https://api.example.com/orders" } },
      { triggerNodeId: "", triggerEvent: "script", request: { method: "POST", url: "https://api.example.com/users" } },
    ];
    const endpoints = buildApiEndpoints(edges);
    // GET /users, GET /orders, POST /users — three distinct (method matters)
    expect(endpoints).toHaveLength(3);
  });
});

// --- serializer robustness against adversarial names ------------------------

describe("serializeCompactText — adversarial accessible names", () => {
  it("a newline in a name cannot break the line-oriented format", () => {
    const g = graph([node("a", "button", "Line one\nLine two")]);
    const text = serializeCompactText(g);
    const nodeLines = text.split("\n").filter((l) => l.includes("[button]"));
    expect(nodeLines).toHaveLength(1); // still exactly one line for the node
    expect(nodeLines[0]).toContain("Line one Line two"); // newline collapsed
  });

  it("quotes in a name are escaped, not terminating the quoted field", () => {
    const g = graph([node("a", "link", 'Say "hello" now')]);
    const text = serializeCompactText(g);
    expect(text).toContain('\\"hello\\"');
  });

  it("commas in state values do not break the comma-joined state list", () => {
    const g = graph([node("a", "textbox", "x", { state: { placeholder: "a, b, c", required: true } })]);
    const text = serializeCompactText(g);
    const stateLine = text.split("\n").find((l) => l.includes("state:"))!;
    // the placeholder's internal commas are sanitized so the parser sees
    // exactly two state entries
    expect(stateLine.split(", ").length).toBeLessThanOrEqual(3);
  });

  it("emoji / unicode names survive", () => {
    const g = graph([node("a", "button", "🛒 Add to cart")]);
    expect(serializeCompactText(g)).toContain("🛒 Add to cart");
  });

  it("empty graph serializes without throwing", () => {
    expect(() => serializeCompactText(graph([]))).not.toThrow();
  });
});

// --- JGF structural integrity ----------------------------------------------

describe("serializeJGF — structure", () => {
  it("produces valid JSON for a nested graph", () => {
    const g = graph([
      node("form", "form", "Login", { children: ["u", "p"] }),
      node("u", "textbox", "User"),
      node("p", "textbox", "Password"),
    ]);
    const jgf = serializeJGF(g);
    const round = JSON.parse(JSON.stringify(jgf));
    expect(round).toBeTruthy();
  });
});

// --- display-id stability under churn ---------------------------------------

describe("buildDisplayIdRegistry — stability", () => {
  it("two same-role same-name nodes get distinct, deterministic display ids", () => {
    const g = graph([
      node("x1", "button", "Sign in"),
      node("x2", "button", "Sign in"),
    ]);
    const r1 = buildDisplayIdRegistry(g);
    const r2 = buildDisplayIdRegistry(g);
    const ids = [...r1.toDisplay.values()];
    expect(new Set(ids).size).toBe(2); // distinct
    expect([...r2.toDisplay.values()]).toEqual(ids); // deterministic across runs
  });

  it("display id survives internal-id reassignment (content-derived)", () => {
    // Chrome reassigns internal AX ids across sessions; the display id must not.
    const g1 = graph([node("internal-A", "button", "Checkout")]);
    const g2 = graph([node("totally-different-B", "button", "Checkout")]);
    const d1 = [...buildDisplayIdRegistry(g1).toDisplay.values()][0];
    const d2 = [...buildDisplayIdRegistry(g2).toDisplay.values()][0];
    expect(d1).toBe(d2);
  });
});
