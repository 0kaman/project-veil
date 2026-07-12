#!/usr/bin/env node

import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import {
  Veil,
  serializeCompactText,
  serializeJGF,
  buildDisplayIdRegistry,
  queryNodes,
} from "@veil/core";
import type {
  InteractAction,
  VeilPage,
  BehaviorNode,
  BehaviorGraph,
  GraphDiff,
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

Legacy (one-shot, no session persistence):
  veil decompose <url> [--timeout N] [--json]
  veil interact <url> <nodeId> <action> [value]
  veil shell <url> [--json]

Actions:
  click         Click on the node
  type <text>   Type text into the node
  clear         Clear the node's value
  select <val>  Select an option by value
  focus         Focus the node
  hover         Hover over the node`;

const SHELL_HELP = `Shell commands:
  graph                   Print full behavior graph (compact text)
  json                    Print full behavior graph (JSON Graph Format)
  click <nodeId>          Click on a node
  type <nodeId> <text>    Type text into a node
  clear <nodeId>          Clear a node's value
  select <nodeId> <val>   Select an option by value
  focus <nodeId>          Focus a node
  hover <nodeId>          Hover over a node
  inspect <nodeId>        Show detailed info for a node
  find <query>            Search nodes by role, name, or event type
  navigate <url>          Navigate to a new URL
  auth                    Open visible browser to log in manually
  url                     Print current URL and page title
  help                    Show this help
  exit                    Exit the shell (also Ctrl+C / Ctrl+D)`;

const INTERACTION_COMMANDS = new Set([
  "click", "type", "clear", "select", "focus", "hover", "inspect",
]);

const ALL_COMMANDS = [
  "graph", "json", "click", "type", "clear", "select",
  "focus", "hover", "inspect", "find", "navigate", "auth", "url", "help", "exit",
];

// ANSI colors (no chalk dependency)
const RED = "\x1b[31m";
const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
const CYAN = "\x1b[36m";
const DIM = "\x1b[2m";
const BOLD = "\x1b[1m";
const RESET = "\x1b[0m";

interface ShellState {
  veil: Veil;
  page: VeilPage;
  url: string;
  displayIds: string[];
  registry: DisplayIdRegistry;
  jsonMode: boolean;
}

function parseDecomposeArgs(args: string[]): {
  url: string;
  timeout: number;
  json: boolean;
} {
  if (!args[0] || args[0].startsWith("--")) {
    console.error("Error: URL is required\n");
    console.error(USAGE);
    process.exit(1);
  }

  let url = args[0];
  if (!/^https?:\/\//.test(url)) {
    url = `https://${url}`;
  }

  let timeout = 30;
  let json = false;

  for (let i = 1; i < args.length; i++) {
    if (args[i] === "--json") {
      json = true;
    } else if (args[i] === "--timeout" && args[i + 1]) {
      timeout = parseInt(args[i + 1], 10);
      if (isNaN(timeout) || timeout <= 0) {
        console.error("Error: --timeout must be a positive number");
        process.exit(1);
      }
      i++;
    } else {
      console.error(`Unknown option: ${args[i]}\n`);
      console.error(USAGE);
      process.exit(1);
    }
  }

  return { url, timeout, json };
}

function parseInteractArgs(args: string[]): {
  url: string;
  nodeId: string;
  action: InteractAction;
} {
  if (args.length < 3) {
    console.error("Error: interact requires <url> <nodeId> <action> [value]\n");
    console.error(USAGE);
    process.exit(1);
  }

  let url = args[0];
  if (!/^https?:\/\//.test(url)) {
    url = `https://${url}`;
  }

  const nodeId = args[1];
  const actionName = args[2];

  let action: InteractAction;
  switch (actionName) {
    case "click":
      action = { action: "click" };
      break;
    case "type":
      if (!args[3]) {
        console.error("Error: type action requires a text value\n");
        console.error(USAGE);
        process.exit(1);
      }
      action = { action: "type", text: args[3] };
      break;
    case "clear":
      action = { action: "clear" };
      break;
    case "select":
      if (!args[3]) {
        console.error("Error: select action requires a value\n");
        console.error(USAGE);
        process.exit(1);
      }
      action = { action: "select", value: args[3] };
      break;
    case "focus":
      action = { action: "focus" };
      break;
    case "hover":
      action = { action: "hover" };
      break;
    default:
      console.error(`Unknown action: ${actionName}\n`);
      console.error(USAGE);
      process.exit(1);
  }

  return { url, nodeId, action };
}

