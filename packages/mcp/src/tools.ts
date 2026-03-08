import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { SessionManager } from "@veil/server";
import type { InteractAction, BehaviorNode } from "@veil/core";
import { resolveSessionId } from "./session-resolver.js";

function textResult(text: string) {
  return { content: [{ type: "text" as const, text }] };
}

function errorResult(err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
  return { isError: true, content: [{ type: "text" as const, text: `Error: ${message}` }] };
}

function normalizeUrl(url: string): string {
  if (!/^https?:\/\//i.test(url)) {
    return `https://${url}`;
  }
  return url;
}

function buildInteractAction(action: string, value?: string): InteractAction {
  switch (action) {
    case "click":
      return { action: "click" };
    case "type":
      if (!value) throw new Error('Action "type" requires a value');
      return { action: "type", text: value };
    case "clear":
      return { action: "clear" };
    case "select":
      if (!value) throw new Error('Action "select" requires a value');
      return { action: "select", value };
    case "focus":
      return { action: "focus" };
    case "hover":
      return { action: "hover" };
    default:
      throw new Error(`Unknown action: ${action}`);
  }
}

function formatNode(node: BehaviorNode): string {
  const lines: string[] = [];
  lines.push(`${node.role}: "${node.name}"`);
  if (node.description) lines.push(`  description: ${node.description}`);
  if (node.value) lines.push(`  value: ${node.value}`);

  const stateEntries = Object.entries(node.state);
  if (stateEntries.length > 0) {
    lines.push(`  state: ${stateEntries.map(([k, v]) => `${k}=${v}`).join(", ")}`);
  }

  if (node.events.length > 0) {
    for (const evt of node.events) {
      let line = `  on:${evt.eventType} → ${evt.category}`;
      if (evt.estimatedEffect) line += ` (${evt.estimatedEffect})`;
      lines.push(line);
    }
  }

  if (node.semanticLabel) {
    const sl = node.semanticLabel;
    lines.push(`  semantic: ${sl.category}:${sl.action} (${sl.confidence.toFixed(2)}, ${sl.source})`);
  }

  if (node.componentId) {
    lines.push(`  component: ${node.componentId}`);
  }

  return lines.join("\n");
}

