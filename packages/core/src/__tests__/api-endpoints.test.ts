import { describe, it, expect } from "vitest";
import { inferJsonShape, inferUrlPattern, buildApiEndpoints } from "../pipeline/api-endpoints.js";
import { makeNetworkEdge } from "./helpers.js";

describe("inferJsonShape", () => {
  it("infers shape from simple JSON object", () => {
    const shape = inferJsonShape('{"id": 1, "name": "Alice", "active": true}');
    expect(shape).toEqual({ id: "number", name: "string", active: "boolean" });
  });

  it("infers shape from array (uses first element)", () => {
    const shape = inferJsonShape('[{"id": 1, "name": "Alice"}, {"id": 2, "name": "Bob"}]');
    expect(shape).toEqual({ id: "number", name: "string" });
  });

  it("returns null for invalid JSON", () => {
    expect(inferJsonShape("not json")).toBeNull();
    expect(inferJsonShape("{broken")).toBeNull();
  });

  it("returns null for empty array", () => {
    expect(inferJsonShape("[]")).toBeNull();
  });

  it("returns null for non-object values", () => {
    expect(inferJsonShape('"hello"')).toBeNull();
    expect(inferJsonShape("42")).toBeNull();
    expect(inferJsonShape("true")).toBeNull();
    expect(inferJsonShape("null")).toBeNull();
  });

  it("handles nested objects and arrays", () => {
    const shape = inferJsonShape('{"items": [{"id": 1}], "meta": {"page": 1}, "tags": ["a"]}');
    expect(shape).toEqual({ items: "object[]", meta: "object", tags: "string[]" });
  });

  it("handles null values", () => {
    const shape = inferJsonShape('{"name": "test", "deleted_at": null}');
    expect(shape).toEqual({ name: "string", deleted_at: "null" });
  });

  it("handles empty nested arrays", () => {
    const shape = inferJsonShape('{"items": [], "name": "test"}');
    expect(shape).toEqual({ items: "array", name: "string" });
  });

  it("returns null for empty object", () => {
    expect(inferJsonShape("{}")).toBeNull();
  });
});

describe("inferUrlPattern", () => {
  it("returns single URL path as-is", () => {
    const pattern = inferUrlPattern(["https://api.example.com/api/users"]);
    expect(pattern).toBe("/api/users");
  });

  it("detects numeric varying segments as {id}", () => {
    const pattern = inferUrlPattern([
      "https://api.example.com/api/users/1",
      "https://api.example.com/api/users/2",
      "https://api.example.com/api/users/42",
    ]);
    expect(pattern).toBe("/api/users/{id}");
  });

  it("detects UUID varying segments as {id}", () => {
    const pattern = inferUrlPattern([
      "https://api.example.com/api/items/550e8400-e29b-41d4-a716-446655440000",
      "https://api.example.com/api/items/6ba7b810-9dad-11d1-80b4-00c04fd430c8",
    ]);
    expect(pattern).toBe("/api/items/{id}");
  });

  it("detects other varying segments as {param}", () => {
    const pattern = inferUrlPattern([
      "https://api.example.com/api/users/alice/profile",
      "https://api.example.com/api/users/bob/profile",
    ]);
    expect(pattern).toBe("/api/users/{param}/profile");
  });

  it("preserves common segments", () => {
    const pattern = inferUrlPattern([
      "https://api.example.com/api/v2/data/1",
      "https://api.example.com/api/v2/data/2",
    ]);
    expect(pattern).toBe("/api/v2/data/{id}");
  });

  it("appends query params with templates", () => {
    const pattern = inferUrlPattern([
      "https://api.example.com/search?q=hello&page=1",
      "https://api.example.com/search?q=world&page=2",
    ]);
    expect(pattern).toContain("/search");
    expect(pattern).toContain("q={q}");
    expect(pattern).toContain("page={page}");
  });

  it('returns "/" for empty array', () => {
    expect(inferUrlPattern([])).toBe("/");
  });

  it("single URL with query params includes template", () => {
    const pattern = inferUrlPattern(["https://api.example.com/search?q=test"]);
    expect(pattern).toBe("/search?q={q}");
  });
});

