#!/usr/bin/env node
/**
 * Veil MCP server — the prime interface.
 *
 * Exposes the ladder to any MCP client (Claude Code, Claude Desktop, an agent
 * runtime, or @veil/playground) over stdio. Two verbs today — veil_search and
 * veil_read — both browserless. The engine verbs land here when @veil/core does.
 *
 *   claude mcp add veil -- node /abs/path/packages/mcp/dist/server.js
 *
 * stdio carries the protocol, so all logging MUST go to stderr, never stdout.
 * Env: BRAVE_API_KEY (search), VEIL_READ_* (read tuning), VEIL_DEBUG.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { Search } from "@veil/search";
import { Reader } from "@veil/read";
import { registerVeilTools } from "./tools.js";

async function main(): Promise<void> {
  const server = new McpServer({ name: "veil", version: "0.1.0" });
  // One Reader for the process, so its handle store persists across tool calls.
  registerVeilTools(server, { search: new Search(), reader: new Reader() });

  process.on("uncaughtException", (err) => {
    process.stderr.write(`veil-mcp uncaught: ${err?.stack ?? err}\n`);
    process.exit(1);
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
  process.stderr.write("veil-mcp: ready (stdio) — search + read\n");
}

main().catch((err) => {
  process.stderr.write(`veil-mcp failed to start: ${err?.stack ?? err}\n`);
  process.exit(1);
});