export function registerTools(server: McpServer, manager: SessionManager): void {
  // veil_open
  server.tool(
    "veil_open",
    "Open a URL in a new browser session and get its behavior graph summary",
    { url: z.string().describe("URL to open") },
    async ({ url }) => {
      try {
        const normalizedUrl = normalizeUrl(url);
        const session = await manager.createSession(normalizedUrl);
        const page = manager.getPage(session.id);
        const graph = await page.getGraph();

        return textResult(
          `Session: ${session.id}\nPage: "${graph.metadata.title}" (${new URL(graph.metadata.url).hostname})\nNodes: ${graph.nodes.size}`,
        );
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  // veil_graph
  server.tool(
    "veil_graph",
    "Get the behavior graph for a session — the primary tool for understanding what a page does",
    {
      session_id: z.string().describe("Session ID or prefix"),
      format: z
        .enum(["compact", "json"])
        .optional()
        .default("compact")
        .describe("Output format: compact text (LLM-friendly) or full JSON"),
    },
    async ({ session_id, format }) => {
      try {
        const id = resolveSessionId(manager, session_id);
        const page = manager.getPage(id);

        if (format === "json") {
          const json = await page.toJSON();
          return textResult(JSON.stringify(json, null, 2));
        }

        const text = await page.toCompactText();
        return textResult(text);
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  // veil_interact
  server.tool(
    "veil_interact",
    "Perform an action on a page element (click, type, select, etc.). Returns a summary — use veil_graph for the full updated graph.",
    {
      session_id: z.string().describe("Session ID or prefix"),
      node_id: z.string().describe('Display ID of the node (e.g. "button-sign-in")'),
      action: z
        .enum(["click", "type", "clear", "select", "focus", "hover"])
        .describe("Action to perform"),
      value: z
        .string()
        .optional()
        .describe("Text for type action, value for select action"),
    },
    async ({ session_id, node_id, action, value }) => {
      try {
        const id = resolveSessionId(manager, session_id);
        const page = manager.getPage(id);
        const interactAction = buildInteractAction(action, value);
        const graph = await page.interact(node_id, interactAction);
        const hostname = new URL(graph.metadata.url).hostname;
        const valueDesc = value ? ` "${value}"` : "";
        return textResult(
          `Done: ${action}${valueDesc} on "${node_id}"\nPage: "${graph.metadata.title}" (${hostname})\nURL: ${graph.metadata.url}\nNodes: ${graph.nodes.size}`,
        );
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  // veil_navigate
  server.tool(
    "veil_navigate",
    "Navigate an existing session to a new URL. Returns a summary — use veil_graph for the full updated graph.",
    {
      session_id: z.string().describe("Session ID or prefix"),
      url: z.string().describe("New URL to navigate to"),
    },
    async ({ session_id, url }) => {
      try {
        const id = resolveSessionId(manager, session_id);
        const normalizedUrl = normalizeUrl(url);
        await manager.navigateSession(id, normalizedUrl);
        const page = manager.getPage(id);
        const graph = await page.getGraph();
        const hostname = new URL(graph.metadata.url).hostname;
        return textResult(
          `Navigated: ${graph.metadata.url}\nPage: "${graph.metadata.title}" (${hostname})\nNodes: ${graph.nodes.size}`,
        );
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  // veil_find
  server.tool(
    "veil_find",
    "Search for nodes by role, name substring, or event type",
    {
      session_id: z.string().describe("Session ID or prefix"),
      query: z.string().describe("Search term (matches role, name, or event type)"),
    },
    async ({ session_id, query }) => {
      try {
        const id = resolveSessionId(manager, session_id);
        const page = manager.getPage(id);
        const graph = await page.getGraph();

        const seen = new Set<string>();
        const results: BehaviorNode[] = [];

        for (const node of graph.nodes.values()) {
          if (seen.has(node.id)) continue;
          const matchRole = node.role === query;
          const matchName = node.name
            ?.toLowerCase()
            .includes(query.toLowerCase());
          const matchEvent = node.events.some((e) => e.eventType === query);
          if (matchRole || matchName || matchEvent) {
            seen.add(node.id);
            results.push(node);
          }
        }

        if (results.length === 0) {
          return textResult(`No nodes matching "${query}"`);
        }

        const lines = results.map(
          (n) => formatNode(n),
        );
        return textResult(`Found ${results.length} node(s):\n\n${lines.join("\n\n")}`);
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  // veil_inspect
  server.tool(
    "veil_inspect",
    "Get detailed information about a specific node",
    {
      session_id: z.string().describe("Session ID or prefix"),
      node_id: z.string().describe("Display ID of the node"),
    },
    async ({ session_id, node_id }) => {
      try {
        const id = resolveSessionId(manager, session_id);
        const page = manager.getPage(id);
        const node = await page.getNode(node_id);

        if (!node) {
          return errorResult(new Error(`Node "${node_id}" not found`));
        }

        return textResult(formatNode(node));
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  // veil_sessions
  server.tool(
    "veil_sessions",
    "List all active browser sessions",
    {},
    async () => {
      try {
        const sessions = manager.listSessions();

        if (sessions.length === 0) {
          return textResult("No active sessions");
        }

        const lines = sessions.map((s) => {
          const age = Math.round((Date.now() - s.createdAt) / 1000);
          return `${s.id}  ${s.url}  (${age}s ago)`;
        });
        return textResult(lines.join("\n"));
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  // veil_auth
  server.tool(
    "veil_auth",
    "Open a visible browser for the user to log in manually. Use when a page requires authentication (e.g. login form, 401, redirect to sign-in).",
    {
      session_id: z.string().describe("Session ID or prefix"),
      login_url: z
        .string()
        .optional()
        .describe("Login URL. Defaults to the session's current page."),
      timeout_seconds: z
        .number()
        .optional()
        .default(120)
        .describe("Max seconds to wait for user to complete login"),
    },
    async ({ session_id, login_url, timeout_seconds }) => {
      try {
        const id = resolveSessionId(manager, session_id);
        const result = await manager.authSession(id, {
          loginUrl: login_url,
          timeoutMs: (timeout_seconds ?? 120) * 1000,
        });

        if (result.success) {
          const page = manager.getPage(id);
          const graph = await page.getGraph();
          return textResult(
            `Auth successful! ${result.cookieCount} cookies captured.\nPage: "${graph.metadata.title}" (${new URL(graph.metadata.url).hostname})\nNodes: ${graph.nodes.size}`,
          );
        }

        return textResult(
          `Auth incomplete. ${result.cookieCount} cookies captured (partial).\nLast URL: ${result.finalUrl}`,
        );
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  // veil_close
  server.tool(
    "veil_close",
    "Close a browser session, or all sessions if no ID given",
    {
      session_id: z
        .string()
        .optional()
        .describe("Session ID or prefix. Omit to close all sessions."),
    },
    async ({ session_id }) => {
      try {
        if (session_id) {
          const id = resolveSessionId(manager, session_id);
          manager.closeSession(id);
          return textResult(`Closed session ${id}`);
        }

        const sessions = manager.listSessions();
        for (const s of sessions) {
          manager.closeSession(s.id);
        }
        return textResult(`Closed ${sessions.length} session(s)`);
      } catch (err) {
        return errorResult(err);
      }
    },
  );

}
