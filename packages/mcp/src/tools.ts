/**
 * Veil's MCP tools — the agent-facing interface.
 *
 * The behavior graph is what makes Veil worth exposing to an LLM: instead of
 * raw DOM, an agent gets 50-300 semantic nodes with the API calls each triggers.
 * These tools let an agent open pages, read the graph, act on it, and query it —
 * the same session model as the CLI, in-process.
 *
 * registerVeilTools is separated from the transport so it can be exercised over
 * an in-memory transport in tests without spawning Chrome.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { serializeJGF, serializeCompactText, type InteractAction, type NodeFilter } from "@veil/core";
import { z } from "zod";
import type { SessionPool } from "@veil/core";
import { SessionError } from "./sessions.js";

type TextResult = {
  content: { type: "text"; text: string }[];
  isError?: boolean;
};

function text(s: string): TextResult {
  return { content: [{ type: "text", text: s }] };
}

function errorResult(err: unknown): TextResult {
  const code = err instanceof SessionError ? err.code : "ERROR";
  const message = err instanceof Error ? err.message : String(err);
  return { content: [{ type: "text", text: `[${code}] ${message}` }], isError: true };
}

/** Wrap a tool body so thrown errors become clean MCP error results (an agent
 * reads the text and recovers) rather than protocol-level failures. */
function guard(fn: () => Promise<TextResult>): Promise<TextResult> {
  return fn().catch(errorResult);
}

