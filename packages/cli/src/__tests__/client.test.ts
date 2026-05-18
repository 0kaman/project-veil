import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createServer, type Server, type Socket } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Set the socket path BEFORE importing daemon-protocol
let tmpDir: string;
let socketPath: string;

async function setupSocketPath(): Promise<void> {
  tmpDir = await mkdtemp(join(tmpdir(), "veil-test-"));
  socketPath = join(tmpDir, "daemon.sock");
  process.env.VEIL_SOCKET = socketPath;
}

await setupSocketPath();

const { VeilClient } = await import("../client.js");
const { SOCKET_PATH } = await import("../daemon-protocol.js");

interface ServerMessage {
  rid: string;
  body: unknown;
}

function startMockServer(
  onRequest: (msg: ServerMessage, socket: Socket) => void,
): Promise<Server> {
  return new Promise((resolve, reject) => {
    const server = createServer((socket) => {
      let buf = "";
      socket.on("data", (chunk) => {
        buf += chunk.toString("utf8");
        let nl: number;
        while ((nl = buf.indexOf("\n")) !== -1) {
          const line = buf.slice(0, nl);
          buf = buf.slice(nl + 1);
          if (!line) continue;
          const msg = JSON.parse(line) as ServerMessage;
          onRequest(msg, socket);
        }
      });
    });
    server.once("error", reject);
    server.listen(SOCKET_PATH, () => resolve(server));
  });
}

function reply(socket: Socket, rid: string, result: unknown): void {
  socket.write(JSON.stringify({ rid, ok: true, result }) + "\n");
}

function replyError(socket: Socket, rid: string, code: string, message: string): void {
  socket.write(JSON.stringify({ rid, ok: false, error: { code, message } }) + "\n");
}

describe("VeilClient (Unix socket)", () => {
  let server: Server;
  let client: InstanceType<typeof VeilClient>;

  afterEach(async () => {
    client?.close();
    await new Promise<void>((r) => server?.close(() => r()));
    await rm(socketPath, { force: true }).catch(() => {});
  });

  it("openSession sends 'openSession' op and returns session info", async () => {
    const sessionInfo = { id: "abc-123", url: "https://example.com", createdAt: 1000 };
    let received: ServerMessage | null = null;

    server = await startMockServer((msg, sock) => {
      received = msg;
      reply(sock, msg.rid, sessionInfo);
    });

    client = new VeilClient();
    const result = await client.openSession("https://example.com");

    expect(received).not.toBeNull();
    expect(received!.body).toEqual({ op: "openSession", url: "https://example.com" });
    expect(result).toEqual(sessionInfo);
  });

  it("openSession rejects with server's error message", async () => {
    server = await startMockServer((msg, sock) => {
      replyError(sock, msg.rid, "MAX_SESSIONS", "Too many sessions");
    });

    client = new VeilClient();
    await expect(client.openSession("https://example.com")).rejects.toThrow("Too many sessions");
  });

  it("listSessions returns array", async () => {
    const sessions = [
      { id: "a", url: "https://a.com", createdAt: 1 },
      { id: "b", url: "https://b.com", createdAt: 2 },
    ];

    server = await startMockServer((msg, sock) => {
      reply(sock, msg.rid, sessions);
    });

    client = new VeilClient();
    expect(await client.listSessions()).toEqual(sessions);
  });

  it("closeSession sends 'closeSession' op with id", async () => {
    let received: ServerMessage | null = null;
    server = await startMockServer((msg, sock) => {
      received = msg;
      reply(sock, msg.rid, { ok: true });
    });

    client = new VeilClient();
    await client.closeSession("sess-1");
    expect(received!.body).toEqual({ op: "closeSession", id: "sess-1" });
  });

  it("closeAllSessions lists then closes each", async () => {
    const sessions = [
      { id: "x", url: "https://x.com", createdAt: 1 },
      { id: "y", url: "https://y.com", createdAt: 2 },
    ];
    const received: ServerMessage[] = [];

    server = await startMockServer((msg, sock) => {
      received.push(msg);
      const body = msg.body as { op: string };
      if (body.op === "listSessions") {
        reply(sock, msg.rid, sessions);
      } else {
        reply(sock, msg.rid, { ok: true });
      }
    });

    client = new VeilClient();
    await client.closeAllSessions();

    expect(received).toHaveLength(3);
    expect((received[0].body as { op: string }).op).toBe("listSessions");
    const closeOps = received.slice(1).map((r) => r.body) as Array<{ op: string; id: string }>;
    expect(closeOps.map((o) => o.id).sort()).toEqual(["x", "y"]);
  });

  it("getGraphCompact returns text", async () => {
    const compactText = 'PAGE https://example.com "Example"\nBTN "Click me" [click]\n';
    server = await startMockServer((msg, sock) => reply(sock, msg.rid, compactText));

    client = new VeilClient();
    expect(await client.getGraphCompact("s1")).toBe(compactText);
  });

  it("getGraphJSON returns object", async () => {
    const graph = { graph: { nodes: [], edges: [] } };
    server = await startMockServer((msg, sock) => reply(sock, msg.rid, graph));

    client = new VeilClient();
    expect(await client.getGraphJSON("s1")).toEqual(graph);
  });

  it("getAllNodes returns array", async () => {
    const nodes = [{ id: "1", role: "button", name: "Click" }];
    server = await startMockServer((msg, sock) => reply(sock, msg.rid, nodes));

    client = new VeilClient();
    expect(await client.getAllNodes("s1")).toEqual(nodes);
  });

  it("getNode returns a single node", async () => {
    const node = { id: "1", role: "button", name: "Click" };
    let received: ServerMessage | null = null;
    server = await startMockServer((msg, sock) => {
      received = msg;
      reply(sock, msg.rid, node);
    });

    client = new VeilClient();
    expect(await client.getNode("s1", "1")).toEqual(node);
    expect(received!.body).toEqual({ op: "getNode", id: "s1", nodeId: "1" });
  });

  it("interact returns compact text", async () => {
    const compactText = 'PAGE https://example.com "Example"\n';
    let received: ServerMessage | null = null;
    server = await startMockServer((msg, sock) => {
      received = msg;
      reply(sock, msg.rid, compactText);
    });

    client = new VeilClient();
    const result = await client.interact("s1", "1", { action: "click" });
    expect(result).toBe(compactText);
    expect(received!.body).toEqual({
      op: "interact",
      id: "s1",
      nodeId: "1",
      action: { action: "click" },
    });
  });

  it("navigate returns compact text for new page", async () => {
    const compactText = 'PAGE https://other.com "Other"\n';
    let received: ServerMessage | null = null;
    server = await startMockServer((msg, sock) => {
      received = msg;
      reply(sock, msg.rid, compactText);
    });

    client = new VeilClient();
    const result = await client.navigate("s1", "https://other.com");
    expect(result).toBe(compactText);
    expect(received!.body).toEqual({ op: "navigate", id: "s1", url: "https://other.com" });
  });

  it("propagates SESSION_NOT_FOUND error", async () => {
    server = await startMockServer((msg, sock) => {
      replyError(sock, msg.rid, "SESSION_NOT_FOUND", 'Session "abc" not found');
    });

    client = new VeilClient();
    await expect(client.getGraphCompact("abc")).rejects.toThrow('Session "abc" not found');
  });
});
