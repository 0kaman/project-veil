import { Hono } from "hono";
import type { ServerType } from "@hono/node-server";
import { createNodeWebSocket } from "@hono/node-ws";
import { SessionManager } from "./sessions.js";
import { sessionRoutes } from "./routes/sessions.js";
import { graphRoutes } from "./routes/graph.js";
import { interactRoutes } from "./routes/interact.js";
import { handleWsUpgrade } from "./ws.js";
import type { ServerConfig } from "./types.js";
import { DEFAULT_CONFIG } from "./types.js";

export interface AppContext {
  app: Hono;
  manager: SessionManager;
  injectWebSocket: (server: ServerType) => void;
}

export function createApp(config: Partial<ServerConfig> = {}): AppContext {
  const { maxSessions } = { ...DEFAULT_CONFIG, ...config };
  const manager = new SessionManager(maxSessions);
  const app = new Hono();

  const { injectWebSocket, upgradeWebSocket } = createNodeWebSocket({ app });

  // Request logging
  app.use("*", async (c, next) => {
    const start = Date.now();
    await next();
    const ms = Date.now() - start;
    console.log(`${c.req.method} ${c.req.path} ${c.res.status} ${ms}ms`);
  });

  // Health check
  app.get("/health", (c) => c.json({ status: "ok" }));

  // REST routes
  app.route("/api/sessions", sessionRoutes(manager));
  app.route("/api/sessions/:id/graph", graphRoutes(manager));
  app.route("/api/sessions/:id", interactRoutes(manager));

  // WebSocket route
  app.get(
    "/ws/sessions/:id/graph",
    upgradeWebSocket((c) => ({
      onOpen(_evt, ws) {
        handleWsUpgrade(ws, c.req.param("id"), manager);
      },
    })),
  );

  return { app, manager, injectWebSocket };
}
