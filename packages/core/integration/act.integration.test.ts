/**
 * Layer 2 — veil_do against real headless Chrome.
 *
 * The fixture covers the cases the design argued about:
 *   - type + submit a form, and confirm the request is CAPTURED (replay's raw
 *     material) and attributed to the node that fired it
 *   - a click that reveals new actions, so the DIFF is non-trivial
 *   - a disabled button and an OBSCURED button — actionability must refuse with
 *     the reason, not silently "succeed" against the wrong element
 *   - an ambient poll running throughout, which must NOT be attributed to any
 *     action, and must not stop settle
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createServer, type Server } from "node:http";
import { SessionPool, chromeAvailable } from "../src/index.js";

const suite = chromeAvailable() ? describe : describe.skip;

const PAGE = `<!doctype html><html><head><title>Act fixture</title>
<style>
  /* Cover ONLY the "Underneath" button. An earlier version of this fixture used
     position:fixed;inset:0 and covered the whole viewport — which made the
     actionability check correctly refuse every element on the page. The check was
     right; the fixture was wrong. */
  #wrap { position:relative; width:220px; height:40px; }
  #wrap button { position:absolute; inset:0; width:100%; height:100%; }
  #cover { position:absolute; inset:0; background:rgba(0,0,0,.2); z-index:10; }
  #hidden-panel { display:none; }
</style></head><body>
  <form id="f" action="/api/submit" method="POST">
    <input name="q" aria-label="Search query">
    <button type="submit">Submit search</button>
  </form>

  <button id="reveal" aria-label="Show more options">Show more options</button>
  <div id="hidden-panel">
    <button aria-label="Archive">Archive</button>
    <button aria-label="Export">Export</button>
  </div>

  <button disabled aria-label="Locked action">Locked action</button>
  <div id="wrap"><button aria-label="Underneath">Underneath</button><div id="cover"></div></div>

  <script>
    // Ambient poll — runs forever. Must not be attributed to an action, and must
    // not prevent settle (it's young for <2s each time, but it's the SAME pattern).
    setInterval(function(){ fetch('/api/heartbeat').catch(function(){}); }, 300);

    document.getElementById('reveal').addEventListener('click', function(){
      document.getElementById('hidden-panel').style.display = 'block';
      this.setAttribute('aria-expanded', 'true');
    });
    document.getElementById('f').addEventListener('submit', function(e){
      e.preventDefault();
      fetch('/api/submit', { method:'POST',
        headers: { 'content-type':'application/json' },
        body: JSON.stringify({ q: document.querySelector('[name=q]').value }) });
    });
  </script>
