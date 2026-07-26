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
  /* Parked well clear of everything else: an earlier revision put these at
     top:110px and the promo silently covered the JS search box, breaking the
     submit test. Same trap as the note above — the check was right, the
     fixture was wrong. */
  #behind { position:absolute; top:900px; left:20px; width:180px; height:36px; }
  #promo { position:absolute; top:890px; left:0; width:400px; height:60px;
           background:#fff; z-index:50; }
  #underscrim { position:absolute; top:1010px; left:20px; width:180px; height:36px; }
  #scrim { position:absolute; top:1000px; left:0; width:400px; height:60px;
           background:rgba(0,0,0,.3); z-index:60; }
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
  <!-- The shape that actually stopped a live agent: a promo modal over a real
       control, with the way out sitting inside the overlay. -->
  <div id="promo" class="modal-overlay" role="dialog" aria-modal="true">
    <button aria-label="No thanks">No thanks</button>
    <button aria-label="Subscribe">Subscribe</button>
  </div>
  <button id="behind" aria-label="Behind the modal">Behind the modal</button>
  <!-- A real backdrop: the dimming layer an open calendar puts up. Class name
       taken from cleartrip, which is where this was observed. No controls in
       it, by design. -->
  <div id="scrim" class="calendar--backdrop"></div>
  <button id="underscrim" aria-label="Under the scrim">Under the scrim</button>

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
  <!-- Hacker News' shape: a form with NO submit button. Enter is the only way in.
       And below it, the other shape: no form at all, just a keydown listener. -->
  <form action="/find" method="GET"><input name="q"></form>
  <input id="jsbox" aria-label="JS search">
  <!-- Prefilled, like a site that geolocates your origin for you. -->
  <input id="prefilled" aria-label="Origin" value="Bengaluru">

  <script>
    document.getElementById('jsbox').addEventListener('keydown', function(e){
      if (e.key === 'Enter') fetch('/find?via=keydown&q=' + encodeURIComponent(this.value));
    });
  </script>
