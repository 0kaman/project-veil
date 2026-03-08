import { Hono } from "hono";
import type { SessionManager } from "../sessions.js";
import { errorResponse } from "../errors.js";
import type { AuthRequest } from "../types.js";

export function authRoutes(manager: SessionManager): Hono {
  const app = new Hono();

  // POST /api/sessions/:id/auth
  app.post("/", async (c) => {
    try {
      const body = await c.req.json<AuthRequest>().catch(() => ({} as AuthRequest));
      const result = await manager.authSession(c.req.param("id"), {
        loginUrl: body.loginUrl,
        timeoutMs: body.timeoutMs,
      });
      return c.json(result);
    } catch (err) {
      const { status, body } = errorResponse(err);
      return c.json(body, status as 400);
    }
  });

  return app;
}