export function registerVeilTools(server: McpServer, store: SessionPool): void {
  server.registerTool(
    "veil_open",
    {
      title: "Open a page",
      description:
        "Open a URL in a fresh browser tab and return a session id plus the page's " +
        "behavior graph (compact text). Use the session id in the other veil_* tools. " +
        "Sessions persist until veil_close or they go idle.",
      inputSchema: {
        url: z.string().describe("The URL to open (http/https)."),
      },
    },
    ({ url }) =>
      guard(async () => {
        const info = await store.open(url);
        const graph = await store.page(info.id).toCompactText();
        return text(`session: ${info.id}\nurl: ${info.url}\n\n${graph}`);
      }),
  );

  server.registerTool(
    "veil_graph",
    {
      title: "Read the behavior graph",
      description:
        "Return the current behavior graph for a session. format 'compact' (default) " +
        "is the token-efficient text an agent reads; 'json' is JSON Graph Format for " +
        "programmatic use.",
      inputSchema: {
        session: z.string().describe("Session id from veil_open."),
        format: z.enum(["compact", "json"]).optional().describe("compact (default) or json."),
      },
    },
    ({ session, format }) =>
      guard(async () => {
        const page = store.page(session);
        if (format === "json") {
          const graph = await page.getGraph();
          return text(JSON.stringify(serializeJGF(graph), null, 2));
        }
        return text(await page.toCompactText());
      }),
  );

  server.registerTool(
    "veil_do",
    {
      title: "Act on a node",
      description:
        "Perform an interaction on a node (by its display id from the graph) and return " +
        "the updated graph. Actions: click, type (needs text), clear, select (needs value), " +
        "focus, hover. Session state (cookies, DOM, route) persists across calls.",
      inputSchema: {
        session: z.string().describe("Session id."),
        node: z.string().describe("Node display id, e.g. 'button-sign-in'."),
        action: z
          .enum(["click", "type", "clear", "select", "focus", "hover"])
          .describe("The interaction to perform."),
        text: z.string().optional().describe("Text to type (for action=type)."),
        value: z.string().optional().describe("Value to select (for action=select)."),
      },
    },
    ({ session, node, action, text: typeText, value }) =>
      guard(async () => {
        const page = store.page(session);
        let interaction: InteractAction;
        switch (action) {
          case "type":
            if (typeText === undefined)
              throw new SessionError("BAD_ARGS", "action=type requires 'text'.");
            interaction = { action: "type", text: typeText };
            break;
          case "select":
            if (value === undefined)
              throw new SessionError("BAD_ARGS", "action=select requires 'value'.");
            interaction = { action: "select", value };
            break;
          default:
            interaction = { action };
        }
        const graph = await page.interact(node, interaction);
        return text(serializeCompactText(graph));
      }),
  );

  server.registerTool(
    "veil_replay",
    {
      title: "Replay a node's API call directly (fast path)",
      description:
        "Fire the request a node's interaction would trigger DIRECTLY, without " +
        "simulating a click — far faster, and you can edit fields. Only works after " +
        "the interaction has been observed once (veil_do teaches the request); check " +
        "with the node's 'replayable' flag in the graph. Returns the API response. " +
        "Does NOT update the page DOM — read the graph again if you need the new state.",
      inputSchema: {
        session: z.string().describe("Session id."),
        node: z.string().describe("Node display id whose request to replay."),
        body: z.record(z.unknown()).optional().describe("Fields merged into the request body."),
        query: z.record(z.string()).optional().describe("URL query parameters to set."),
        headers: z.record(z.string()).optional().describe("Headers to add/override."),
      },
    },
    ({ session, node, body, query, headers }) =>
      guard(async () => {
        const page = store.page(session);
        const res = await page.replay(node, { body, query, headers });
        return text(
          `${res.status} ${res.statusText}\n` +
            (res.json !== undefined ? JSON.stringify(res.json, null, 2) : res.body.slice(0, 4000)),
        );
      }),
  );

  server.registerTool(
    "veil_query",
    {
      title: "Query nodes",
      description:
        "Find nodes in the current graph by role, name (substring/regex), event type, " +
        "or semantic category/action. Returns matching nodes as JSON. Useful to locate " +
        "the right node id before veil_do without re-reading the whole graph.",
      inputSchema: {
        session: z.string().describe("Session id."),
        role: z.string().optional().describe("ARIA role, e.g. 'button', 'textbox'."),
        name: z.string().optional().describe("Accessible-name substring (case-insensitive)."),
        hasEvent: z.string().optional().describe("Event type the node handles, e.g. 'click'."),
        semanticCategory: z.string().optional().describe("e.g. 'auth', 'search', 'commerce'."),
        semanticAction: z.string().optional().describe("e.g. 'login', 'submit', 'add-to-cart'."),
      },
    },
    ({ session, role, name, hasEvent, semanticCategory, semanticAction }) =>
      guard(async () => {
        const page = store.page(session);
        const filter: NodeFilter = {};
        if (role) filter.role = role;
        if (name) filter.name = name;
        if (hasEvent) filter.hasEvent = hasEvent;
        if (semanticCategory) filter.semanticCategory = semanticCategory;
        if (semanticAction) filter.semanticAction = semanticAction;
        const nodes = await page.query(filter);
        return text(JSON.stringify(nodes, null, 2));
      }),
  );

  server.registerTool(
    "veil_auth",
    {
      title: "Authenticate (human-in-the-loop)",
      description:
        "Open a VISIBLE browser window so the human can log in manually; on completion, " +
        "the session's cookies are carried into the headless session. Use for pages that " +
        "require login before their behavior graph is meaningful.",
      inputSchema: {
        session: z.string().describe("Session id."),
        loginUrl: z.string().optional().describe("Login URL (defaults to the session's current URL)."),
        timeoutSeconds: z.number().int().positive().optional().describe("How long to wait for login."),
      },
    },
    ({ session, loginUrl, timeoutSeconds }) =>
      guard(async () => {
        const result = await store.auth(session, {
          loginUrl,
          timeoutMs: timeoutSeconds ? timeoutSeconds * 1000 : undefined,
        });
        return text(
          result.success
            ? `authenticated — final url: ${result.finalUrl}`
            : `auth did not complete: ${result.finalUrl ?? "(no url)"}`,
        );
      }),
  );

  server.registerTool(
    "veil_sessions",
    {
      title: "List sessions",
      description: "List all open sessions (id, url, age).",
      inputSchema: {},
    },
    () =>
      guard(async () => {
        const sessions = store.list();
        if (sessions.length === 0) return text("(no open sessions)");
        const now = Date.now();
        const lines = sessions.map(
          (s) => `${s.id}  ${s.url}  (${Math.round((now - s.createdAt) / 1000)}s old)`,
        );
        return text(lines.join("\n"));
      }),
  );

  server.registerTool(
    "veil_close",
    {
      title: "Close a session",
      description: "Close a session and its browser tab, freeing a session slot.",
      inputSchema: {
        session: z.string().describe("Session id to close."),
      },
    },
    ({ session }) =>
      guard(async () => {
        store.close(session);
        return text(`closed ${session}`);
      }),
  );
}