</body></html>`;

suite("veil_do — real Chrome (Layer 2)", () => {
  let server: Server;
  let base: string;
  let submitted: string[] = [];

  beforeAll(async () => {
    server = createServer((req, res) => {
      const url = req.url ?? "/";
      if (url.startsWith("/api/heartbeat")) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end("{}");
        return;
      }
      if (url.startsWith("/api/submit")) {
        let body = "";
        req.on("data", (c) => (body += c));
        req.on("end", () => {
          submitted.push(body);
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ ok: true }));
        });
        return;
      }
      res.writeHead(200, { "content-type": "text/html" });
      res.end(PAGE);
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const a = server.address();
    base = `http://127.0.0.1:${typeof a === "object" && a ? a.port : 0}`;
  });

  afterAll(async () => {
    await new Promise<void>((r) => server.close(() => r()));
  });

  it("types into a field and the value lands in the graph", async () => {
    const pool = new SessionPool({ capMs: 4000 });
    try {
      const open = await pool.open(`${base}/app`);
      expect(open.ok).toBe(true);
      const r = await pool.act(open.sessionId!, "textbox-search-query", {
        kind: "type",
        value: "veil",
      });
      expect(r.ok).toBe(true);
      const node = pool.get(open.sessionId!)!.graph.nodes.get("textbox-search-query");
      expect(node?.value).toBe("veil");
    } finally {
      await pool.shutdown();
    }
  }, 90_000);

  it("submits, CAPTURES the request it fired, and learns a replay template", async () => {
    submitted = [];
    const pool = new SessionPool({ capMs: 4000 });
    try {
      const open = await pool.open(`${base}/app`);
      await pool.act(open.sessionId!, "textbox-search-query", { kind: "type", value: "hello" });
      const r = await pool.act(open.sessionId!, "button-submit-search", { kind: "click" });

      expect(r.ok).toBe(true);
      // the server really received it
      expect(submitted.join()).toMatch(/hello/);
      // and we attributed it to the node that fired it
      expect(r.fired?.method).toBe("POST");
      expect(r.fired?.url).toMatch(/\/api\/submit/);
      expect(r.learnedReplay).toBe(true);
      // the graph now marks that node replayable — the moat's payoff
      const node = pool.get(open.sessionId!)!.graph.nodes.get("button-submit-search");
      expect(node?.replayable).toBe(true);
      expect(pool.get(open.sessionId!)!.replay.has("button-submit-search")).toBe(true);
    } finally {
      await pool.shutdown();
    }
  }, 90_000);

  it("a click that reveals options produces a real DIFF", async () => {
    const pool = new SessionPool({ capMs: 4000 });
    try {
      const open = await pool.open(`${base}/app`);
      expect(open.lean).not.toMatch(/button-archive/); // hidden at first

      const r = await pool.act(open.sessionId!, "button-show-more-options", { kind: "click" });
      expect(r.ok).toBe(true);
      expect(r.diff?.added).toContain("button-archive");
      expect(r.diff?.added).toContain("button-export");
      expect(r.noOp).toBeFalsy();
    } finally {
      await pool.shutdown();
    }
  }, 90_000);

  it("refuses a disabled element, naming why", async () => {
    const pool = new SessionPool({ capMs: 4000 });
    try {
      const open = await pool.open(`${base}/app`);
      const r = await pool.act(open.sessionId!, "button-locked-action", { kind: "click" });
      expect(r.ok).toBe(false);
      expect(r.failure).toBe("disabled");
      expect(r.detail).toMatch(/disabled/i);
    } finally {
      await pool.shutdown();
    }
  }, 90_000);

  it("refuses an OBSCURED element rather than clicking the overlay", async () => {
    const pool = new SessionPool({ capMs: 4000 });
    try {
      const open = await pool.open(`${base}/app`);
      const r = await pool.act(open.sessionId!, "button-underneath", { kind: "click" });
      expect(r.ok).toBe(false);
      expect(r.failure).toBe("obscured");
      // and it says WHAT is covering it, so the agent can deal with that instead
      expect(r.detail).toMatch(/covered by/i);
    } finally {
      await pool.shutdown();
    }
  }, 90_000);

  it("an unknown node id suggests real alternatives", async () => {
    const pool = new SessionPool({ capMs: 4000 });
    try {
      const open = await pool.open(`${base}/app`);
      const r = await pool.act(open.sessionId!, "button-nonexistent", { kind: "click" });
      expect(r.ok).toBe(false);
      expect(r.failure).toBe("not-found");
      expect(r.detail).toMatch(/did you mean|veil_query/);
    } finally {
      await pool.shutdown();
    }
  }, 90_000);

  it("settles despite an ambient poll, and does not attribute it to the action", async () => {
    const pool = new SessionPool({ capMs: 5000 });
    try {
      const open = await pool.open(`${base}/app`);
      const r = await pool.act(open.sessionId!, "button-show-more-options", { kind: "click" });
      // The 300ms heartbeat runs throughout. Settle must still conclude...
      expect(r.settle?.reason).toBe("stable");
      // ...and the heartbeat must NOT be reported as what the click fired.
      expect(r.fired?.url ?? "").not.toMatch(/heartbeat/);
    } finally {
      await pool.shutdown();
    }
  }, 90_000);
});
