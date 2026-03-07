import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../daemon.js", () => ({
  getBaseUrl: () => "http://127.0.0.1:3100",
}));

import { VeilClient } from "../client.js";

describe("VeilClient", () => {
  let client: VeilClient;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    client = new VeilClient();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // Helper to create a mock Response
  function mockResponse(body: any, status = 200, contentType = "application/json"): Response {
    const text = typeof body === "string" ? body : JSON.stringify(body);
    return new Response(text, {
      status,
      headers: { "Content-Type": contentType },
    });
  }

  function mockErrorResponse(status: number, code: string, message: string): Response {
    return new Response(
      JSON.stringify({ error: { code, message } }),
      { status, headers: { "Content-Type": "application/json" } },
    );
  }

  // ---- openSession ----

  it("openSession sends POST /api/sessions and returns session info", async () => {
    const sessionInfo = { id: "abc-123", url: "https://example.com", createdAt: 1000 };
    fetchMock.mockResolvedValueOnce(mockResponse(sessionInfo, 201));

    const result = await client.openSession("https://example.com");

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, opts] = fetchMock.mock.calls[0];
    expect(url).toBe("http://127.0.0.1:3100/api/sessions");
    expect(opts.method).toBe("POST");
    expect(JSON.parse(opts.body)).toEqual({ url: "https://example.com" });
    expect(result).toEqual(sessionInfo);
  });

  it("openSession throws on server error with server's error message", async () => {
    fetchMock.mockResolvedValueOnce(
      mockErrorResponse(429, "MAX_SESSIONS", "Too many sessions"),
    );

    await expect(client.openSession("https://example.com")).rejects.toThrow(
      "Too many sessions",
    );
  });

  // ---- listSessions ----

  it("listSessions sends GET /api/sessions and returns array", async () => {
    const sessions = [
      { id: "a", url: "https://a.com", createdAt: 1 },
      { id: "b", url: "https://b.com", createdAt: 2 },
    ];
    fetchMock.mockResolvedValueOnce(mockResponse(sessions));

    const result = await client.listSessions();

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url] = fetchMock.mock.calls[0];
    expect(url).toBe("http://127.0.0.1:3100/api/sessions");
    expect(result).toEqual(sessions);
  });

  // ---- closeSession ----

  it("closeSession sends DELETE /api/sessions/:id", async () => {
    fetchMock.mockResolvedValueOnce(mockResponse({ ok: true }));

    await client.closeSession("sess-1");

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, opts] = fetchMock.mock.calls[0];
    expect(url).toBe("http://127.0.0.1:3100/api/sessions/sess-1");
    expect(opts.method).toBe("DELETE");
  });

  // ---- closeAllSessions ----

  it("closeAllSessions lists then deletes each session", async () => {
    const sessions = [
      { id: "x", url: "https://x.com", createdAt: 1 },
      { id: "y", url: "https://y.com", createdAt: 2 },
    ];

    // First call: listSessions GET
    fetchMock.mockResolvedValueOnce(mockResponse(sessions));
    // Subsequent calls: DELETE for each session
    fetchMock.mockResolvedValueOnce(mockResponse({ ok: true }));
    fetchMock.mockResolvedValueOnce(mockResponse({ ok: true }));

    await client.closeAllSessions();

    expect(fetchMock).toHaveBeenCalledTimes(3);
    // First call is list
    expect(fetchMock.mock.calls[0][0]).toBe("http://127.0.0.1:3100/api/sessions");
    // Next two are deletes (order may vary due to Promise.all)
    const deleteUrls = [fetchMock.mock.calls[1][0], fetchMock.mock.calls[2][0]];
    expect(deleteUrls).toContain("http://127.0.0.1:3100/api/sessions/x");
    expect(deleteUrls).toContain("http://127.0.0.1:3100/api/sessions/y");
  });

  // ---- getGraphCompact ----

  it("getGraphCompact sends GET and returns text", async () => {
    const compactText = 'PAGE https://example.com "Example"\nBTN "Click me" [click]\n';
    fetchMock.mockResolvedValueOnce(mockResponse(compactText, 200, "text/plain"));

    const result = await client.getGraphCompact("s1");

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls[0][0]).toBe(
      "http://127.0.0.1:3100/api/sessions/s1/graph/compact",
    );
    expect(result).toBe(compactText);
  });

  // ---- getGraphJSON ----

  it("getGraphJSON sends GET and returns object", async () => {
    const graph = { graph: { nodes: [], edges: [] } };
    fetchMock.mockResolvedValueOnce(mockResponse(graph));

    const result = await client.getGraphJSON("s1");

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls[0][0]).toBe(
      "http://127.0.0.1:3100/api/sessions/s1/graph",
    );
    expect(result).toEqual(graph);
  });

  // ---- getAllNodes ----

  it("getAllNodes sends GET and returns array of nodes", async () => {
    const nodes = [
      { id: "1", role: "button", name: "Click me" },
      { id: "2", role: "textbox", name: "Search" },
    ];
    fetchMock.mockResolvedValueOnce(mockResponse(nodes));

    const result = await client.getAllNodes("s1");

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls[0][0]).toBe(
      "http://127.0.0.1:3100/api/sessions/s1/graph/nodes",
    );
    expect(result).toEqual(nodes);
  });

  // ---- getNode ----

  it("getNode sends GET and returns a single node", async () => {
    const node = { id: "1", role: "button", name: "Click me" };
    fetchMock.mockResolvedValueOnce(mockResponse(node));

    const result = await client.getNode("s1", "1");

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls[0][0]).toBe(
      "http://127.0.0.1:3100/api/sessions/s1/graph/nodes/1",
    );
    expect(result).toEqual(node);
  });

  // ---- interact ----

  it("interact sends POST then GET compact, returns text", async () => {
    const graphJGF = { graph: {} };
    const compactText = 'PAGE https://example.com "Example"\n';

    // First call: POST interact
    fetchMock.mockResolvedValueOnce(mockResponse(graphJGF));
    // Second call: GET compact
    fetchMock.mockResolvedValueOnce(mockResponse(compactText, 200, "text/plain"));

    const result = await client.interact("s1", "1", { action: "click" } as any);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    // First call is POST interact
    const [interactUrl, interactOpts] = fetchMock.mock.calls[0];
    expect(interactUrl).toBe("http://127.0.0.1:3100/api/sessions/s1/interact");
    expect(interactOpts.method).toBe("POST");
    expect(JSON.parse(interactOpts.body)).toEqual({
      nodeId: "1",
      action: { action: "click" },
    });
    // Second call is GET compact
    expect(fetchMock.mock.calls[1][0]).toBe(
      "http://127.0.0.1:3100/api/sessions/s1/graph/compact",
    );
    expect(result).toBe(compactText);
  });

  // ---- navigate ----

  it("navigate sends POST then GET compact, returns text", async () => {
    const navResponse = { session: {}, graph: {} };
    const compactText = 'PAGE https://other.com "Other"\n';

    // First call: POST navigate
    fetchMock.mockResolvedValueOnce(mockResponse(navResponse));
    // Second call: GET compact
    fetchMock.mockResolvedValueOnce(mockResponse(compactText, 200, "text/plain"));

    const result = await client.navigate("s1", "https://other.com");

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [navUrl, navOpts] = fetchMock.mock.calls[0];
    expect(navUrl).toBe("http://127.0.0.1:3100/api/sessions/s1/navigate");
    expect(navOpts.method).toBe("POST");
    expect(JSON.parse(navOpts.body)).toEqual({ url: "https://other.com" });
    // Second call is GET compact
    expect(fetchMock.mock.calls[1][0]).toBe(
      "http://127.0.0.1:3100/api/sessions/s1/graph/compact",
    );
    expect(result).toBe(compactText);
  });

  // ---- Error handling ----

  it("throws with HTTP status when server returns non-JSON error", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response("Internal Server Error", { status: 500 }),
    );

    await expect(client.listSessions()).rejects.toThrow("HTTP 500");
  });

  it("throws with server error message when available", async () => {
    fetchMock.mockResolvedValueOnce(
      mockErrorResponse(404, "SESSION_NOT_FOUND", "Session \"abc\" not found"),
    );

    await expect(client.getGraphCompact("abc")).rejects.toThrow(
      'Session "abc" not found',
    );
  });
});
