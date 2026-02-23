import { Hono } from "hono";
import { serializeJGF, serializeCompactText, queryNodes } from "@veil/sdk";
import type { SessionManager } from "../sessions.js";
import { ServerError, errorResponse } from "../errors.js";

export function graphRoutes(manager: SessionManager): Hono {
  const app = new Hono();

  // GET /api/sessions/:id/graph — full JGF
  app.get("/", async (c) => {
    try {
      const page = manager.getPage(c.req.param("id"));
      const graph = await page.getGraph();
      return c.json(serializeJGF(graph));
    } catch (err) {
      const { status, body } = errorResponse(err);
      return c.json(body, status as 400);
    }
  });

  // GET /api/sessions/:id/graph/compact — compact text format
  app.get("/compact", async (c) => {
    try {
      const page = manager.getPage(c.req.param("id"));
      const graph = await page.getGraph();
      return c.text(serializeCompactText(graph));
    } catch (err) {
      const { status, body } = errorResponse(err);
      return c.json(body, status as 400);
    }
  });

  // GET /api/sessions/:id/graph/nodes — all nodes (with optional filters)
  app.get("/nodes", async (c) => {
    try {
      const page = manager.getPage(c.req.param("id"));
      const graph = await page.getGraph();

      const role = c.req.query("role");
      const name = c.req.query("name");
      const hasEvent = c.req.query("hasEvent");

      const hasFilter = role || name || hasEvent;
      if (hasFilter) {
        const nodes = queryNodes(graph, {
          ...(role && { role }),
          ...(name && { name }),
          ...(hasEvent && { hasEvent }),
        });
        return c.json(nodes);
      }

      return c.json(Array.from(graph.nodes.values()));
    } catch (err) {
      const { status, body } = errorResponse(err);
      return c.json(body, status as 400);
    }
  });

  // GET /api/sessions/:id/graph/nodes/:nodeId — single node
  app.get("/nodes/:nodeId", async (c) => {
    try {
      const page = manager.getPage(c.req.param("id"));
      const node = await page.getNode(c.req.param("nodeId"));
      if (!node) {
        throw new ServerError(404, "NODE_NOT_FOUND", `Node "${c.req.param("nodeId")}" not found`);
      }
      return c.json(node);
    } catch (err) {
      const { status, body } = errorResponse(err);
      return c.json(body, status as 400);
    }
  });

  return app;
}
