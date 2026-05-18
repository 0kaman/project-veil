import { createServer, type Socket } from "node:net";
import { mkdir, unlink, writeFile } from "node:fs/promises";
import { serializeJGF, serializeCompactText, type InteractAction } from "@veil/core";
import { SessionManager, DaemonError } from "./session-manager.js";
import {
  SOCKET_PATH,
  VEIL_DIR,
  PID_FILE,
  type Request,
  type Response,
} from "./daemon-protocol.js";

const manager = new SessionManager();

async function dispatch(req: Request): Promise<unknown> {
  const body = req.body;
  switch (body.op) {
    case "ping":
      return { pong: true };

    case "openSession":
      return manager.createSession(body.url);

    case "listSessions":
      return manager.listSessions();

    case "closeSession":
      manager.closeSession(body.id);
      return { ok: true };

    case "getGraphCompact": {
      const page = manager.getPage(body.id);
      return page.toCompactText();
    }

    case "getGraphJSON": {
      const page = manager.getPage(body.id);
      const graph = await page.getGraph();
      return serializeJGF(graph);
    }

    case "getAllNodes": {
      const page = manager.getPage(body.id);
      const graph = await page.getGraph();
      return Array.from(graph.nodes.values());
    }

    case "getNode": {
      const page = manager.getPage(body.id);
      const node = await page.getNode(body.nodeId);
      if (!node) throw new DaemonError("NODE_NOT_FOUND", `Node "${body.nodeId}" not found`);
      return node;
    }

    case "interact": {
      const page = manager.getPage(body.id);
      const newGraph = await page.interact(body.nodeId, body.action as InteractAction);
      return serializeCompactText(newGraph);
    }

    case "navigate": {
      await manager.navigateSession(body.id, body.url);
      const page = manager.getPage(body.id);
      return page.toCompactText();
    }

    case "auth":
      return manager.authSession(body.id, {
        loginUrl: body.loginUrl,
        timeoutMs: body.timeoutMs,
      });
  }
}

function encodeResponse(res: Response): Buffer {
  return Buffer.from(JSON.stringify(res) + "\n", "utf8");
}

function handleConnection(socket: Socket): void {
  let buf = "";

  socket.on("data", async (chunk) => {
    buf += chunk.toString("utf8");

    let nl: number;
    while ((nl = buf.indexOf("\n")) !== -1) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      if (!line) continue;

      let req: Request;
      try {
        req = JSON.parse(line) as Request;
      } catch {
        socket.write(encodeResponse({
          rid: "",
          ok: false,
          error: { code: "INVALID_JSON", message: "Could not parse request" },
        }));
        continue;
      }

      try {
        const result = await dispatch(req);
        socket.write(encodeResponse({ rid: req.rid, ok: true, result }));
      } catch (err) {
        const code = err instanceof DaemonError ? err.code : "INTERNAL_ERROR";
        const message = err instanceof Error ? err.message : String(err);
        socket.write(encodeResponse({ rid: req.rid, ok: false, error: { code, message } }));
      }
    }
  });

  socket.on("error", () => {
    // Client disconnected; nothing to do
  });
}

async function main(): Promise<void> {
  await mkdir(VEIL_DIR, { recursive: true });
  await unlink(SOCKET_PATH).catch(() => {});

  const server = createServer(handleConnection);

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(SOCKET_PATH, () => resolve());
  });

  await writeFile(PID_FILE, String(process.pid));
  console.log(`veil daemon listening on ${SOCKET_PATH}`);

  const shutdown = async () => {
    server.close();
    await manager.shutdown();
    await unlink(SOCKET_PATH).catch(() => {});
    await unlink(PID_FILE).catch(() => {});
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  console.error("Daemon failed to start:", err);
  process.exit(1);
});
