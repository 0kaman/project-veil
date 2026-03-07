import { serve } from "@hono/node-server";
import { createApp } from "./app.js";
import type { VeilConfig } from "@veil/sdk";
import type { ServerConfig } from "./types.js";
import { DEFAULT_CONFIG } from "./types.js";

export { createApp } from "./app.js";
export type { AppContext } from "./app.js";
export { SessionManager } from "./sessions.js";
export type { ServerConfig, SessionInfo, CreateSessionRequest, InteractRequest, NavigateRequest, WsServerMessage, WsClientMessage } from "./types.js";
export { DEFAULT_CONFIG } from "./types.js";

export async function startServer(config: Partial<ServerConfig> = {}): Promise<void> {
  const resolved: ServerConfig = {
    port: Number(process.env.VEIL_PORT) || config.port || DEFAULT_CONFIG.port,
    host: process.env.VEIL_HOST || config.host || DEFAULT_CONFIG.host,
    maxSessions: Number(process.env.VEIL_MAX_SESSIONS) || config.maxSessions || DEFAULT_CONFIG.maxSessions,
  };

  let veilConfig: VeilConfig | undefined;
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (apiKey) {
    veilConfig = { llm: { enabled: true, apiKey } };
  }

  const { app, manager, injectWebSocket } = createApp(resolved, veilConfig);

  const server = serve({
    fetch: app.fetch,
    port: resolved.port,
    hostname: resolved.host,
  }, (info) => {
    console.log(`Veil server listening on http://${resolved.host}:${info.port}`);
  });

  injectWebSocket(server);

  const shutdown = async () => {
    console.log("\nShutting down...");
    await manager.shutdown();
    server.close();
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

// Run as standalone
const isMain = process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/^.*\//, ""));
if (isMain) {
  startServer().catch((err) => {
    console.error("Failed to start server:", err);
    process.exit(1);
  });
}
