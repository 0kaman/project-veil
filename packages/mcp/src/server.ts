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
import { Renderer, SessionPool } from "@veil/core";
import { registerVeilTools } from "./tools.js";

async function main(): Promise<void> {
  const server = new McpServer({ name: "veil", version: "0.1.0" });

  // The engine, injected into the read tier: when a fetch hits a js-shell or
  // doorman, the Reader escalates to a real browser render. One Renderer for the
  // process (Chrome launched lazily on first escalation, held open); one Reader
  // so its handle store persists across tool calls.
  const renderer = new Renderer();
  const reader = new Reader({ renderer: (url: string) => renderer.render(url) });

  // The act path. Its own pool (and its own browser) so a burst of read
  // escalations can't evict an agent's live session — different lifetimes.
  const sessions = new SessionPool();

  registerVeilTools(server, { search: new Search(), reader, sessions });

  // Idempotent: stdin EOF and a signal can both arrive, and reaping twice
  // races the browser teardown.
  let closing = false;
  const shutdown = async () => {
    if (closing) return;
    closing = true;
    await Promise.allSettled([renderer.close(), sessions.shutdown()]);
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  process.on("SIGHUP", shutdown);

  // THE TRANSPORT IS STDIN. When it ends, the client is gone and this process
  // has nothing left to serve — so it must reap its browsers and exit.
  //
  // Signals are not enough, and the arena proved it at scale. A client that
  // disconnects without sending one — `docker exec -i` dropping its pipe, a
  // client killed with SIGKILL, a crashed parent — leaves stdin at EOF and no
  // signal at all. Measured: 80 benchmark runs left 80 orphaned node processes
  // holding 462 Chromium processes and 7.1 GiB of the container's 7.7 GiB, at
  // which point Chrome could no longer start and three tasks failed with
  // "browser launch timed out" — read as capability failures until the
  // container was inspected. ~900 MB leaked per disconnect.
  process.stdin.on("end", shutdown);
  process.stdin.on("close", shutdown);
  process.on("uncaughtException", (err) => {
    process.stderr.write(`veil-mcp uncaught: ${err?.stack ?? err}\n`);
    // Reap BOTH browsers — Chrome is a non-detached child, so a crash that
    // skipped this would orphan it forever (a v1 scar).
    void Promise.allSettled([renderer.close(), sessions.shutdown()]).finally(() => process.exit(1));
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
  process.stderr.write("veil-mcp: ready (stdio) — search · read (render escalation) · open/query (act)\n");
}

main().catch((err) => {
  process.stderr.write(`veil-mcp failed to start: ${err?.stack ?? err}\n`);
  process.exit(1);
});
