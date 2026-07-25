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
  const REUSABLE = "session-scoped-token-never-rotates";
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
      if (req.method === "POST" && url.startsWith("/reuse-api/")) {
        let body = "";
        req.on("data", (c) => (body += c));
        req.on("end", () => {
          let tok = "";
          try {
            tok = (JSON.parse(body) as { csrf_token?: string }).csrf_token ?? "";
          } catch {
            /* ignore */
          }
          if (tok !== REUSABLE) {
            res.writeHead(403, { "content-type": "application/json" });
            res.end(JSON.stringify({ ok: false, why: "bad token" }));
            return;
          }
          // Token is FINE; Rails-style 422 for an ordinary bad field value.
          let qty = 1;
          try {
            qty = Number((JSON.parse(body) as { qty?: unknown }).qty ?? 1);
          } catch {
            /* ignore */
          }
          if (qty <= 0) {
            res.writeHead(422, { "content-type": "application/json" });
            res.end(JSON.stringify({ error: "quantity must be positive" }));
            return;
          }
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ ok: true }));
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
      // SESSION-SCOPED token: valid forever, never consumed, never rotated —
      // Django/Rails, i.e. the COMMON case. The fixture only had the single-use
      // scheme, which is why nothing caught the over-eager spent-token refusal.
      if (url.startsWith("/reusable")) {
        res.writeHead(200, { "content-type": "text/html" });
        res.end(`<!doctype html><html><head><title>Shop</title>
          <meta name="csrf-token" content="${REUSABLE}"></head><body>
          <button id="add" aria-label="Add to cart">Add to cart</button>
          <script>
            document.getElementById('add').addEventListener('click', function(){
              fetch('/reuse-api/cart', { method:'POST',
                headers:{'content-type':'application/json'},
                body: JSON.stringify({ sku:'A1', qty:1,
                  csrf_token: document.querySelector('meta[name=csrf-token]').content }) });
            });
          </script></body></html>`);
        return;
      }
      if (url.startsWith("/help")) {
        res.writeHead(200, { "content-type": "text/html" });
        res.end(`<!doctype html><html><head><title>Help</title></head><body>
          <h1>Help</h1><a href="/shop">Back to the shop</a></body></html>`);
        return;
      }
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
      // NOT desynced yet: a success is not evidence. A session-scoped token
      // looks identical at this point, and claiming desync here was the bug.
      expect(first.desynced).toBeFalsy();

      // The second replay re-sends it and the SERVER rejects it — that is the
      // evidence. Now we know it was one-shot, and that the page still holds it.
      const second = await pool.replay(open.sessionId!, "button-add-to-cart");
      expect(second.response?.status).toBe(403);
      expect(second.desynced).toBe(true);
      expect(second.detail).toMatch(/out of step with the server/);

      // Only NOW may we refuse before firing — the value is confirmed spent.
      const third = await pool.replay(open.sessionId!, "button-add-to-cart");
      expect(third.ok).toBe(false);
      expect(third.refusal).toBe("stale-token");
      expect(third.detail).toMatch(/veil_do|veil_open/);
      expect(third.response).toBeUndefined(); // nothing left the browser
    } finally {
      await pool.shutdown();
    }
  }, 90_000);

  it("REPEAT-replays a reusable token — a success is not evidence of spending", async () => {
    // The regression the first cut shipped: it marked a token spent because the
    // replay SUCCEEDED, and read "page still holds it" as desync. On a
    // session-scoped token (Django/Rails — two of the three schemes, and the
    // common ones) the page holds it because it is STILL VALID. That cut
    // reported a false desync and then refused replays #2 and #3, each of which
    // returns 200 here.
    const pool = new SessionPool({ capMs: 4000, config: { replay: "all" } });
    try {
      const open = await pool.open(`${base}/reusable`);
      await pool.act(open.sessionId!, "button-add-to-cart", { kind: "click" });
      for (let i = 0; i < 3; i++) {
        const r = await pool.replay(open.sessionId!, "button-add-to-cart");
        expect(r.refusal).toBeUndefined(); // never refused
        expect(r.response?.status).toBe(200); // and it really fired
        expect(r.desynced).toBeFalsy(); // nothing is out of step
      }
    } finally {
      await pool.shutdown();
    }
  }, 90_000);

  it("does not read an ordinary VALIDATION failure as a spent token", async () => {
    // Third instance of the same mistake class: treating a signal that isn't
    // about the token as evidence about the token. A Rails-style 422 on a
    // payload WE edited marked a valid session token spent, and the next clean
    // replay — which returns 200 — was refused without firing. The guard is
    // structural (did we change the payload?), not a phrase match, so it holds
    // in any language.
    const pool = new SessionPool({ capMs: 4000, config: { replay: "all" } });
    try {
      const open = await pool.open(`${base}/reusable`);
      await pool.act(open.sessionId!, "button-add-to-cart", { kind: "click" });

      expect((await pool.replay(open.sessionId!, "button-add-to-cart")).response?.status).toBe(200);

      // rejected because qty is bad — the token was never in question
      const bad = await pool.replay(open.sessionId!, "button-add-to-cart", { body: { qty: 0 } });
      expect(bad.response?.status).toBe(422);
      expect(bad.desynced).toBeFalsy();

      // so a clean replay must still fire
      const after = await pool.replay(open.sessionId!, "button-add-to-cart");
      expect(after.refusal).toBeUndefined();
      expect(after.response?.status).toBe(200);
    } finally {
      await pool.shutdown();
    }
  }, 90_000);

  it("does not send you to a node that navigation has removed", async () => {
    // Measured with a live agent: it replayed a POST, was refused with "Use
    // veil_do to perform it for real", did exactly that, and got NOT-FOUND —
    // because the submit had navigated to the response page and the button was
    // gone. The replay cache is keyed by node id and outlives the node, so the
    // refusal is reached normally and the advice reads confident while being
    // impossible to follow.
    const pool = new SessionPool({ capMs: 4000, config: { replay: "safe" } });
    try {
      const open = await pool.open(`${base}/shop`);
      const act = await pool.act(open.sessionId!, "button-add-to-cart", { kind: "click" });
      expect(act.learnedReplay).toBe(true);

      // Navigate away exactly as the real interaction did — the button leaves
      // the page, but the template it taught us survives in the replay cache.
      await pool.act(open.sessionId!, "link-help", { kind: "click" });
      const r = await pool.replay(open.sessionId!, "button-add-to-cart");

      expect(r.ok).toBe(false);
      expect(r.refusal).toBe("gated"); // safe mode still refuses the POST
      expect(r.nodeGone).toBe(true);
      // ...and the receipt must NOT send the agent at a node that is not there
      expect(r.detail).toMatch(/no longer on this page/);
      expect(r.detail).toMatch(/veil_open/);
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
