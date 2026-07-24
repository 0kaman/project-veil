/**
 * Layer 2 — the render engine against real headless Chrome.
 *
 * The whole point of render() is to get content that a plain fetch CANNOT: a
 * page whose body only exists after JavaScript runs. So the fixture serves an
 * empty shell plus a script that injects the content, and the test asserts
 * render() returns the injected text while the raw HTML does not have it.
 *
 * Auto-skips when Chrome is absent.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createServer, type Server } from "node:http";
import { Renderer, chromeAvailable } from "../src/index.js";

const suite = chromeAvailable() ? describe : describe.skip;

// A realistic js-shell: the shell has NO article text; the script FETCHES it
// after load (the SPA pattern). So the shell served over the wire genuinely does
// not contain the content, and render() must wait for the fetch to settle.
const CONTENT = `<article><h1>Loaded from the API</h1><p>${"The quick brown fox jumps over the lazy dog. ".repeat(20)}</p></article>`;
const SHELL = `<!doctype html><html><head><title>SPA</title></head>
<body>
  <div id="root">Loading…</div>
  <script>
    fetch('/data').then(function (r) { return r.text(); }).then(function (t) {
      document.getElementById('root').innerHTML = t;
    });
  </script>
</body></html>`;

suite("render — real Chrome (Layer 2)", () => {
  let server: Server;
  let base: string;

  beforeAll(async () => {
    server = createServer((req, res) => {
      if (req.url === "/data") {
        res.writeHead(200, { "content-type": "text/html" });
        res.end(CONTENT);
        return;
      }
      res.writeHead(200, { "content-type": "text/html" });
      res.end(SHELL);
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const addr = server.address();
    base = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;
  });

  afterAll(async () => {
    await new Promise<void>((r) => server.close(() => r()));
  });

  it("returns HTML with JS-injected content that the shell does not contain", async () => {
    const renderer = new Renderer();
    try {
      const r = await renderer.render(`${base}/app`);
      expect(r.ok).toBe(true);
      // The rendered HTML has the API-loaded article...
      expect(r.html).toMatch(/Loaded from the API/);
      expect(r.html).toMatch(/quick brown fox/);
      // ...which the raw shell served over the wire genuinely does NOT — this is
      // exactly the content a plain fetch (@veil/read) would miss.
      expect(SHELL).not.toMatch(/Loaded from the API/);
      expect(SHELL).not.toMatch(/quick brown fox/);
    } finally {
      await renderer.close();
    }
  });

  it("reuses one browser across renders, each isolated", async () => {
    const renderer = new Renderer();
    try {
      const [a, b] = await Promise.all([
        renderer.render(`${base}/one`),
        renderer.render(`${base}/two`),
      ]);
      expect(a.ok).toBe(true);
      expect(b.ok).toBe(true);
      expect(a.finalUrl).toContain("/one");
      expect(b.finalUrl).toContain("/two");
    } finally {
      await renderer.close();
    }
  });

  it("a navigation failure is a receipt, not a throw", async () => {
    const renderer = new Renderer();
    try {
      const r = await renderer.render("http://127.0.0.1:1/nope"); // nothing listening
      expect(r.ok).toBe(false);
      expect(r.error).toBeTruthy();
    } finally {
      await renderer.close();
    }
  });
});
