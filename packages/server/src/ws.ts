import type { WSContext } from "hono/ws";
import { serializeJGF } from "@veil/sdk";
import type { BehaviorGraph, GraphDiff } from "@veil/sdk";
import type { SessionManager } from "./sessions.js";
import type { WsServerMessage, WsClientMessage } from "./types.js";

function send(ws: WSContext, msg: WsServerMessage): void {
  try {
    ws.send(JSON.stringify(msg));
  } catch {
    // Connection may have closed
  }
}

export function handleWsUpgrade(
  ws: WSContext,
  sessionId: string,
  manager: SessionManager,
): void {
  let unsubscribe: (() => void) | null = null;

  const setup = async () => {
    const session = manager.getSession(sessionId);
    if (!session) {
      send(ws, { type: "error", error: { code: "SESSION_NOT_FOUND", message: `Session "${sessionId}" not found` } });
      ws.close(1008, "Session not found");
      return;
    }

    // Send initial snapshot
    try {
      const graph = await session.page.getGraph();
      const jgf = serializeJGF(graph);
      send(ws, { type: "snapshot", graph: jgf, version: graph.version });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      send(ws, { type: "error", error: { code: "GRAPH_ERROR", message } });
      ws.close(1011, "Failed to get graph");
      return;
    }

    // Register change listener for diffs
    unsubscribe = manager.addChangeListener(sessionId, (graph: BehaviorGraph, diff: GraphDiff) => {
      const jgf = serializeJGF(graph);
      send(ws, { type: "diff", diff, graph: jgf, version: graph.version });
    });
  };

  setup().catch(() => {
    ws.close(1011, "Setup failed");
  });

  ws.onmessage = (evt) => {
    try {
      const data = JSON.parse(typeof evt.data === "string" ? evt.data : new TextDecoder().decode(evt.data as ArrayBuffer)) as WsClientMessage;

      if (data.type === "ping") {
        send(ws, { type: "pong" });
        return;
      }

      if (data.type === "resync") {
        const session = manager.getSession(sessionId);
        if (!session) {
          send(ws, { type: "error", error: { code: "SESSION_NOT_FOUND", message: "Session no longer exists" } });
          return;
        }
        session.page.getGraph().then((graph) => {
          const jgf = serializeJGF(graph);
          send(ws, { type: "snapshot", graph: jgf, version: graph.version });
        }).catch((err) => {
          const message = err instanceof Error ? err.message : String(err);
          send(ws, { type: "error", error: { code: "GRAPH_ERROR", message } });
        });
        return;
      }
    } catch {
      send(ws, { type: "error", error: { code: "INVALID_MESSAGE", message: "Failed to parse message" } });
    }
  };

  ws.onclose = () => {
    if (unsubscribe) {
      unsubscribe();
      unsubscribe = null;
    }
  };
}
