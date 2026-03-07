#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { SessionManager } from "@veil/server";
import type { VeilConfig } from "@veil/core";
import { registerTools } from "./tools.js";

const server = new McpServer({
  name: "veil",
  version: "0.1.0",
});

// Build VeilConfig from env
let veilConfig: VeilConfig | undefined;
const apiKey = process.env.ANTHROPIC_API_KEY;
if (apiKey) {
  veilConfig = { llm: { enabled: true, apiKey } };
}

const maxSessions = Number(process.env.VEIL_MAX_SESSIONS) || 10;
const manager = new SessionManager(maxSessions, veilConfig);

registerTools(server, manager);

// Graceful shutdown
const shutdown = async () => {
  await manager.shutdown();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

// Connect via stdio
const transport = new StdioServerTransport();
await server.connect(transport);