</body></html>`;

/** Google Flights' actual shape: opening the origin dialog aria-hides the WHOLE
 * rest of the page, so every other control correctly leaves the graph. Served on
 * its own route — sharing the main fixture entangled it with a `role="dialog"`
 * promo that is present but NOT blocking, which is a distinction the detection
 * has to make. */
const DIALOG_PAGE = `<!doctype html><html><head><title>Dialog fixture</title></head><body>
  <div id="page">
    <input id="origin" aria-label="Origin">
    <input id="dest" aria-label="Destination">
    <button id="search" aria-label="Search flights">Search</button>
  </div>
  <div id="dlg" role="dialog" aria-modal="true" aria-label="Enter your origin" hidden>
    <input id="dlgbox" aria-label="Origin search">
    <button id="dlgdone" aria-label="Done">Done</button>
  </div>
  <script>
    document.getElementById('origin').addEventListener('click', function(){
      document.getElementById('dlg').hidden = false;
      // inert, not aria-hidden: Chrome refuses to hide FOCUSABLE descendants
      // via aria-hidden (it is invalid markup), so they stay in the AX tree and
      // the dialog would not read as blocking. inert is what a modal should use
      // and what actually removes them.
      document.getElementById('page').inert = true;
    });
    document.getElementById('dlgdone').addEventListener('click', function(){
      document.getElementById('dlg').hidden = true;
      document.getElementById('page').inert = false;
    });
  </script></body></html>`;

suite("veil_do — real Chrome (Layer 2)", () => {
  let server: Server;
  const found: string[] = [];
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
      if (url.startsWith("/dialog")) {
        res.writeHead(200, { "content-type": "text/html" });
        res.end(DIALOG_PAGE);
        return;
      }
      if (url.startsWith("/find")) {
        found.push(url);
        res.writeHead(200, { "content-type": "text/html" });
        res.end("<!doctype html><title>Results</title><body><h1>results</h1></body>");
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

  it("SUBMITS a form that has no submit button — Enter is the only way in", async () => {
    // A live agent typed into Hacker News' search box, then tried to press Enter
    // by typing "\n", and nothing happened: the action list had no way to send a
    // form. It reported the gap itself — "the missing capability is a way to
    // trigger the search". Asserting on the SERVER, because a keypress that
    // dispatches cleanly and does nothing is exactly the silent failure this
    // guards against — `text` alone is not enough, Enter needs its key identity.
    found.length = 0;
    const pool = new SessionPool({ capMs: 4000 });
    try {
      const open = await pool.open(base);
      const res = pool.query(open.sessionId!, { limit: 200 });
      const nodes = "returned" in res ? res.returned : [];
      const q = nodes.find((n) => n.role === "textbox" && !n.name);
      expect(q).toBeDefined();

      const r = await pool.act(open.sessionId!, q!.id, { kind: "submit", value: "chrome devtools" });
      expect(r.ok).toBe(true);
      expect(r.noOp).toBeFalsy();
      // the request really left the browser and the server really got it
      expect(found.some((u) => u.includes("q=chrome+devtools"))).toBe(true);
      expect(r.diff?.navigated?.to).toMatch(/\/find/);
    } finally {
      await pool.shutdown();
    }
  }, 90_000);

  it("submits a box with NO form at all, via its keydown listener", async () => {
    // The other half of why this is a real keypress rather than requestSubmit():
    // there is no form here to submit.
    found.length = 0;
    const pool = new SessionPool({ capMs: 4000 });
    try {
      const open = await pool.open(base);
      const r = await pool.act(open.sessionId!, "textbox-js-search", {
        kind: "submit",
        value: "hello",
      });
      expect(r.ok).toBe(true);
      expect(found.some((u) => u.includes("via=keydown") && u.includes("q=hello"))).toBe(true);
    } finally {
      await pool.shutdown();
    }
  }, 90_000);

  it("REPLACES what a prefilled field held, and says what it now holds", async () => {
    // The bug this locks down cost two rounds of misdiagnosis. Google Flights
    // pre-fills the origin by geolocation; typing "BLR" produced "BLRBengaluru",
    // which matches no airport, so the page said "No matching locations found"
    // and the AX tree had no options to show. I read the missing options as a
    // perception failure and blamed the AX tree twice. It was the input.
    const pool = new SessionPool({ capMs: 4000 });
    try {
      const open = await pool.open(base);
      const r = await pool.act(open.sessionId!, "textbox-origin", { kind: "type", value: "BLR" });
      expect(r.ok).toBe(true);
      // replaced, not appended
      expect(r.value).toBe("BLR");
      expect(r.value).not.toContain("Bengaluru");

      // and the graph agrees with the receipt
      const q = pool.query(open.sessionId!, { role: "textbox", limit: 50 });
      const node = ("returned" in q ? q.returned : []).find((n) => n.id === "textbox-origin");
      expect(node?.value).toBe("BLR");
    } finally {
      await pool.shutdown();
    }
  }, 90_000);

  it("reports the value a field REFORMATS, rather than the one it was sent", async () => {
    // Silence about a field rewriting its input is how a wrong value travels on
    // looking like somebody else's bug.
    const pool = new SessionPool({ capMs: 4000 });
    try {
      const open = await pool.open(base);
      const r = await pool.act(open.sessionId!, "textbox-origin", { kind: "clear" });
      expect(r.value).toBe("");
    } finally {
      await pool.shutdown();
    }
  }, 90_000);

  it("REPORTS a dialog opening, so vanished nodes read as hidden rather than gone", async () => {
    // All six recorded fare runs hit this and none understood it: typing into
    // Google Flights' origin opens `dialog "Enter your origin"`, aria-hides the
    // page, and `combobox-where-to` correctly leaves the graph. Every run read
    // its own modal as the page breaking, and burned steps hunting the field.
    const pool = new SessionPool({ capMs: 4000 });
    try {
      const open = await pool.open(`${base}/dialog`);
      expect(open.lean).toContain("textbox-destination");
      expect(open.lean).not.toMatch(/DIALOG/); // nothing is blocking yet

      const r = await pool.act(open.sessionId!, "textbox-origin", { kind: "click" });
      expect(r.ok).toBe(true);
      // the diff — what an agent reads after veil_do — names it
      expect(r.diff?.dialog?.opened).toBe("Enter your origin");
      // and the node really did leave, which is CORRECT, not a fault
      expect(r.diff?.removed).toContain("textbox-destination");

      // closing it says the page is reachable again
      const back = await pool.act(open.sessionId!, "button-done", { kind: "click" });
      expect(back.diff?.dialog?.closed).toBe("Enter your origin");
      expect(back.diff?.added).toContain("textbox-destination");
    } finally {
      await pool.shutdown();
    }
  }, 90_000);

  it("does NOT call a present-but-harmless dialog blocking", async () => {
    // The main fixture carries a role="dialog" promo while the page stays fully
    // usable. Announcing that as a modal would be its own false receipt — and
    // this case is what caught the first, naive "any dialog node" detection.
    // Measured separation is wide: Google with its origin dialog open hides 508
    // of 561 AX nodes; this page hides none.
    const pool = new SessionPool({ capMs: 4000 });
    try {
      const open = await pool.open(base);
      expect(open.lean).not.toMatch(/DIALOG OPEN/);
      const r = await pool.act(open.sessionId!, "textbox-origin", { kind: "type", value: "x" });
      expect(r.diff?.dialog).toBeUndefined();
    } finally {
      await pool.shutdown();
    }
  }, 90_000);

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

  it("NAMES the node that dismisses the overlay, not just the overlay", async () => {
    // Measured: told only "covered by <div class=...>", a live agent guessed at
    // "close", "Close" and "hsBackDrop", found nothing, and abandoned the site.
    // A blocker it cannot address is a dead end; a node id is a next move.
    const pool = new SessionPool({ capMs: 4000 });
    try {
      const open = await pool.open(base);
      const r = await pool.act(open.sessionId!, "button-behind-the-modal", { kind: "click" });
      expect(r.ok).toBe(false);
      expect(r.failure).toBe("obscured");
      expect(r.detail).toMatch(/covered by/i);
      // the actionable half: a node the agent can actually call veil_do on
      expect(r.detail).toMatch(/dismiss it first/i);
      expect(r.detail).toMatch(/button-no-thanks/);
      // and it must not offer the thing that is NOT a way out
      expect(r.detail).not.toMatch(/button-subscribe/);

      // following that advice actually works
      const d = await pool.act(open.sessionId!, "button-no-thanks", { kind: "click" });
      expect(d.ok).toBe(true);
    } finally {
      await pool.shutdown();
    }
  }, 90_000);

  it("calls a BACKDROP what it is, so the agent stops hunting for a close button", async () => {
    // #scrim carries cleartrip's own class name. Note the neighbouring #cover is
    // deliberately NOT a backdrop — it is a small unclassed overlay, and must not
    // be described as one. Measured on the real thing: given only "covered by
    // <div class=hsBackDrop>", a live agent ran four queries guessing at
    // "close"/"Close"/"hsBackDrop", found nothing, and abandoned the site.
    const pool = new SessionPool({ capMs: 4000 });
    try {
      const open = await pool.open(base);
      const r = await pool.act(open.sessionId!, "button-under-the-scrim", { kind: "click" });
      expect(r.failure).toBe("obscured");
      expect(r.detail).toMatch(/BACKDROP/);
      expect(r.detail).toMatch(/do not search for one/i);
      // and it must not invent a dismiss node that isn't there
      expect(r.detail).not.toMatch(/dismiss it first/i);
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