function parseShellArgs(args: string[]): {
  url: string;
  json: boolean;
} {
  if (!args[0] || args[0].startsWith("--")) {
    console.error("Error: URL is required\n");
    console.error(USAGE);
    process.exit(1);
  }

  let url = args[0];
  if (!/^https?:\/\//.test(url)) {
    url = `https://${url}`;
  }

  let json = false;

  for (let i = 1; i < args.length; i++) {
    if (args[i] === "--json") {
      json = true;
    } else {
      console.error(`Unknown option: ${args[i]}\n`);
      console.error(USAGE);
      process.exit(1);
    }
  }

  return { url, json };
}

function shortUrl(url: string): string {
  try {
    const u = new URL(url);
    return u.hostname + (u.pathname !== "/" ? u.pathname : "");
  } catch {
    return url;
  }
}

function refreshDisplayIds(state: ShellState, graph: BehaviorGraph): void {
  state.registry = buildDisplayIdRegistry(graph);
  state.displayIds = [...state.registry.toInternal.keys()];
}

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

async function executeCommand(
  line: string,
  state: ShellState,
): Promise<boolean> {
  const trimmed = line.trim();
  if (!trimmed) return true;

  const spaceIdx = trimmed.indexOf(" ");
  const cmd = spaceIdx === -1 ? trimmed : trimmed.slice(0, spaceIdx);
  const rest = spaceIdx === -1 ? "" : trimmed.slice(spaceIdx + 1).trim();

  switch (cmd) {
    case "exit":
    case "quit":
      return false;

    case "help":
      console.log(SHELL_HELP);
      break;

    case "url": {
      const graph = await state.page.getGraph();
      console.log(`${BOLD}${graph.metadata.url}${RESET}`);
      console.log(`  "${graph.metadata.title}"`);
      break;
    }

    case "graph": {
      const text = await state.page.toCompactText();
      console.log(text);
      break;
    }

    case "json": {
      const jgf = await state.page.toJSON();
      console.log(JSON.stringify(jgf, null, 2));
      break;
    }

    case "click": {
      if (!rest) { console.error(`${RED}Usage: click <nodeId>${RESET}`); break; }
      const newGraph = await state.page.interact(rest, { action: "click" });
      refreshDisplayIds(state, newGraph);
      state.url = newGraph.metadata.url;
      if (state.jsonMode) {
        console.log(JSON.stringify(serializeJGF(newGraph), null, 2));
      } else {
        console.log(serializeCompactText(newGraph));
      }
      break;
    }

    case "type": {
      const typeSpace = rest.indexOf(" ");
      if (typeSpace === -1) {
        console.error(`${RED}Usage: type <nodeId> <text>${RESET}`);
        break;
      }
      const nodeId = rest.slice(0, typeSpace);
      const text = rest.slice(typeSpace + 1);
      const newGraph = await state.page.interact(nodeId, { action: "type", text });
      refreshDisplayIds(state, newGraph);
      state.url = newGraph.metadata.url;
      if (state.jsonMode) {
        console.log(JSON.stringify(serializeJGF(newGraph), null, 2));
      } else {
        console.log(serializeCompactText(newGraph));
      }
      break;
    }

    case "clear": {
      if (!rest) { console.error(`${RED}Usage: clear <nodeId>${RESET}`); break; }
      const newGraph = await state.page.interact(rest, { action: "clear" });
      refreshDisplayIds(state, newGraph);
      state.url = newGraph.metadata.url;
      if (state.jsonMode) {
        console.log(JSON.stringify(serializeJGF(newGraph), null, 2));
      } else {
        console.log(serializeCompactText(newGraph));
      }
      break;
    }

    case "select": {
      const selSpace = rest.indexOf(" ");
      if (selSpace === -1) {
        console.error(`${RED}Usage: select <nodeId> <value>${RESET}`);
        break;
      }
      const nodeId = rest.slice(0, selSpace);
      const value = rest.slice(selSpace + 1);
      const newGraph = await state.page.interact(nodeId, { action: "select", value });
      refreshDisplayIds(state, newGraph);
      state.url = newGraph.metadata.url;
      if (state.jsonMode) {
        console.log(JSON.stringify(serializeJGF(newGraph), null, 2));
      } else {
        console.log(serializeCompactText(newGraph));
      }
      break;
    }

    case "focus": {
      if (!rest) { console.error(`${RED}Usage: focus <nodeId>${RESET}`); break; }
      const newGraph = await state.page.interact(rest, { action: "focus" });
      refreshDisplayIds(state, newGraph);
      state.url = newGraph.metadata.url;
      if (state.jsonMode) {
        console.log(JSON.stringify(serializeJGF(newGraph), null, 2));
      } else {
        console.log(serializeCompactText(newGraph));
      }
      break;
    }

    case "hover": {
      if (!rest) { console.error(`${RED}Usage: hover <nodeId>${RESET}`); break; }
      const newGraph = await state.page.interact(rest, { action: "hover" });
      refreshDisplayIds(state, newGraph);
      state.url = newGraph.metadata.url;
      if (state.jsonMode) {
        console.log(JSON.stringify(serializeJGF(newGraph), null, 2));
      } else {
        console.log(serializeCompactText(newGraph));
      }
      break;
    }

    case "inspect": {
      if (!rest) { console.error(`${RED}Usage: inspect <nodeId>${RESET}`); break; }
      const node = await state.page.getNode(rest);
      if (!node) {
        console.error(`${RED}Node "${rest}" not found${RESET}`);
        break;
      }
      const displayId = state.registry.toDisplay.get(node.id) ?? rest;
      printInspect(node, displayId);
      break;
    }

    case "find": {
      if (!rest) { console.error(`${RED}Usage: find <role|name|event>${RESET}`); break; }
      const graph = await state.page.getGraph();
      // Try matching as role, name substring, or event type
      const byRole = queryNodes(graph, { role: rest });
      const byName = queryNodes(graph, { name: new RegExp(rest, "i") });
      const byEvent = queryNodes(graph, { hasEvent: rest });
      // Deduplicate by node id
      const seen = new Set<string>();
      const results: BehaviorNode[] = [];
      for (const node of [...byRole, ...byName, ...byEvent]) {
        if (!seen.has(node.id)) {
          seen.add(node.id);
          results.push(node);
        }
      }
      printFind(results, state.registry);
      break;
    }

    case "auth": {
      console.log(`${DIM}Opening visible browser for login...${RESET}`);
      console.log(`${YELLOW}Log in manually in the browser window, then press Enter here when done.${RESET}`);
      const manualSignal = new Promise<void>((resolve) => {
        const onLine = () => {
          process.stdin.off("data", onLine);
          resolve();
        };
        process.stdin.on("data", onLine);
      });
      try {
        const result = await state.veil.auth(state.page, { manualSignal });
        if (result.success) {
          console.log(`${GREEN}Auth successful!${RESET} ${result.cookieCount} cookies captured.`);
          const graph = await state.page.getGraph();
          refreshDisplayIds(state, graph);
          state.url = graph.metadata.url;
          console.log(`${DIM}Page: "${graph.metadata.title}" — ${graph.nodes.size} nodes${RESET}`);
        } else {
          console.log(`${YELLOW}Auth incomplete.${RESET} ${result.cookieCount} cookies captured (partial).`);
        }
      } catch (err) {
        console.error(`${RED}Auth failed: ${err instanceof Error ? err.message : String(err)}${RESET}`);
      }
      break;
    }

    case "navigate": {
      if (!rest) { console.error(`${RED}Usage: navigate <url>${RESET}`); break; }
      let newUrl = rest;
      if (!/^https?:\/\//.test(newUrl)) {
        newUrl = `https://${newUrl}`;
      }
      state.page.close();
      state.page = await state.veil.open(newUrl);
      console.log(`${DIM}Navigating to ${newUrl}...${RESET}`);
      const graph = await state.page.getGraph();
      state.url = graph.metadata.url;
      refreshDisplayIds(state, graph);
      // Re-register graph change listener
      registerGraphChangeListener(state);
      console.log(`${GREEN}Loaded:${RESET} ${graph.metadata.url} — "${graph.metadata.title}"`);
      console.log(`${DIM}${graph.nodes.size} nodes${RESET}`);
      break;
    }

    default:
      console.error(`${RED}Unknown command: ${cmd}${RESET}`);
      console.log(`Type ${BOLD}help${RESET} for available commands`);
  }

  return true;
}

