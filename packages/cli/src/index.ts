#!/usr/bin/env node

import type {
  InteractAction,
  BehaviorNode,
  DisplayIdRegistry,
} from "@veil/core";
import { ensureDaemon, startDaemon, stopDaemon, daemonStatus } from "./daemon.js";
import { createClient } from "./client.js";
import type { VeilClient } from "./client.js";

const USAGE = `Usage:
  veil open <url>                                   Open URL, print session ID
  veil sessions                                     List active sessions
  veil close <session-id | --all>                  Close session(s)
  veil graph <session-id> [--json]                 Print behavior graph
  veil find <session-id> <query>                   Search nodes
  veil inspect <session-id> <nodeId>               Node detail
  veil do <session-id> <action> <nodeId> [value]   Interact with node
  veil navigate <session-id> <url>                 Navigate within session
  veil auth <session-id> [--url <login-url>] [--timeout <seconds>]  Authenticate
  veil daemon start|stop|status|restart            Manage daemon

Actions:
  click         Click on the node
  type <text>   Type text into the node
  clear         Clear the node's value
  select <val>  Select an option by value
  focus         Focus the node
  hover         Hover over the node`;

// ANSI colors (no chalk dependency)
const CYAN = "\x1b[36m";
const DIM = "\x1b[2m";
const BOLD = "\x1b[1m";
const RESET = "\x1b[0m";

function printInspect(node: BehaviorNode, displayId: string): void {
  console.log(`${BOLD}${displayId}${RESET} ${DIM}(${node.id})${RESET}`);
  console.log(`  role: ${node.role}`);
  if (node.name) console.log(`  name: "${node.name}"`);
  if (node.description) console.log(`  desc: "${node.description}"`);

  const stateEntries = Object.entries(node.state);
  if (stateEntries.length > 0) {
    const stateStr = stateEntries
      .map(([k, v]) => (v === true ? k : `${k}:${v}`))
      .join(", ");
    console.log(`  state: ${stateStr}`);
  }

  if (node.value) console.log(`  value: "${node.value}"`);
  if (node.backendDOMNodeId) console.log(`  domNodeId: ${node.backendDOMNodeId}`);

  if (node.events.length > 0) {
    console.log("  events:");
    for (const ev of node.events) {
      const effect = ev.estimatedEffect ? ` (${ev.estimatedEffect})` : "";
      console.log(`    on:${ev.eventType} → ${ev.category}${effect}`);
    }
  }

  if (node.semanticLabel) {
    const sl = node.semanticLabel;
    console.log(`  semantic: ${sl.category}:${sl.action} (${sl.confidence.toFixed(2)}, ${sl.source})`);
  }

  if (node.componentId) console.log(`  component: ${node.componentId}`);
  if (node.children.length > 0) console.log(`  children: ${node.children.length}`);
}

function printFind(nodes: BehaviorNode[], registry: DisplayIdRegistry): void {
  if (nodes.length === 0) {
    console.log(`${DIM}No matching nodes${RESET}`);
    return;
  }

  for (const node of nodes) {
    const displayId = registry.toDisplay.get(node.id) ?? node.id;
    let line = `  ${CYAN}${displayId}${RESET} [${node.role}]`;
    if (node.name) line += ` "${node.name}"`;
    if (node.value) line += ` ${DIM}value="${node.value}"${RESET}`;
    if (node.events.length > 0) {
      const evts = node.events.map((e) => e.eventType).join(",");
      line += ` ${DIM}events:[${evts}]${RESET}`;
    }
    console.log(line);
  }
  console.log(`${DIM}${nodes.length} node(s) found${RESET}`);
}

// --- Session-based command helpers ---

