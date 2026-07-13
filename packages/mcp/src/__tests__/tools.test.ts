/**
 * MCP tool surface — driven by a REAL MCP Client over an in-memory transport,
 * against the REAL SessionStore, with a FAKE Veil (no Chrome). This proves the
 * whole path: client → protocol → tool → store → page, and the error contract.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createSessionStore } from "../sessions.js";
import { registerVeilTools } from "../tools.js";

// --- a fake page + Veil that mimic the core contract without a browser -------

function fakePage(url: string) {
  let route = "/";
  return {
    async getGraph() {
      return { metadata: { url, title: "Fake", route, timestamp: 0 }, nodes: new Map(), roots: [], networkEdges: [], apiEndpoints: [], componentGroups: [], version: 1 };
    },
    async toCompactText() {
      return `PAGE ${url} "Fake"\nSTATE route:${route}\n\nNODES\n  button-go [button] "Go"`;
    },
    async query(filter: Record<string, unknown>) {
      const all = [
        { id: "n1", role: "button", name: "Go", events: [{ eventType: "click" }] },
        { id: "n2", role: "textbox", name: "Search" },
      ];
      return all.filter((n) => (filter.role ? n.role === filter.role : true));
    },
    async interact(node: string, action: { action: string; text?: string }) {
      route = `/after-${action.action}`;
      return { metadata: { url, title: "Fake", route, timestamp: 0 }, nodes: new Map(), roots: [], networkEdges: [], apiEndpoints: [], componentGroups: [], version: 2 };
    },
    close() {},
  };
}

class FakeVeil {
  opened: string[] = [];
  closed = false;
  async open(url: string) {
    this.opened.push(url);
    return fakePage(url);
  }
  async auth() {
    return { success: true, finalUrl: "https://example.com/dashboard" };
  }
  async close() {
    this.closed = true;
  }
}

async function connectedClient(store: ReturnType<typeof createSessionStore>) {
  const server = new McpServer({ name: "veil-test", version: "0.0.0" });
  registerVeilTools(server, store);
  const client = new Client({ name: "test-client", version: "0.0.0" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), client.connect(b)]);
  return client;
}

function textOf(res: { content: { type: string; text?: string }[] }): string {
  return res.content.map((c) => c.text ?? "").join("");
}

describe("Veil MCP tools", () => {
  let store: ReturnType<typeof createSessionStore>;
  let veil: FakeVeil;

  beforeEach(() => {
    veil = new FakeVeil();
    store = createSessionStore(veil as never);
  });
  afterEach(async () => {
    await store.shutdown();
  });

  it("lists all eight tools", async () => {
    const client = await connectedClient(store);
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual([
      "veil_auth",
      "veil_close",
      "veil_do",
      "veil_graph",
      "veil_open",
      "veil_query",
      "veil_replay",
      "veil_sessions",
    ]);
  });

  it("veil_open returns a session id and the graph", async () => {
    const client = await connectedClient(store);
    const res = await client.callTool({ name: "veil_open", arguments: { url: "https://example.com" } });
    const out = textOf(res as never);
    expect(out).toContain("session: s1");
    expect(out).toContain("button-go");
    expect(veil.opened).toEqual(["https://example.com"]);
  });

  it("threads the session through graph/do/query and persists state", async () => {
    const client = await connectedClient(store);
    await client.callTool({ name: "veil_open", arguments: { url: "https://example.com" } });

    const graph = textOf((await client.callTool({ name: "veil_graph", arguments: { session: "s1" } })) as never);
    expect(graph).toContain("route:/");

    const done = textOf(
      (await client.callTool({ name: "veil_do", arguments: { session: "s1", node: "button-go", action: "click" } })) as never,
    );
    expect(done).toContain("route:/after-click"); // interaction advanced the page

    const q = textOf((await client.callTool({ name: "veil_query", arguments: { session: "s1", role: "button" } })) as never);
    expect(q).toContain('"role": "button"');
    expect(q).not.toContain("textbox"); // filtered
  });

  it("veil_do type without text is a clean tool error, not a crash", async () => {
    const client = await connectedClient(store);
    await client.callTool({ name: "veil_open", arguments: { url: "https://example.com" } });
    const res = await client.callTool({ name: "veil_do", arguments: { session: "s1", node: "n", action: "type" } });
    expect((res as { isError?: boolean }).isError).toBe(true);
    expect(textOf(res as never)).toContain("requires 'text'");
  });

  it("an unknown session id is a clean error result", async () => {
    const client = await connectedClient(store);
    const res = await client.callTool({ name: "veil_graph", arguments: { session: "nope" } });
    expect((res as { isError?: boolean }).isError).toBe(true);
    expect(textOf(res as never)).toContain("SESSION_NOT_FOUND");
  });

  it("sessions list and close free the slot", async () => {
    const client = await connectedClient(store);
    await client.callTool({ name: "veil_open", arguments: { url: "https://a.com" } });
    await client.callTool({ name: "veil_open", arguments: { url: "https://b.com" } });
    let list = textOf((await client.callTool({ name: "veil_sessions", arguments: {} })) as never);
    expect(list).toContain("s1");
    expect(list).toContain("s2");

    await client.callTool({ name: "veil_close", arguments: { session: "s1" } });
    list = textOf((await client.callTool({ name: "veil_sessions", arguments: {} })) as never);
    expect(list).not.toContain("s1  ");
    expect(list).toContain("s2");
  });

  it("veil_auth carries success through", async () => {
    const client = await connectedClient(store);
    await client.callTool({ name: "veil_open", arguments: { url: "https://example.com" } });
    const res = textOf((await client.callTool({ name: "veil_auth", arguments: { session: "s1" } })) as never);
    expect(res).toContain("authenticated");
    expect(res).toContain("dashboard");
  });
});
