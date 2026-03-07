import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mock @veil/sdk before any imports that use it
vi.mock("@veil/sdk", async (importOriginal) => {
  const orig = await importOriginal<typeof import("@veil/sdk")>();

  const mockGraph = {
    metadata: {
      url: "https://example.com",
      title: "Example",
      timestamp: Date.now(),
      route: "/",
    },
    version: 1,
    nodes: new Map([
      [
        "1",
        {
          id: "1",
          role: "button",
          name: "Click me",
          description: "",
          state: {},
          value: "",
          backendDOMNodeId: 1,
          children: [],
          events: [],
        },
      ],
    ]),
    roots: ["1"],
    networkEdges: [],
    apiEndpoints: [],
    componentGroups: [],
  };

  class MockVeilPage {
    async getGraph() {
      return mockGraph;
    }
    async getNode(id: string) {
      return mockGraph.nodes.get(id) || null;
    }
    async interact(_nodeId: string, _action: any) {
      return mockGraph;
    }
    async toCompactText() {
      return 'PAGE https://example.com "Example"\n';
    }
    async toJSON() {
      return { graph: {} };
    }
    onGraphChange(_cb: any) {
      return () => {};
    }
    close() {}
  }

  class MockVeil {
    async open(_url: string) {
      return new MockVeilPage();
    }
    async close() {}
  }

  return {
    ...orig,
    Veil: MockVeil,
    VeilPage: MockVeilPage,
  };
});

// Mock @hono/node-ws to avoid native WebSocket dependency in tests
vi.mock("@hono/node-ws", () => ({
  createNodeWebSocket: () => ({
    injectWebSocket: () => {},
    upgradeWebSocket: () => (_c: any) => {},
  }),
}));

import { createApp } from "../app.js";
import type { AppContext } from "../app.js";

