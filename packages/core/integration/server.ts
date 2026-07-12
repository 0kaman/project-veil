/**
 * A tiny static + JSON fixture server for the Layer-2 (real-Chrome) tests.
 * Serves the HTML fixtures and answers /api/* with JSON so Stage 3 has real
 * network requests to correlate. Binds to 127.0.0.1 on an ephemeral port.
 */
import { createServer, type Server } from "node:http";
import { readFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "fixtures");

export interface FixtureServer {
  url: (path: string) => string;
  close: () => Promise<void>;
}

export async function startFixtureServer(): Promise<FixtureServer> {
  const server: Server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const path = url.pathname;

    if (path.startsWith("/api/")) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, path, id: 42, items: ["a", "b"] }));
      return;
    }

    // Map a route to a fixture: "/", "/form", "/spa", "/scroll".
    const name =
      path === "/" || path === "/spa" ? "spa" : path.replace(/^\//, "").split("/")[0] || "form";
    try {
      const html = await readFile(join(FIXTURES, `${name}.html`), "utf8");
      res.writeHead(200, { "content-type": "text/html" });
      res.end(html);
    } catch {
      // Unknown path (e.g. /products after pushState reload, /session POST) —
      // still return a valid HTML doc so navigation resolves.
      res.writeHead(200, { "content-type": "text/html" });
      res.end(`<!doctype html><title>${path}</title><main>${path}</main>`);
    }
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;

  return {
    url: (path: string) => `http://127.0.0.1:${port}${path}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