function normalizeUrl(raw: string): string {
  if (!/^https?:\/\//.test(raw)) return `https://${raw}`;
  return raw;
}

async function resolveSessionId(client: VeilClient, rawId: string): Promise<string> {
  if (rawId.length === 36) return rawId;
  const sessions = await client.listSessions();
  const matches = sessions.filter((s) => s.id.startsWith(rawId));
  if (matches.length === 0) {
    throw new Error(`No session found matching "${rawId}"`);
  }
  if (matches.length > 1) {
    const ids = matches.map((s) => s.id).join("\n  ");
    throw new Error(`Ambiguous session ID "${rawId}". Matches:\n  ${ids}`);
  }
  return matches[0].id;
}

function parseActionArgs(args: string[]): { action: InteractAction; nodeId: string } {
  const actionName = args[0];
  const nodeId = args[1];
  if (!actionName || !nodeId) {
    throw new Error("Usage: veil do <session-id> <action> <nodeId> [value]");
  }

  switch (actionName) {
    case "click":
      return { nodeId, action: { action: "click" } };
    case "type":
      if (!args[2]) throw new Error("type action requires a text value");
      return { nodeId, action: { action: "type", text: args.slice(2).join(" ") } };
    case "clear":
      return { nodeId, action: { action: "clear" } };
    case "select":
      if (!args[2]) throw new Error("select action requires a value");
      return { nodeId, action: { action: "select", value: args[2] } };
    case "focus":
      return { nodeId, action: { action: "focus" } };
    case "hover":
      return { nodeId, action: { action: "hover" } };
    default:
      throw new Error(`Unknown action: ${actionName}`);
  }
}

async function cmdOpen(args: string[]): Promise<void> {
  if (!args[0] || args[0].startsWith("--")) {
    console.error("Error: URL is required\nUsage: veil open <url>");
    process.exit(1);
  }
  const url = normalizeUrl(args[0]);

  console.error("Starting daemon...");
  await ensureDaemon();

  const client = createClient();
  console.error(`Opening ${url}...`);
  const session = await client.openSession(url);
  console.log(session.id);
}

async function cmdSessions(): Promise<void> {
  await ensureDaemon();
  const client = createClient();
  const sessions = await client.listSessions();

  if (sessions.length === 0) {
    console.log("No active sessions");
    return;
  }

  console.log(`${"ID".padEnd(38)}${"URL".padEnd(50)}Created`);
  console.log("-".repeat(100));
  for (const s of sessions) {
    const date = new Date(s.createdAt).toLocaleTimeString();
    console.log(`${s.id.padEnd(38)}${s.url.padEnd(50)}${date}`);
  }
}

async function cmdClose(args: string[]): Promise<void> {
  await ensureDaemon();
  const client = createClient();

  if (args[0] === "--all") {
    await client.closeAllSessions();
    console.error("All sessions closed");
    return;
  }

  if (!args[0]) {
    console.error("Error: session ID or --all required");
    process.exit(1);
  }

  const id = await resolveSessionId(client, args[0]);
  await client.closeSession(id);
  console.error(`Session ${id} closed`);
}

async function cmdGraph(args: string[]): Promise<void> {
  await ensureDaemon();
  const client = createClient();

  if (!args[0]) {
    console.error("Error: session ID required");
    process.exit(1);
  }

  const id = await resolveSessionId(client, args[0]);
  const json = args.includes("--json");

  if (json) {
    const graph = await client.getGraphJSON(id);
    console.log(JSON.stringify(graph, null, 2));
  } else {
    console.log(await client.getGraphCompact(id));
  }
}

async function cmdFind(args: string[]): Promise<void> {
  await ensureDaemon();
  const client = createClient();

  if (!args[0] || !args[1]) {
    console.error("Error: session ID and query required\nUsage: veil find <session-id> <query>");
    process.exit(1);
  }

  const id = await resolveSessionId(client, args[0]);
  const query = args[1];
  const allNodes = await client.getAllNodes(id);

  const seen = new Set<string>();
  const results: BehaviorNode[] = [];

  for (const node of allNodes) {
    if (seen.has(node.id)) continue;
    const matchRole = node.role === query;
    const matchName = node.name?.toLowerCase().includes(query.toLowerCase());
    const matchEvent = node.events.some((e) => e.eventType === query);
    if (matchRole || matchName || matchEvent) {
      seen.add(node.id);
      results.push(node);
    }
  }

  // Build a minimal registry for display
  const registry: DisplayIdRegistry = {
    toDisplay: new Map(results.map((n) => [n.id, n.id])),
    toInternal: new Map(results.map((n) => [n.id, n.id])),
  };
  printFind(results, registry);
}

async function cmdInspectSession(args: string[]): Promise<void> {
  await ensureDaemon();
  const client = createClient();

  if (!args[0] || !args[1]) {
    console.error("Error: session ID and nodeId required\nUsage: veil inspect <session-id> <nodeId>");
    process.exit(1);
  }

  const id = await resolveSessionId(client, args[0]);
  const node = await client.getNode(id, args[1]);
  printInspect(node, args[1]);
}

async function cmdDo(args: string[]): Promise<void> {
  await ensureDaemon();
  const client = createClient();

  if (!args[0]) {
    console.error("Error: session ID required\nUsage: veil do <session-id> <action> <nodeId> [value]");
    process.exit(1);
  }

  const id = await resolveSessionId(client, args[0]);
  const { nodeId, action } = parseActionArgs(args.slice(1));
  const compact = await client.interact(id, nodeId, action);
  console.log(compact);
}

async function cmdAuth(args: string[]): Promise<void> {
  await ensureDaemon();
  const client = createClient();

  if (!args[0]) {
    console.error("Error: session ID required\nUsage: veil auth <session-id> [--url <login-url>] [--timeout <seconds>]");
    process.exit(1);
  }

  const id = await resolveSessionId(client, args[0]);

  let loginUrl: string | undefined;
  let timeoutMs = 120_000;

  for (let i = 1; i < args.length; i++) {
    if (args[i] === "--url" && args[i + 1]) {
      loginUrl = normalizeUrl(args[++i]);
    } else if (args[i] === "--timeout" && args[i + 1]) {
      const secs = parseInt(args[++i], 10);
      if (Number.isNaN(secs) || secs <= 0) {
        throw new Error("--timeout must be a positive number of seconds");
      }
      timeoutMs = secs * 1000;
    }
  }

  console.error("Opening visible browser for login...");
  console.error("Log in manually, then the browser will detect completion automatically.");

  const result = await client.auth(id, { loginUrl, timeoutMs });

  if (result.success) {
    console.log(`Auth successful! ${result.cookieCount} cookies captured.`);
  } else {
    console.log(`Auth incomplete. ${result.cookieCount} cookies captured (partial).`);
  }
}

async function cmdNavigate(args: string[]): Promise<void> {
  await ensureDaemon();
  const client = createClient();

  if (!args[0] || !args[1]) {
    console.error("Error: session ID and URL required\nUsage: veil navigate <session-id> <url>");
    process.exit(1);
  }

  const id = await resolveSessionId(client, args[0]);
  const url = normalizeUrl(args[1]);
  const compact = await client.navigate(id, url);
  console.log(compact);
}

async function cmdDaemon(args: string[]): Promise<void> {
  const sub = args[0];
  switch (sub) {
    case "start":
      await startDaemon();
      console.log(`Daemon started at ${(await daemonStatus()).socket}`);
      break;
    case "stop":
      await stopDaemon();
      console.log("Daemon stopped");
      break;
    case "status": {
      const s = await daemonStatus();
      if (s.running) {
        console.log(`running at ${s.socket}, PID ${s.pid}`);
      } else {
        console.log("not running");
      }
      break;
    }
    case "restart":
      try { await stopDaemon(); } catch {}
      await startDaemon();
      console.log(`Daemon restarted at ${(await daemonStatus()).socket}`);
      break;
    default:
      console.error("Usage: veil daemon start|stop|status|restart");
      process.exit(1);
  }
}

const SESSION_COMMANDS = new Set([
  "open", "sessions", "close", "graph", "find", "inspect", "do", "navigate", "auth", "daemon",
]);

async function main(): Promise<void> {
  const args = process.argv.slice(2);

  if (args.length === 0 || args[0] === "--help" || args[0] === "-h") {
    console.log(USAGE);
    process.exit(0);
  }

  const command = args[0];
  const commandArgs = args.slice(1);

  // Session-based commands
  if (SESSION_COMMANDS.has(command)) {
    try {
      switch (command) {
        case "open": await cmdOpen(commandArgs); break;
        case "sessions": await cmdSessions(); break;
        case "close": await cmdClose(commandArgs); break;
        case "graph": await cmdGraph(commandArgs); break;
        case "find": await cmdFind(commandArgs); break;
        case "inspect": await cmdInspectSession(commandArgs); break;
        case "do": await cmdDo(commandArgs); break;
        case "navigate": await cmdNavigate(commandArgs); break;
        case "auth": await cmdAuth(commandArgs); break;
        case "daemon": await cmdDaemon(commandArgs); break;
      }
    } catch (err) {
      console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    }
    return;
  }

  console.error(`Unknown command: ${command}\n`);
  console.error(USAGE);
  process.exit(1);
}

main();
