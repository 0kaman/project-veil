/**
 * Layer 2 — replay firing for real, against a LOCAL server we own.
 *
 * No third-party writes: replay changes server state, so it is only ever fired
 * at a server created by this test. The design probe established the same rule.
 *
 * The server implements SINGLE-USE CSRF, the hard case: a token is consumed on
 * use and the page mints a new one on each render. A stale template must fail
 * (403) and a refreshed one must succeed (200) — that difference is the entire
 * justification for refresh-at-fire-time.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createServer, type Server } from "node:http";
import { randomBytes } from "node:crypto";
import { SessionPool, chromeAvailable } from "../src/index.js";

const suite = chromeAvailable() ? describe : describe.skip;

suite("replay — real Chrome (Layer 2)", () => {
  let server: Server;
  let base: string;
  let currentToken = "";
  const consumed = new Set<string>();
  let carts: string[] = [];

  beforeAll(async () => {
    server = createServer((req, res) => {
      const url = req.url ?? "/";
      if (req.method === "POST" && url.startsWith("/api/cart")) {
        let body = "";
        req.on("data", (c) => (body += c));
        req.on("end", () => {
          let tok = "";
          try {
            tok = (JSON.parse(body) as { csrf_token?: string }).csrf_token ?? "";
          } catch {
            /* ignore */
          }
          if (!tok || tok !== currentToken || consumed.has(tok)) {
            res.writeHead(403, { "content-type": "application/json" });
            res.end(JSON.stringify({ ok: false, why: "bad or spent token" }));
            return;
          }
          consumed.add(tok);
          carts.push(body);
          // A real single-use-CSRF app issues the NEXT token with the response;
          // the page installs it. That is what makes refresh-at-fire-time work.
          currentToken = randomBytes(8).toString("hex");
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ ok: true, received: JSON.parse(body), nextToken: currentToken }));
        });
        return;
      }
      if (url.startsWith("/api/")) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true, path: url }));
        return;
      }
      // Assets must NOT mint a token. Chrome requests /favicon.ico on every
      // page load; treating that as a render rotated the token behind the
      // page's back and 403'd every click. (Cost me a debugging round.)
      if (url.startsWith("/favicon") || /\.(ico|png|css|js|map)$/.test(url)) {
        res.writeHead(404);
        res.end();
        return;
      }
      // A real page render mints a fresh token — the single-use pattern.
      currentToken = randomBytes(8).toString("hex");
      res.writeHead(200, { "content-type": "text/html" });
      res.end(`<!doctype html><html><head><title>Shop</title>
        <meta name="csrf-token" content="${currentToken}"></head><body>
        <input type="hidden" name="csrf_token" value="${currentToken}">
        <button id="add" aria-label="Add to cart">Add to cart</button>
        <a href="/help">Help</a>
        <script>
          var FROZEN = location.search.indexOf('frozen') !== -1;
          document.getElementById('add').addEventListener('click', function(){
            fetch('/api/cart', { method:'POST',
              headers:{'content-type':'application/json'},
              body: JSON.stringify({ sku:'A1', qty:1,
                csrf_token: document.querySelector('meta[name=csrf-token]').content }) })
              .then(function(r){ return r.json(); })
              .then(function(j){
                // FROZEN pages never install the new token — the case where
                // refresh provably cannot help (DECISIONS: the residual).
                if (!FROZEN && j.nextToken) {
                  document.querySelector('meta[name=csrf-token]').content = j.nextToken;
                  document.querySelector('input[name=csrf_token]').value = j.nextToken;
                }
              });
          });
        </script></body></html>`);
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const a = server.address();
    base = `http://127.0.0.1:${typeof a === "object" && a ? a.port : 0}`;
  });

  afterAll(async () => {
    await new Promise<void>((r) => server.close(() => r()));
  });

  it("refuses to replay something veil_do never performed", async () => {
    const pool = new SessionPool({ capMs: 4000, config: { replay: "all" } });
    try {
      const open = await pool.open(`${base}/shop`);
      const r = await pool.replay(open.sessionId!, "button-add-to-cart");
      expect(r.ok).toBe(false);
      expect(r.refusal).toBe("no-template");
      expect(r.detail).toMatch(/veil_do it once/);
    } finally {
      await pool.shutdown();
    }
  }, 90_000);

  it("REFRESHES a single-use token and succeeds where a stale one would 403", async () => {
    carts = [];
    const pool = new SessionPool({ capMs: 4000, config: { replay: "all" } });
    try {
      const open = await pool.open(`${base}/shop`);
      // teach it
      const act = await pool.act(open.sessionId!, "button-add-to-cart", { kind: "click" });
      expect(act.learnedReplay).toBe(true);

      // The captured token is now CONSUMED. A stale replay would be a 403; a
      // refreshed one reads the page's current token and succeeds.
      const r = await pool.replay(open.sessionId!, "button-add-to-cart", { body: { qty: 7 } });

      expect(r.response?.status).toBe(200);
      expect(r.refreshed).toContain("body:csrf_token");
      expect(r.edited).toContain("body:qty");
      // the server really saw the edit
      expect(carts.join()).toMatch(/"qty":7/);
    } finally {
      await pool.shutdown();
    }
  }, 90_000);

  it("returns the API RESPONSE, not a graph", async () => {
    const pool = new SessionPool({ capMs: 4000, config: { replay: "all" } });
    try {
      const open = await pool.open(`${base}/shop`);
      await pool.act(open.sessionId!, "button-add-to-cart", { kind: "click" });
      const r = await pool.replay(open.sessionId!, "button-add-to-cart");
      expect(r.response?.contentType).toMatch(/json/);
      expect(r.response?.body).toMatch(/"ok":true/);
    } finally {
      await pool.shutdown();
    }
  }, 90_000);

  it("degrades honestly when the page never renews its token (the documented residual)", async () => {
    // Refresh reads whatever the page CURRENTLY holds. On a frozen page that is
    // the already-spent token, so replay fails — by design, not by accident. The
    // receipt has to make the recovery obvious rather than look like a bug.
    const pool = new SessionPool({ capMs: 4000, config: { replay: "all" } });
    try {
      const open = await pool.open(`${base}/shop?frozen=1`);
      await pool.act(open.sessionId!, "button-add-to-cart", { kind: "click" });
      const r = await pool.replay(open.sessionId!, "button-add-to-cart");
      expect(r.response?.status).toBe(403);
      expect(r.ok).toBe(false);
      // it still TRIED to refresh — it just had nothing newer to find
      expect(r.refusal).toBeUndefined();
    } finally {
      await pool.shutdown();
    }
  }, 90_000);

  it("the GATE refuses a POST in safe mode, at fire time", async () => {
    const pool = new SessionPool({ capMs: 4000, config: { replay: "safe" } });
    try {
      const open = await pool.open(`${base}/shop`);
      await pool.act(open.sessionId!, "button-add-to-cart", { kind: "click" });
      const r = await pool.replay(open.sessionId!, "button-add-to-cart");
      expect(r.ok).toBe(false);
      expect(r.refusal).toBe("gated");
      expect(r.detail).toMatch(/safe/);
      // and nothing was fired
      expect(r.response).toBeUndefined();
    } finally {
      await pool.shutdown();
    }
  }, 90_000);

  it("the GATE refuses everything when replay is off", async () => {
    const pool = new SessionPool({ capMs: 4000, config: { replay: "off" } });
    try {
      const open = await pool.open(`${base}/shop`);
      await pool.act(open.sessionId!, "button-add-to-cart", { kind: "click" });
      const r = await pool.replay(open.sessionId!, "button-add-to-cart");
      expect(r.refusal).toBe("gated");
      expect(r.detail).toMatch(/disabled/);
    } finally {
      await pool.shutdown();
    }
  }, 90_000);

  it("reports the DESYNC it causes, then refuses to re-spend the same token", async () => {
    // The gap every other test in this file missed: they each do ONE act and ONE
    // replay against a fresh session. Looping exposes that replay consumes the
    // single-use token WITHOUT completing the app's rotation handshake (its
    // `.then` never runs), so the page is left holding a spent token — measured
    // 2026-07-25: from iteration 2 the real CLICK 403s too.
    const pool = new SessionPool({ capMs: 4000, config: { replay: "all" } });
    try {
      const open = await pool.open(`${base}/shop`);
      await pool.act(open.sessionId!, "button-add-to-cart", { kind: "click" });

      const first = await pool.replay(open.sessionId!, "button-add-to-cart");
      expect(first.response?.status).toBe(200);
      // it consumed the token and the page never picked up the successor
      expect(first.desynced).toBe(true);
      expect(first.detail).toMatch(/out of step with the server/);

      // A second replay would send the very same, now-spent token. Refuse before
      // firing: a refusal names the recovery, a 403 does not.
      const second = await pool.replay(open.sessionId!, "button-add-to-cart");
      expect(second.ok).toBe(false);
      expect(second.refusal).toBe("stale-token");
      expect(second.detail).toMatch(/veil_do|veil_open/);
      expect(second.response).toBeUndefined(); // nothing left the browser
    } finally {
      await pool.shutdown();
    }
  }, 90_000);

  it("is replay FASTER than the click it replaces — the whole point", async () => {
    const pool = new SessionPool({ capMs: 4000, config: { replay: "all" } });
    try {
      const open = await pool.open(`${base}/shop`);
      const act = await pool.act(open.sessionId!, "button-add-to-cart", { kind: "click" });
      const r = await pool.replay(open.sessionId!, "button-add-to-cart");
      expect(r.ok).toBe(true);
      // A click pays dispatch + settle + rebuild; a replay pays one request.
      expect(r.ms).toBeLessThan(act.ms);
    } finally {
      await pool.shutdown();
    }
  }, 90_000);
});
