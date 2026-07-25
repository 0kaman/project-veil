/**
 * Veil's MCP tools — the agent-facing surface, and the ROUTER.
 *
 * There is no separate intent classifier: the descriptions ARE the routing
 * logic. The model reads them and picks. So they are written as signposts —
 * "USE THIS FIRST", "boots nothing", "only when you must act" — not as reference
 * docs. v1 shipped 8 tools and the model never used the one it should have,
 * because nothing told it which came first.
 *
 * registerVeilTools is separated from the transport so it can be exercised over
 * an in-memory transport in tests — the real protocol path, no stdio process.
 *
 * Two verbs today (search, read). The engine verbs (open/query/do/replay) slot
 * in here unchanged when @veil/core lands.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Search } from "@veil/search";
import type { Reader } from "@veil/read";
import type { SessionPool } from "@veil/core";
import { renderSearch, renderRead, renderPull, renderOpen, renderQuery, renderSessions } from "./format.js";

export interface VeilDeps {
  search: Search;
  reader: Reader;
  /** The act path. Omitted → veil_open/query/sessions/close are not registered,
   * so the model never sees tools it can't use ("the surface IS the router"). */
  sessions?: SessionPool;
}

interface TextResult {
  // The SDK's CallToolResult carries an index signature; mirror it so our helper
  // return type is assignable to the tool-callback contract.
  [x: string]: unknown;
  content: { type: "text"; text: string }[];
  isError?: boolean;
}

function text(s: string): TextResult {
  return { content: [{ type: "text", text: s }] };
}

/** Turn a thrown error into a clean MCP result the agent can read and recover
 * from — never a protocol-level failure. (v1 lesson, carried forward.) */
async function guard(fn: () => Promise<TextResult>): Promise<TextResult> {
  try {
    return await fn();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { content: [{ type: "text", text: `[ERROR] ${msg}` }], isError: true };
  }
}

const HANDLE = /^r\d+$/;

export function registerVeilTools(server: McpServer, deps: VeilDeps): void {
  server.registerTool(
    "veil_search",
    {
      title: "Search the web",
      description:
        "Search the web → ranked results with titles, URLs, and snippets. " +
        "USE THIS FIRST for almost any question — the snippets alone often answer it. " +
        "Fast (~200ms), no browser. Then veil_read a result URL for the full page.",
      inputSchema: {
        query: z.string().describe("What to search for."),
      },
    },
    ({ query }) => guard(async () => text(renderSearch(await deps.search.run(query)))),
  );

  server.registerTool(
    "veil_read",
    {
      title: "Read a page (or pull more from one)",
      description:
        "Get what a web page SAYS — its text, extracted clean. USE THIS to read any URL " +
        "from a search result. Fast (~600ms) by fetch; if the page is behind JavaScript or " +
        "blocks plain requests, it AUTO-ESCALATES to a real browser render (slower, ~2–6s) " +
        "— the receipt says 'via: render' when it did. Long pages are truncated and return " +
        "a handle like 'r1'; call veil_read again with that handle plus a query to pull a " +
        "specific part. If it still says DOORMAN or 'blocked both ways', the site defeats " +
        "even the browser — pick another source, do not retry.",
      inputSchema: {
        url: z
          .string()
          .describe("A URL to read, or a handle (e.g. 'r1') returned by a previous read."),
        query: z
          .string()
          .optional()
          .describe("When pulling from a handle, the topic to find within the page."),
      },
    },
    ({ url, query }) =>
      guard(async () => {
        // A handle pull — search-within-page, no network.
        if (HANDLE.test(url)) {
          const pull = deps.reader.more(url, query);
          if (!pull) {
            return text(
              `No such handle "${url}" — it may have expired. Re-read the page by its URL.`,
            );
          }
          return text(renderPull(pull, url));
        }
        // A fresh read.
        return text(renderRead(await deps.reader.read(url)));
      }),
  );

  // ── the act path ─────────────────────────────────────────────────────────
  // Registered only when a SessionPool is supplied. A model shouldn't reason
  // about tools that aren't available.
  const pool = deps.sessions;
  if (!pool) return;

  server.registerTool(
    "veil_open",
    {
      title: "Open a page to interact with it",
      description:
        "Open a URL in a real browser and get a session plus the list of things you can DO on " +
        "the page (buttons, inputs, and what each one fires). USE THIS ONLY WHEN YOU MUST ACT — " +
        "clicking, typing, submitting. It boots a browser (~2-7s), so for merely reading a page " +
        "use veil_read instead. The session stays open: pass its id to veil_query.",
      inputSchema: { url: z.string().describe("The URL to open (http/https).") },
    },
    ({ url }) => guard(async () => text(renderOpen(await pool.open(url)))),
  );

  server.registerTool(
    "veil_query",
    {
      title: "Find things on an open page",
      description:
        "Search an open session's page for elements by role, name, or what they fire. Free and " +
        "instant — the page is already perceived, this just filters it. Use it to find a link " +
        "veil_open only counted, or to locate an element before acting on it.",
      inputSchema: {
        session: z.string().describe("Session id from veil_open."),
        role: z.string().optional().describe("ARIA role, e.g. 'button', 'link', 'textbox'."),
        name: z.string().optional().describe("Substring of the visible name (case-insensitive)."),
        fires: z.boolean().optional().describe("Only elements with a known effect."),
        limit: z.number().int().positive().optional().describe("Max results (default 50)."),
      },
    },
    ({ session, role, name, fires, limit }) =>
      guard(async () => {
        const res = pool.query(session, { role, name, fires, limit });
        return text(renderQuery(session, res));
      }),
  );

  server.registerTool(
    "veil_sessions",
    {
      title: "List open sessions",
      description: "List the browser sessions currently open, with their age and idle time.",
      inputSchema: {},
    },
    () => guard(async () => text(renderSessions(pool.list()))),
  );

  server.registerTool(
    "veil_close",
    {
      title: "Close a session",
      description:
        "Close a session and free its browser tab. Do this when you're finished with a page — " +
        "open sessions hold memory.",
      inputSchema: { session: z.string().describe("Session id to close.") },
    },
    ({ session }) =>
      guard(async () => {
        const closed = await pool.close(session);
        return text(
          closed
            ? `closed ${session}`
            : `no such session ${session} (${pool.goneReason(session)}) — nothing to close`,
        );
      }),
  );
}