describe("buildApiEndpoints", () => {
  it("groups edges by method + path prefix", () => {
    const edges = [
      makeNetworkEdge({ request: { method: "GET", url: "https://api.example.com/api/users/1" } }),
      makeNetworkEdge({ request: { method: "GET", url: "https://api.example.com/api/users/2" } }),
      makeNetworkEdge({ request: { method: "POST", url: "https://api.example.com/api/users" } }),
    ];
    const endpoints = buildApiEndpoints(edges);
    // GET and POST should be separate groups
    const getMethods = endpoints.filter((e) => e.method === "GET");
    const postMethods = endpoints.filter((e) => e.method === "POST");
    expect(getMethods.length).toBeGreaterThanOrEqual(1);
    expect(postMethods.length).toBeGreaterThanOrEqual(1);
  });

  it("merges response shapes across edges", () => {
    const edges = [
      makeNetworkEdge({
        request: { method: "GET", url: "https://api.example.com/api/users/1" },
        response: { status: 200, contentType: "application/json", bodyShape: { id: "number", name: "string" } },
      }),
      makeNetworkEdge({
        request: { method: "GET", url: "https://api.example.com/api/users/2" },
        response: { status: 200, contentType: "application/json", bodyShape: { id: "number", email: "string" } },
      }),
    ];
    const endpoints = buildApiEndpoints(edges);
    const ep = endpoints.find((e) => e.method === "GET");
    expect(ep?.responseShape).toEqual({ id: "number", name: "string", email: "string" });
  });

  it("collects unique status codes", () => {
    const edges = [
      makeNetworkEdge({
        request: { method: "GET", url: "https://api.example.com/api/data/1" },
        response: { status: 200, contentType: "application/json" },
      }),
      makeNetworkEdge({
        request: { method: "GET", url: "https://api.example.com/api/data/2" },
        response: { status: 404, contentType: "application/json" },
      }),
      makeNetworkEdge({
        request: { method: "GET", url: "https://api.example.com/api/data/3" },
        response: { status: 200, contentType: "application/json" },
      }),
    ];
    const endpoints = buildApiEndpoints(edges);
    const ep = endpoints[0];
    expect(ep.statusCodes).toEqual([200, 404]);
  });

  it("sorts by count descending", () => {
    const edges = [
      makeNetworkEdge({ request: { method: "GET", url: "https://api.example.com/api/rare" } }),
      makeNetworkEdge({ request: { method: "POST", url: "https://api.example.com/api/common/a" } }),
      makeNetworkEdge({ request: { method: "POST", url: "https://api.example.com/api/common/b" } }),
      makeNetworkEdge({ request: { method: "POST", url: "https://api.example.com/api/common/c" } }),
    ];
    const endpoints = buildApiEndpoints(edges);
    for (let i = 1; i < endpoints.length; i++) {
      expect(endpoints[i - 1].count).toBeGreaterThanOrEqual(endpoints[i].count);
    }
  });

  it("handles edges without responses", () => {
    const edges = [
      makeNetworkEdge({ request: { method: "GET", url: "https://api.example.com/api/pending" } }),
    ];
    const endpoints = buildApiEndpoints(edges);
    expect(endpoints).toHaveLength(1);
    expect(endpoints[0].statusCodes).toEqual([]);
    expect(endpoints[0].responseShape).toBeUndefined();
  });

  it("handles empty edges array", () => {
    const endpoints = buildApiEndpoints([]);
    expect(endpoints).toEqual([]);
  });

  it("sets contentType from response", () => {
    const edges = [
      makeNetworkEdge({
        request: { method: "GET", url: "https://api.example.com/api/data" },
        response: { status: 200, contentType: "application/json; charset=utf-8" },
      }),
    ];
    const endpoints = buildApiEndpoints(edges);
    expect(endpoints[0].contentType).toBe("json");
  });
});
