#!/usr/bin/env node
/**
 * Veil MCP server — the prime interface.
 *
 * Exposes Veil's behavior-graph browser to any MCP client (Claude Code, Claude
 * Desktop, or an agent runtime) over stdio. One shared Chrome; each veil_open is
 * an isolated tab.
 *
 *   Claude Code:   claude mcp add veil -- node /abs/path/packages/mcp/dist/server.js
 *   Config JSON:   { "command": "node", "args": ["/abs/.../dist/server.js"] }
 *
 * Env: VEIL_MAX_SESSIONS, VEIL_SESSION_TTL_MS, CHROME_PATH, VEIL_DEBUG.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { SessionStore } from "./sessions.js";
import { registerVeilTools } from "./tools.js";

async function main(): Promise<void> {
  const store = new SessionStore();
  const server = new McpServer({ name: "veil", version: "0.1.0" });
  registerVeilTools(server, store);

  // stdio carries the protocol — logs MUST go to stderr, never stdout.
  const shutdown = async () => {
    await store.shutdown().catch(() => {});
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  process.on("uncaughtException", async (err) => {
    process.stderr.write(`veil-mcp uncaught: ${err?.stack ?? err}\n`);
    await store.shutdown().catch(() => {});
    process.exit(1);
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
  process.stderr.write("veil-mcp: ready (stdio)\n");
}

main().catch((err) => {
  process.stderr.write(`veil-mcp failed to start: ${err?.stack ?? err}\n`);
  process.exit(1);
});