function registerGraphChangeListener(state: ShellState): void {
  state.page.onGraphChange((_graph: BehaviorGraph, diff: GraphDiff) => {
    refreshDisplayIds(state, _graph);
    state.url = _graph.metadata.url;

    const parts: string[] = [];
    if (diff.added.length > 0) parts.push(`${GREEN}+${diff.added.length} added${RESET}`);
    if (diff.removed.length > 0) parts.push(`${RED}-${diff.removed.length} removed${RESET}`);
    if (diff.modified.length > 0) parts.push(`${YELLOW}~${diff.modified.length} modified${RESET}`);
    if (parts.length > 0) {
      console.log(`\n  ${DIM}[graph updated]${RESET} ${parts.join(", ")}`);
    }
  });
}

async function runShell(url: string, jsonMode = false): Promise<void> {
  const veil = new Veil();

  console.log(`${DIM}Launching browser...${RESET}`);
  const page = await veil.open(url);

  console.log(`${DIM}Building behavior graph...${RESET}`);
  const graph = await page.getGraph();

  const registry = buildDisplayIdRegistry(graph);
  const state: ShellState = {
    veil,
    page,
    url: graph.metadata.url,
    displayIds: [...registry.toInternal.keys()],
    registry,
    jsonMode,
  };

  // Live graph change notifications
  registerGraphChangeListener(state);

  console.log(`${GREEN}Ready:${RESET} ${graph.metadata.url} — "${graph.metadata.title}"`);
  console.log(`${DIM}${graph.nodes.size} nodes | Type "help" for commands, "exit" to quit${RESET}`);
  console.log();

  // Tab completer
  const completer = (line: string): [string[], string] => {
    const trimmed = line.trimStart();
    const spaceIdx = trimmed.indexOf(" ");

    if (spaceIdx === -1) {
      // Completing command name
      const hits = ALL_COMMANDS.filter((c) => c.startsWith(trimmed));
      return [hits.length > 0 ? hits : ALL_COMMANDS, trimmed];
    }

    const cmd = trimmed.slice(0, spaceIdx);
    const partial = trimmed.slice(spaceIdx + 1).trim();

    // For second token on interaction commands + inspect, complete node IDs
    if (INTERACTION_COMMANDS.has(cmd) || cmd === "find") {
      // Don't complete if we already have a nodeId and are in the text portion (type/select)
      const hasSecondSpace = partial.indexOf(" ") !== -1;
      if (hasSecondSpace && (cmd === "type" || cmd === "select")) {
        return [[], line];
      }

      const hits = state.displayIds.filter((id) => id.startsWith(partial));
      return [hits, partial];
    }

    return [[], line];
  };

  const rl = createInterface({
    input: stdin,
    output: stdout,
    completer,
    terminal: true,
  });

  const promptStr = () => `${DIM}[${shortUrl(state.url)}]${RESET} ${BOLD}>${RESET} `;

  try {
    let running = true;
    while (running) {
      let line: string;
      try {
        line = await rl.question(promptStr());
      } catch {
        // Ctrl+D or readline error
        break;
      }

      try {
        running = await executeCommand(line, state);
      } catch (err) {
        console.error(
          `${RED}Error: ${err instanceof Error ? err.message : String(err)}${RESET}`,
        );
      }
    }
  } finally {
    rl.close();
    console.log(`\n${DIM}Closing browser...${RESET}`);
    state.page.close();
    await veil.close();
  }
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

  // Legacy commands
  if (command !== "decompose" && command !== "interact" && command !== "shell") {
    console.error(`Unknown command: ${command}\n`);
    console.error(USAGE);
    process.exit(1);
  }

  if (command === "shell") {
    const { url, json } = parseShellArgs(commandArgs);
    await runShell(url, json);
    return;
  }

  const veil = new Veil();

  const cleanup = async () => {
    await veil.close();
    process.exit(0);
  };
  process.on("SIGINT", cleanup);
  process.on("SIGTERM", cleanup);

  try {
    if (command === "decompose") {
      const { url, json } = parseDecomposeArgs(commandArgs);
      const page = await veil.open(url);

      if (json) {
        const graph = await page.getGraph();
        console.log(JSON.stringify(serializeJGF(graph), null, 2));
      } else {
        const graph = await page.getGraph();
        console.log(serializeCompactText(graph));
      }

      page.close();
    } else {
      const { url, nodeId, action } = parseInteractArgs(commandArgs);
      const page = await veil.open(url);

      console.error(`Interacting: ${action.action} on "${nodeId}"...`);
      const newGraph = await page.interact(nodeId, action);
      console.log(serializeCompactText(newGraph));

      page.close();
    }
  } catch (err) {
    console.error(
      `Error: ${err instanceof Error ? err.message : String(err)}`,
    );
    process.exit(1);
  } finally {
    await veil.close();
  }
}

main();
