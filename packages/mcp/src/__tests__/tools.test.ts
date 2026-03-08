import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mock @veil/core before any imports that use it
vi.mock("@veil/core", async (importOriginal) => {
  const orig = await importOriginal<typeof import("@veil/core")>();

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
          name: "Sign in",
          description: "",
          state: {},
          value: "",
          backendDOMNodeId: 1,
          children: [],
          events: [
            {
              eventType: "click",
              category: "form_submit",
              estimatedEffect: "POST /login",
            },
          ],
          semanticLabel: {
            category: "auth",
            action: "login",
            confidence: 0.9,
            source: "heuristic",
          },
        },
      ],
      [
        "2",
        {
          id: "2",
          role: "textbox",
          name: "Username",
          description: "",
          state: { focused: false },
          value: "",
          backendDOMNodeId: 2,
          children: [],
          events: [
            {
              eventType: "input",
              category: "api_call",
              estimatedEffect: "GET /suggest",
            },
          ],
        },
      ],
    ]),
    roots: ["1", "2"],
    networkEdges: [],
    apiEndpoints: [],
    componentGroups: [],
  };

  class MockVeilPage {
    async getGraph() {
      return mockGraph;
    }
    async getNode(id: string) {
      return mockGraph.nodes.get(id) ?? undefined;
    }
    async interact(_nodeId: string, _action: any) {
      return mockGraph;
    }
    async toCompactText() {
      return 'PAGE https://example.com "Example"\n\nNODES\n  button-sign-in [button] "Sign in"\n';
    }
    async toJSON() {
      return { graph: { nodes: [] } };
    }
    async screenshot() {
      return Buffer.from("fakepng", "utf-8");
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

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SessionManager } from "@veil/server";
import { registerTools } from "../tools.js";

// Helper to call a tool handler through the MCP server's internal registry
async function callTool(
  server: McpServer,
  name: string,
  args: Record<string, unknown> = {},
) {
  // Access the server's internal tool handler
  const result = await (server as any)._registeredTools[name].handler(args);
  return result;
}

describe("MCP Tools", () => {
  let server: McpServer;
  let manager: SessionManager;

  beforeEach(() => {
    server = new McpServer({ name: "test", version: "0.0.1" });
    manager = new SessionManager(10);
    registerTools(server, manager);
  });

  afterEach(async () => {
    await manager.shutdown();
  });

  // ---- veil_open ----

  it("veil_open creates a session and returns summary", async () => {
    const result = await callTool(server, "veil_open", {
      url: "https://example.com",
    });
    expect(result.isError).toBeUndefined();
    expect(result.content[0].type).toBe("text");
    expect(result.content[0].text).toContain("Session:");
    expect(result.content[0].text).toContain("Example");
    expect(result.content[0].text).toContain("Nodes: 2");
  });

  it("veil_open normalizes URLs without protocol", async () => {
    const result = await callTool(server, "veil_open", {
      url: "example.com",
    });
    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toContain("Session:");
  });

  // ---- veil_graph ----

  it("veil_graph returns compact text by default", async () => {
    const openResult = await callTool(server, "veil_open", {
      url: "https://example.com",
    });
    const sessionId = openResult.content[0].text.match(
      /Session: ([a-f0-9-]+)/,
    )![1];

    const result = await callTool(server, "veil_graph", {
      session_id: sessionId,
    });
    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toContain("PAGE");
  });

  it("veil_graph returns JSON when format=json", async () => {
    const openResult = await callTool(server, "veil_open", {
      url: "https://example.com",
    });
    const sessionId = openResult.content[0].text.match(
      /Session: ([a-f0-9-]+)/,
    )![1];

    const result = await callTool(server, "veil_graph", {
      session_id: sessionId,
      format: "json",
    });
    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed).toHaveProperty("graph");
  });

  // ---- veil_interact ----

  it("veil_interact click returns summary", async () => {
    const openResult = await callTool(server, "veil_open", {
      url: "https://example.com",
    });
    const sessionId = openResult.content[0].text.match(
      /Session: ([a-f0-9-]+)/,
    )![1];

    const result = await callTool(server, "veil_interact", {
      session_id: sessionId,
      node_id: "1",
      action: "click",
    });
    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toContain('Done: click on "1"');
    expect(result.content[0].text).toContain("Nodes:");
  });

  it("veil_interact type requires value", async () => {
    const openResult = await callTool(server, "veil_open", {
      url: "https://example.com",
    });
    const sessionId = openResult.content[0].text.match(
      /Session: ([a-f0-9-]+)/,
    )![1];

    const result = await callTool(server, "veil_interact", {
      session_id: sessionId,
      node_id: "2",
      action: "type",
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("requires a value");
  });

  it("veil_interact type with value succeeds", async () => {
    const openResult = await callTool(server, "veil_open", {
      url: "https://example.com",
    });
    const sessionId = openResult.content[0].text.match(
      /Session: ([a-f0-9-]+)/,
    )![1];

    const result = await callTool(server, "veil_interact", {
      session_id: sessionId,
      node_id: "2",
      action: "type",
      value: "hello",
    });
    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toContain('Done: type "hello" on "2"');
  });

  it("veil_interact select requires value", async () => {
    const openResult = await callTool(server, "veil_open", {
      url: "https://example.com",
    });
    const sessionId = openResult.content[0].text.match(
      /Session: ([a-f0-9-]+)/,
    )![1];

    const result = await callTool(server, "veil_interact", {
      session_id: sessionId,
      node_id: "1",
      action: "select",
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("requires a value");
  });

  // ---- veil_navigate ----

  it("veil_navigate returns summary", async () => {
    const openResult = await callTool(server, "veil_open", {
      url: "https://example.com",
    });
    const sessionId = openResult.content[0].text.match(
      /Session: ([a-f0-9-]+)/,
    )![1];

    const result = await callTool(server, "veil_navigate", {
      session_id: sessionId,
      url: "https://other.com",
    });
    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toContain("Navigated:");
    expect(result.content[0].text).toContain("Nodes:");
  });

  // ---- veil_find ----

  it("veil_find matches by role", async () => {
    const openResult = await callTool(server, "veil_open", {
      url: "https://example.com",
    });
    const sessionId = openResult.content[0].text.match(
      /Session: ([a-f0-9-]+)/,
    )![1];

    const result = await callTool(server, "veil_find", {
      session_id: sessionId,
      query: "button",
    });
    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toContain("Found 1 node");
    expect(result.content[0].text).toContain("Sign in");
  });

  it("veil_find matches by name substring", async () => {
    const openResult = await callTool(server, "veil_open", {
      url: "https://example.com",
    });
    const sessionId = openResult.content[0].text.match(
      /Session: ([a-f0-9-]+)/,
    )![1];

    const result = await callTool(server, "veil_find", {
      session_id: sessionId,
      query: "sign",
    });
    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toContain("Found 1 node");
  });

  it("veil_find matches by event type", async () => {
    const openResult = await callTool(server, "veil_open", {
      url: "https://example.com",
    });
    const sessionId = openResult.content[0].text.match(
      /Session: ([a-f0-9-]+)/,
    )![1];

    const result = await callTool(server, "veil_find", {
      session_id: sessionId,
      query: "input",
    });
    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toContain("Found 1 node");
    expect(result.content[0].text).toContain("Username");
  });

  it("veil_find returns message when no matches", async () => {
    const openResult = await callTool(server, "veil_open", {
      url: "https://example.com",
    });
    const sessionId = openResult.content[0].text.match(
      /Session: ([a-f0-9-]+)/,
    )![1];

    const result = await callTool(server, "veil_find", {
      session_id: sessionId,
      query: "nonexistent",
    });
    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toContain("No nodes matching");
  });

  // ---- veil_inspect ----

  it("veil_inspect returns node details", async () => {
    const openResult = await callTool(server, "veil_open", {
      url: "https://example.com",
    });
    const sessionId = openResult.content[0].text.match(
      /Session: ([a-f0-9-]+)/,
    )![1];

    const result = await callTool(server, "veil_inspect", {
      session_id: sessionId,
      node_id: "1",
    });
    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toContain('button: "Sign in"');
    expect(result.content[0].text).toContain("on:click");
    expect(result.content[0].text).toContain("semantic: auth:login");
  });

  it("veil_inspect returns error for nonexistent node", async () => {
    const openResult = await callTool(server, "veil_open", {
      url: "https://example.com",
    });
    const sessionId = openResult.content[0].text.match(
      /Session: ([a-f0-9-]+)/,
    )![1];

    const result = await callTool(server, "veil_inspect", {
      session_id: sessionId,
      node_id: "999",
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("not found");
  });

  // ---- veil_sessions ----

  it("veil_sessions lists active sessions", async () => {
    await callTool(server, "veil_open", { url: "https://example.com" });
    await callTool(server, "veil_open", { url: "https://other.com" });

    const result = await callTool(server, "veil_sessions");
    expect(result.isError).toBeUndefined();
    // Should have 2 lines (one per session)
    const lines = result.content[0].text.trim().split("\n");
    expect(lines.length).toBe(2);
  });

  it("veil_sessions shows message when empty", async () => {
    const result = await callTool(server, "veil_sessions");
    expect(result.content[0].text).toBe("No active sessions");
  });

  // ---- veil_close ----

  it("veil_close closes a specific session", async () => {
    const openResult = await callTool(server, "veil_open", {
      url: "https://example.com",
    });
    const sessionId = openResult.content[0].text.match(
      /Session: ([a-f0-9-]+)/,
    )![1];

    const result = await callTool(server, "veil_close", {
      session_id: sessionId,
    });
    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toContain("Closed session");

    // Verify it's gone
    const sessions = await callTool(server, "veil_sessions");
    expect(sessions.content[0].text).toBe("No active sessions");
  });

  it("veil_close closes all sessions when no ID given", async () => {
    await callTool(server, "veil_open", { url: "https://a.com" });
    await callTool(server, "veil_open", { url: "https://b.com" });

    const result = await callTool(server, "veil_close", {});
    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toContain("Closed 2 session(s)");
  });

  // ---- veil_screenshot ----

  it("veil_screenshot returns image content", async () => {
    const openResult = await callTool(server, "veil_open", {
      url: "https://example.com",
    });
    const sessionId = openResult.content[0].text.match(
      /Session: ([a-f0-9-]+)/,
    )![1];

    const result = await callTool(server, "veil_screenshot", {
      session_id: sessionId,
    });
    expect(result.isError).toBeUndefined();
    expect(result.content[0].type).toBe("image");
    expect(result.content[0].mimeType).toBe("image/png");
    expect(typeof result.content[0].data).toBe("string");
  });

  // ---- Session ID resolution ----

  it("resolves session ID by prefix", async () => {
    const openResult = await callTool(server, "veil_open", {
      url: "https://example.com",
    });
    const sessionId = openResult.content[0].text.match(
      /Session: ([a-f0-9-]+)/,
    )![1];
    const prefix = sessionId.substring(0, 8);

    const result = await callTool(server, "veil_graph", {
      session_id: prefix,
    });
    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toContain("PAGE");
  });

  it("returns error for invalid session ID", async () => {
    const result = await callTool(server, "veil_graph", {
      session_id: "nonexistent",
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("No session found");
  });
});
