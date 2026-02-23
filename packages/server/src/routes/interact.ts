import { Hono } from "hono";
import { serializeJGF } from "@veil/sdk";
import type { InteractAction } from "@veil/sdk";
import type { SessionManager } from "../sessions.js";
import { ServerError, errorResponse } from "../errors.js";
import type { InteractRequest, NavigateRequest } from "../types.js";

const VALID_ACTIONS = new Set(["click", "type", "clear", "select", "focus", "hover"]);

function validateAction(action: InteractAction): void {
  if (!action || typeof action !== "object" || !("action" in action)) {
    throw new ServerError(400, "INVALID_REQUEST", "\"action\" must be an object with an \"action\" field");
  }
  if (!VALID_ACTIONS.has(action.action)) {
    throw new ServerError(400, "INVALID_REQUEST", `Unknown action "${action.action}". Valid: ${[...VALID_ACTIONS].join(", ")}`);
  }
  if (action.action === "type" && (typeof action.text !== "string" || !action.text)) {
    throw new ServerError(400, "INVALID_REQUEST", "\"type\" action requires a non-empty \"text\" field");
  }
  if (action.action === "select" && (typeof action.value !== "string")) {
    throw new ServerError(400, "INVALID_REQUEST", "\"select\" action requires a \"value\" field");
  }
}

export function interactRoutes(manager: SessionManager): Hono {
  const app = new Hono();

  // POST /api/sessions/:id/interact
  app.post("/interact", async (c) => {
    try {
      const body = await c.req.json<InteractRequest>();
      if (!body.nodeId || typeof body.nodeId !== "string") {
        throw new ServerError(400, "INVALID_REQUEST", "\"nodeId\" is required and must be a string");
      }
      validateAction(body.action);

      const page = manager.getPage(c.req.param("id"));
      const graph = await page.interact(body.nodeId, body.action);
      return c.json(serializeJGF(graph));
    } catch (err) {
      const { status, body } = errorResponse(err);
      return c.json(body, status as 400);
    }
  });

  // POST /api/sessions/:id/navigate
  app.post("/navigate", async (c) => {
    try {
      const body = await c.req.json<NavigateRequest>();
      if (!body.url || typeof body.url !== "string") {
        throw new ServerError(400, "INVALID_REQUEST", "\"url\" is required and must be a string");
      }

      const session = await manager.navigateSession(c.req.param("id"), body.url);
      const page = manager.getPage(session.id);
      const graph = await page.getGraph();
      return c.json({ session, graph: serializeJGF(graph) });
    } catch (err) {
      const { status, body } = errorResponse(err);
      return c.json(body, status as 400);
    }
  });

  return app;
}