describe("Hono REST API", () => {
  let ctx: AppContext;

  beforeEach(() => {
    ctx = createApp({ maxSessions: 10 });
  });

  afterEach(async () => {
    await ctx.manager.shutdown();
  });

  // Helper to create a session and return the id
  async function createSession(url = "https://example.com"): Promise<string> {
    const res = await ctx.app.request("/api/sessions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url }),
    });
    const body = await res.json();
    return body.id;
  }

  // ---- Health ----

  it("GET /health returns 200 with status ok", async () => {
    const res = await ctx.app.request("/health");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ status: "ok" });
  });

  // ---- Create Session ----

  it("POST /api/sessions creates a session and returns 201", async () => {
    const res = await ctx.app.request("/api/sessions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url: "https://example.com" }),
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body).toHaveProperty("id");
    expect(body).toHaveProperty("url", "https://example.com");
    expect(body).toHaveProperty("createdAt");
    expect(typeof body.id).toBe("string");
    expect(typeof body.createdAt).toBe("number");
  });

  it("POST /api/sessions without url returns 400", async () => {
    const res = await ctx.app.request("/api/sessions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBeDefined();
    expect(body.error.code).toBe("INVALID_REQUEST");
  });

  it("POST /api/sessions with non-string url returns 400", async () => {
    const res = await ctx.app.request("/api/sessions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url: 123 }),
    });
    expect(res.status).toBe(400);
  });

  // ---- List Sessions ----

  it("GET /api/sessions returns 200 with an array", async () => {
    const res = await ctx.app.request("/api/sessions");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body)).toBe(true);
  });

  it("GET /api/sessions lists created sessions", async () => {
    await createSession("https://a.com");
    await createSession("https://b.com");
    const res = await ctx.app.request("/api/sessions");
    const body = await res.json();
    expect(body.length).toBe(2);
  });

  // ---- Get Session ----

  it("GET /api/sessions/:id returns 200 for existing session", async () => {
    const id = await createSession();
    const res = await ctx.app.request(`/api/sessions/${id}`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.id).toBe(id);
    expect(body.url).toBe("https://example.com");
    expect(body).toHaveProperty("createdAt");
  });

  it("GET /api/sessions/:id returns 404 for non-existent session", async () => {
    const res = await ctx.app.request("/api/sessions/bad-id");
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error.code).toBe("SESSION_NOT_FOUND");
  });

  // ---- Delete Session ----

  it("DELETE /api/sessions/:id returns 200 and removes session", async () => {
    const id = await createSession();
    const res = await ctx.app.request(`/api/sessions/${id}`, {
      method: "DELETE",
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);

    // Verify it's gone
    const check = await ctx.app.request(`/api/sessions/${id}`);
    expect(check.status).toBe(404);
  });

  it("DELETE /api/sessions/:id returns 404 for non-existent session", async () => {
    const res = await ctx.app.request("/api/sessions/bad-id", {
      method: "DELETE",
    });
    expect(res.status).toBe(404);
  });

  // ---- Graph (JGF) ----

  it("GET /api/sessions/:id/graph returns 200 with JGF", async () => {
    const id = await createSession();
    const res = await ctx.app.request(`/api/sessions/${id}/graph`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toBeDefined();
    expect(typeof body).toBe("object");
  });

  it("GET /api/sessions/:id/graph returns 404 for bad session", async () => {
    const res = await ctx.app.request("/api/sessions/bad-id/graph");
    expect(res.status).toBe(404);
  });

  // ---- Graph (Compact) ----

  it("GET /api/sessions/:id/graph/compact returns 200 with text", async () => {
    const id = await createSession();
    const res = await ctx.app.request(`/api/sessions/${id}/graph/compact`);
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(typeof text).toBe("string");
    expect(text.length).toBeGreaterThan(0);
  });

  it("GET /api/sessions/:id/graph/compact returns 404 for bad session", async () => {
    const res = await ctx.app.request("/api/sessions/bad-id/graph/compact");
    expect(res.status).toBe(404);
  });

  // ---- Nodes ----

  it("GET /api/sessions/:id/graph/nodes returns 200 with array of nodes", async () => {
    const id = await createSession();
    const res = await ctx.app.request(`/api/sessions/${id}/graph/nodes`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body)).toBe(true);
    expect(body.length).toBeGreaterThan(0);
    expect(body[0]).toHaveProperty("id", "1");
    expect(body[0]).toHaveProperty("role", "button");
  });

  it("GET /api/sessions/:id/graph/nodes/:nodeId returns 200 for existing node", async () => {
    const id = await createSession();
    const res = await ctx.app.request(`/api/sessions/${id}/graph/nodes/1`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.id).toBe("1");
    expect(body.role).toBe("button");
    expect(body.name).toBe("Click me");
  });

  it("GET /api/sessions/:id/graph/nodes/:nodeId returns 404 for non-existent node", async () => {
    const id = await createSession();
    const res = await ctx.app.request(
      `/api/sessions/${id}/graph/nodes/nonexistent`,
    );
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error.code).toBe("NODE_NOT_FOUND");
  });

  // ---- Interact ----

  it("POST /api/sessions/:id/interact with valid action returns 200", async () => {
    const id = await createSession();
    const res = await ctx.app.request(`/api/sessions/${id}/interact`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ nodeId: "1", action: { action: "click" } }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toBeDefined();
  });

  it("POST /api/sessions/:id/interact with invalid action returns 400", async () => {
    const id = await createSession();
    const res = await ctx.app.request(`/api/sessions/${id}/interact`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        nodeId: "1",
        action: { action: "invalid_action" },
      }),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe("INVALID_REQUEST");
  });

  it("POST /api/sessions/:id/interact without nodeId returns 400", async () => {
    const id = await createSession();
    const res = await ctx.app.request(`/api/sessions/${id}/interact`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: { action: "click" } }),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe("INVALID_REQUEST");
  });

  it("POST /api/sessions/:id/interact without action object returns 400", async () => {
    const id = await createSession();
    const res = await ctx.app.request(`/api/sessions/${id}/interact`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ nodeId: "1" }),
    });
    expect(res.status).toBe(400);
  });

  it("POST /api/sessions/:id/interact with type action missing text returns 400", async () => {
    const id = await createSession();
    const res = await ctx.app.request(`/api/sessions/${id}/interact`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        nodeId: "1",
        action: { action: "type" },
      }),
    });
    expect(res.status).toBe(400);
  });

  // ---- Navigate ----

  it("POST /api/sessions/:id/navigate with valid url returns 200", async () => {
    const id = await createSession();
    const res = await ctx.app.request(`/api/sessions/${id}/navigate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url: "https://other.com" }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toHaveProperty("session");
    expect(body).toHaveProperty("graph");
  });

  it("POST /api/sessions/:id/navigate without url returns 400", async () => {
    const id = await createSession();
    const res = await ctx.app.request(`/api/sessions/${id}/navigate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe("INVALID_REQUEST");
  });

  it("POST /api/sessions/:id/navigate for non-existent session returns 404", async () => {
    const res = await ctx.app.request("/api/sessions/bad-id/navigate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url: "https://other.com" }),
    });
    expect(res.status).toBe(404);
  });

  // ---- Max Sessions ----

  it("returns 429 when max sessions limit is reached", async () => {
    // Create app with limit of 3 for faster test
    const limited = createApp({ maxSessions: 3 });

    await limited.app.request("/api/sessions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url: "https://a.com" }),
    });
    await limited.app.request("/api/sessions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url: "https://b.com" }),
    });
    await limited.app.request("/api/sessions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url: "https://c.com" }),
    });

    // 4th should fail
    const res = await limited.app.request("/api/sessions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url: "https://d.com" }),
    });
    expect(res.status).toBe(429);
    const body = await res.json();
    expect(body.error.code).toBe("MAX_SESSIONS");

    await limited.manager.shutdown();
  });
});
