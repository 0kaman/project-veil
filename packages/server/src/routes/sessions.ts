import { Hono } from "hono";
import type { SessionManager } from "../sessions.js";
import { ServerError, errorResponse } from "../errors.js";
import type { CreateSessionRequest } from "../types.js";

export function sessionRoutes(manager: SessionManager): Hono {
  const app = new Hono();

  // POST /api/sessions — create session
  app.post("/", async (c) => {
    try {
      const body = await c.req.json<CreateSessionRequest>();
      if (!body.url || typeof body.url !== "string") {
        throw new ServerError(400, "INVALID_REQUEST", "\"url\" is required and must be a string");
      }
      const session = await manager.createSession(body.url);
      return c.json(session, 201);
    } catch (err) {
      const { status, body } = errorResponse(err);
      return c.json(body, status as 400);
    }
  });

  // GET /api/sessions — list sessions
  app.get("/", (c) => {
    return c.json(manager.listSessions());
  });

  // GET /api/sessions/:id — session info
  app.get("/:id", (c) => {
    try {
      const session = manager.getSession(c.req.param("id"));
      if (!session) {
        throw new ServerError(404, "SESSION_NOT_FOUND", `Session "${c.req.param("id")}" not found`);
      }
      return c.json({ id: session.id, url: session.url, createdAt: session.createdAt });
    } catch (err) {
      const { status, body } = errorResponse(err);
      return c.json(body, status as 400);
    }
  });

  // DELETE /api/sessions/:id — close session
  app.delete("/:id", (c) => {
    try {
      manager.closeSession(c.req.param("id"));
      return c.json({ ok: true });
    } catch (err) {
      const { status, body } = errorResponse(err);
      return c.json(body, status as 400);
    }
  });

  return app;
}
