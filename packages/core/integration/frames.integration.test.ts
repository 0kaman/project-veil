/**
 * Layer 2 — child documents, against real headless Chrome.
 *
 * A fake structurally cannot catch what is under test here. Three Chrome
 * behaviours had to be MEASURED, and each one is an assertion below:
 *
 *   1. `document.body.tagName` is `FRAMESET` for a frameset document — not
 *      `null`, not `HTML`.
 *   2. Chrome omits a cross-SITE frame from `Page.getFrameTree` entirely while
 *      `DOM`/AX still carry the `<iframe>` ELEMENT. That asymmetry is the whole
 *      unreachable receipt; a hand-written fake would have to already know it.
 *   3. `Accessibility.getFullAXTree({frameId})` reaches a child document that
 *      the no-argument call does not.
 *
 * Two servers on purpose. `127.0.0.1` and `localhost` are cross-SITE to Chrome
 * (measured), and that pair is the ONLY way to exercise the OOPIF branch — with
 * one origin every "reachable" assertion still passes and the branch is never
 * touched. The cross-site test therefore asserts the branch FIRED
 * (`readable.length < total`) before asserting anything about its wording.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createServer, type Server } from "node:http";
import { Renderer, SessionPool, chromeAvailable, queryNodes } from "../src/index.js";

const suite = chromeAvailable() ? describe : describe.skip;

const html = (body: string): string =>
  `<!doctype html><html><head><title>Fixture</title></head><body>${body}</body></html>`;

/** The guest lives on the OTHER origin — cross-site, so Chrome isolates it. */
const GUEST = html(`<h1>Guest</h1><p>The guest secret is 4242.</p>`);

/**
 * Read the innermost frame's `document.title` straight off the live tab.
 *
 * Deliberately NOT through anything under test — a plain `contentDocument` walk
 * from the top frame, which works because the fixture frames are same-origin.
 * This is the assertion that a click LANDED. `ok: true` is not: measured, the
 * pre-fix dispatch returned `{"ok":true}` for a click that hit the top
 * document's BODY while the frame's title never moved.
 */
async function frameTitle(pool: SessionPool, sessionId: string, depth = 1): Promise<string> {
  const s = pool.get(sessionId);
  if (!s) throw new Error("session gone");
  let expr = "document.querySelector('iframe, frame').contentDocument";
  for (let i = 1; i < depth; i++) expr += ".querySelector('iframe, frame').contentDocument";
  const r = (await s.client.send("Runtime.evaluate", {
    expression: `${expr}.title`,
    returnByValue: true,
  })) as { result?: { value?: unknown } };
  return typeof r.result?.value === "string" ? r.result.value : "";
}

suite("frames — child documents (Layer 2)", () => {
  let host: Server;
  let guest: Server;
  let base = "";
  let guestBase = "";

  const page = (path: string): string | null => {
    switch (path) {
      // A <frameset>: the top document has NO content of its own. This is the
      // arena's `frameset` task, reduced to its bones.
      case "/frameset":
        return `<!doctype html><html><head><title>Console</title></head>
          <frameset cols="200,*">
            <frame name="menu" src="/frame-menu">
            <frame name="body" src="/frame-body">
          </frameset></html>`;
      case "/frame-menu":
        return html(`<ul><li id="billing">Billing</li></ul>
          <a href="/frame-billing">Billing page</a>`);
      case "/frame-body":
        return html(`<h1>Overview</h1><p>Nothing to see at the top level.</p>
          <button id="go">Open billing</button>`);
      case "/frame-billing":
        return html(`<h1>Billing</h1><p>Account balance is 8432 rupees.</p>`);
      // THE ARENA'S ACTUAL SHAPE, and the scheme this suite was missing.
      //
      // `/frameset` above puts a real <button> and an <a href> in its frames, so
      // `doerCount` is never 0 there and the "nothing is actionable" line it
      // claims to test never prints at all — it passed for an unrelated reason.
      // Here the menu is `<li onclick>`, which stage 1 does not classify as a
      // doer, and the body is pure prose. Both frames ARE entered, so this is
      // also the case where `missing` is 0 and the first cut of the gate went
      // silent. Perception and actionability are different things.
      case "/frameset-prose":
        return `<!doctype html><html><head><title>Router</title></head>
          <frameset cols="200,*">
            <frame name="nav" src="/prose-nav">
            <frame name="main" src="/prose-main">
          </frameset></html>`;
      case "/prose-nav":
        return html(`<ul><li onclick="parent.main.location='/frame-billing'">Billing</li>
          <li onclick="void 0">Status</li></ul>`);
      case "/prose-main":
        return html(`<h1>Status</h1><p>Uptime is 41 days.</p>`);
      // The same-origin iframe: all the prose is one document down.
      case "/iframe":
        return html(`<h1>Dashboard</h1><p>Reading below.</p>
          <iframe src="/iframe-inner" width="400" height="200"></iframe>`);
      case "/iframe-inner":
        return html(`<h1>Meter</h1><p>Current reading is 6193 units.</p>
          <button id="ack">Acknowledge reading</button>
          <script>document.getElementById('ack').addEventListener('click', function(){
            document.title = 'ACKED';
          });</script>`);
      // Host page holding one reachable frame and one cross-SITE frame.
      case "/oopif":
        return html(`<h1>Host</h1>
          <iframe src="/iframe-inner" width="300" height="150"></iframe>
          <iframe src="${guestBase}/guest" width="300" height="150"></iframe>`);
      // The guard: no frames anywhere.
      case "/plain":
        return html(`<h1>Plain</h1><button id="b">Press me</button>`);
      // Depth 2: content and a click both have to reach the leaf document.
      case "/nested":
        return html(`<h1>Outer</h1>
          <iframe src="/nested-mid" width="500" height="300"></iframe>`);
      case "/nested-mid":
        return html(`<h2>Middle</h2>
          <iframe src="/iframe-inner" width="400" height="200"></iframe>`);
      // A cross-SITE frame nested inside a same-origin one: invisible at depth 2
      // exactly as at depth 1, and its owner AX node is in the CHILD's tree.
      case "/nested-oopif":
        return html(`<h1>Outer</h1>
          <iframe src="/nested-oopif-mid" width="500" height="300"></iframe>`);
      case "/nested-oopif-mid":
        return html(`<h2>Middle</h2>
          <iframe src="${guestBase}/guest" width="300" height="150"></iframe>`);
      // A frame the AX tree cannot see and the composer must SKIP, not inline.
      case "/hidden-frames":
        return html(`<h1>Hidden</h1><p>Visible prose.</p>
          <iframe src="/tracking-a" style="display:none"></iframe>
          <iframe src="/tracking-b" width="0" height="0" frameborder="0"></iframe>
          <iframe src="/tracking-c" width="0" height="0"></iframe>`);
      case "/tracking-a":
        return html(`<p>display none payload 11111</p>`);
      case "/tracking-b":
        return html(`<p>zero sized payload 22222</p>`);
      case "/tracking-c":
        return html(`<p>bordered zero payload 33333</p>`);
      // Re-renders itself between perceive and act, forcing the stale-handle
      // branch — the second dispatchAction call site.
      case "/churn":
        return html(`<h1>Churn</h1>
          <button id="swap">Swap frame</button>
          <div id="slot"><iframe src="/iframe-inner" width="400" height="200"></iframe></div>
          <script>
            // Replace the iframe element wholesale, but on a DELAY, so the swap
            // lands after the graph rebuild that follows the click. That is what
            // leaves the session holding a dead backendNodeId for an in-frame
            // node — the stale-handle branch, deterministically.
            document.getElementById('swap').addEventListener('click', function(){
              setTimeout(function(){
                var s = document.getElementById('slot');
                var f = s.firstElementChild;
                var n = document.createElement('iframe');
                n.src = f.src; n.width = f.width; n.height = f.height;
                s.replaceChild(n, f);
              }, 400);
            });
          </script>`);
      // The LOOP fixture: a frame that comes AND goes, in one session.
      case "/toggle":
        return html(`<h1>Toggle</h1>
          <button id="add">Add frame</button>
          <button id="rm">Remove frame</button>
          <div id="slot"></div>
          <script>
            document.getElementById('add').addEventListener('click', function(){
              document.getElementById('slot').innerHTML =
                '<iframe src="/iframe-inner" width="300" height="150"></iframe>';
            });
            document.getElementById('rm').addEventListener('click', function(){
              document.getElementById('slot').innerHTML = '';
            });
          </script>`);
      default:
        return null;
    }
  };

  beforeAll(async () => {
    guest = createServer((_req, res) => {
      res.writeHead(200, { "content-type": "text/html" });
      res.end(GUEST);
    });
    // No host argument: bind every interface, so `http://localhost:<p>` resolves
    // whether the box prefers ::1 or 127.0.0.1. A guest that fails to load would
    // silently turn the cross-site case into a no-frame case.
    await new Promise<void>((r) => guest.listen(0, r));
    const ga = guest.address();
    guestBase = `http://localhost:${typeof ga === "object" && ga ? ga.port : 0}`;

    host = createServer((req, res) => {
      const body = page((req.url ?? "/").split("?")[0]!);
      if (body === null) {
        res.writeHead(404, { "content-type": "text/html" });
        res.end(html("<p>not found</p>"));
        return;
      }
      res.writeHead(200, { "content-type": "text/html" });
      res.end(body);
    });
    await new Promise<void>((r) => host.listen(0, "127.0.0.1", r));
    const a = host.address();
    base = `http://127.0.0.1:${typeof a === "object" && a ? a.port : 0}`;
  });

  afterAll(async () => {
    await new Promise<void>((r) => host.close(() => r()));
    await new Promise<void>((r) => guest.close(() => r()));
  });

  it("SCHEME frameset: names both frames instead of reporting an empty page", async () => {
    // Fails before the fix: `meta.frames` is undefined because nothing in the
    // build path reads the frame tree, and the lean view says "nothing on this
    // page is actionable" — which is what cost 53,471 tokens in the arena.
    const r = new Renderer();
    try {
      const p = await r.perceive(`${base}/frameset`);
      expect(p.ok).toBe(true);
      if (!p.ok) return;

      const f = p.graph.meta.frames;
      expect(f).toBeDefined();
      expect(f!.frameset).toBe(true);
      expect(f!.total).toBe(2);
      expect(f!.readable.map((x) => x.name).sort()).toEqual(["body", "menu"]);
      expect(f!.readable.map((x) => x.url).sort()).toEqual([
        `${base}/frame-body`,
        `${base}/frame-menu`,
      ]);
      // the receipt adds up
      expect(f!.total).toBe(f!.readable.length + f!.unreachable.length);

      // and its content is actually PERCEIVED, not merely announced
      expect(f!.perceived).toBe(2);
      expect(p.graph.nodes.has("button-open-billing")).toBe(true);
      expect(p.graph.nodes.get("button-open-billing")!.frame).toEqual({
        url: `${base}/frame-body`,
        depth: 1,
      });
      expect(p.lean).toContain("@frame /frame-body");
      expect(p.lean).not.toMatch(/nothing on this page is actionable/);
    } finally {
      await r.close();
    }
  }, 60_000);

  it("SCHEME frameset with NO perceivable doers: the notice still fires", async () => {
    // The regression this exists to catch, measured on the arena fixture before
    // the gate was fixed — the ENTIRE receipt was:
    //   ACTIONS (0)
    //     (none — nothing on this page is actionable)
    //   FRAMES (2) — 2 child document(s) are perceived; …tagged @frame.
    // No names, no "do NOT guess", no recovery. Both frames had been entered, so
    // `missing` was 0 and the gate closed. The two assertions that should have
    // caught it both looked elsewhere: the Layer-1 fixture defaulted
    // `perceived: 0`, and `/frameset` above has doers in its frames.
    const r = new Renderer();
    try {
      const p = await r.perceive(`${base}/frameset-prose`);
      expect(p.ok).toBe(true);
      if (!p.ok) return;

      const f = p.graph.meta.frames!;
      expect(f.perceived).toBe(2); // entered…
      expect(f.readable.length - f.perceived).toBe(0); // …and nothing is missing
      expect(p.graph.doers).toHaveLength(0); // …and still nothing to act on

      expect(p.lean).not.toMatch(/nothing on this page is actionable/);
      expect(p.lean).toMatch(/none HERE/);
      expect(p.lean).toContain(`${base}/prose-nav`);
      expect(p.lean).toContain(`${base}/prose-main`);
      expect(p.lean).toMatch(/do NOT guess/i);
      // and it must not misreport WHY, by borrowing the unreadable-frame wording
      expect(p.lean).not.toMatch(/could NOT be entered/);
    } finally {
      await r.close();
    }
  }, 60_000);

  it("a frameset whose frames DO carry doers is not lectured about frames", async () => {
    // The complement, so the gate cannot degenerate into "always print it".
    const r = new Renderer();
    try {
      const p = await r.perceive(`${base}/frameset`);
      expect(p.ok).toBe(true);
      if (!p.ok) return;
      expect(p.graph.doers.length).toBeGreaterThan(0);
      expect(p.lean).not.toMatch(/do NOT guess/i);
    } finally {
      await r.close();
    }
  }, 60_000);

  it("SCHEME same-origin iframe: the child document's controls are IN the graph", async () => {
    // Fails before the fix: `Accessibility.getFullAXTree` with no frameId walks
    // the top document only, and the `Iframe` AX node is a leaf whose role is in
    // neither DOER_ROLES nor NAV_ROLES — so even the EVIDENCE that a frame
    // existed was filtered away, and the receipt read `ACTIONS (0)`.
    const r = new Renderer();
    try {
      const p = await r.perceive(`${base}/iframe`);
      expect(p.ok).toBe(true);
      if (!p.ok) return;

      const f = p.graph.meta.frames;
      expect(f).toBeDefined();
      expect(f!.frameset).toBe(false);
      expect(f!.total).toBe(1);
      expect(f!.readable[0]!.url).toBe(`${base}/iframe-inner`);
      expect(f!.unreachable).toEqual([]);
      expect(f!.perceived).toBe(1);

      const ack = p.graph.nodes.get("button-acknowledge-reading");
      expect(ack).toBeDefined();
      expect(ack!.frame).toEqual({ url: `${base}/iframe-inner`, depth: 1 });
      // the affordance is on the NODE, not only in a summary line
      expect(p.lean).toMatch(/button-acknowledge-reading .*@frame \/iframe-inner/);

      // Stage 2 must cross the frame boundary too. A doer whose `events` are
      // empty is one an agent can SEE and cannot reason about — the graph would
      // be back to being an accessibility snapshot, which is the thing this
      // project exists not to be. `graph.integration.test.ts` asserts exactly
      // this shape for a top-frame JS-wired button.
      expect(ack!.events.some((e) => e.type === "click")).toBe(true);
    } finally {
      await r.close();
    }
  }, 60_000);

  it("SCHEME depth 2: a frame inside a frame is reached too", async () => {
    const r = new Renderer();
    try {
      const p = await r.perceive(`${base}/nested`);
      expect(p.ok).toBe(true);
      if (!p.ok) return;
      expect(p.graph.meta.frames!.perceived).toBe(2);
      const ack = p.graph.nodes.get("button-acknowledge-reading");
      expect(ack?.frame?.depth).toBe(2);
    } finally {
      await r.close();
    }
  }, 60_000);

  it("SCHEME cross-site: counts what it cannot read, and offers no recovery for it", async () => {
    const r = new Renderer();
    try {
      const p = await r.perceive(`${base}/oopif`);
      expect(p.ok).toBe(true);
      if (!p.ok) return;

      const f = p.graph.meta.frames;
      expect(f).toBeDefined();
      // FIRST: prove the OOPIF branch actually fired. If the hostname pair had
      // resolved same-site, every assertion below would pass vacuously.
      expect(f!.readable.length).toBeLessThan(f!.total);
      expect(f!.total).toBe(2);
      expect(f!.readable).toHaveLength(1);
      expect(f!.readable[0]!.url).toBe(`${base}/iframe-inner`);
      expect(f!.unreachable).toHaveLength(1);
      expect(f!.unreachable[0]).toContain("/guest");
      expect(f!.total).toBe(f!.readable.length + f!.unreachable.length);

      expect(p.lean).toMatch(/1 of these are CROSS-SITE/);
      expect(p.lean).toMatch(/NO recovery/);
    } finally {
      await r.close();
    }
  }, 60_000);

  it("SCHEME cross-site AT DEPTH 2: an OOPIF inside a readable frame is still reported", async () => {
    // The unreachable diff has to run over every document walked, not just the
    // root — the owner AX node for this frame lives in the CHILD's tree, so a
    // root-only diff would report `unreachable: []` and quietly claim the page
    // was fully perceived.
    const r = new Renderer();
    try {
      const p = await r.perceive(`${base}/nested-oopif`);
      expect(p.ok).toBe(true);
      if (!p.ok) return;
      const f = p.graph.meta.frames!;
      expect(f.readable.length).toBeLessThan(f.total); // the branch fired
      expect(f.perceived).toBe(1);
      expect(f.unreachable).toHaveLength(1);
      expect(f.unreachable[0]).toContain("/guest");
      expect(p.lean).toMatch(/CROSS-SITE/);
    } finally {
      await r.close();
    }
  }, 60_000);

  it("guard: a page with no frames says nothing about frames at all", async () => {
    const r = new Renderer();
    try {
      const p = await r.perceive(`${base}/plain`);
      expect(p.ok).toBe(true);
      if (!p.ok) return;
      expect(p.graph.meta.frames).toBeUndefined();
      expect(p.lean).not.toMatch(/FRAME/i);
    } finally {
      await r.close();
    }
  }, 60_000);

  it("a zero-match veil_query says what is missing rather than 'try a broader filter'", async () => {
    const r = new Renderer();
    try {
      const p = await r.perceive(`${base}/oopif`);
      expect(p.ok).toBe(true);
      if (!p.ok) return;
      const q = queryNodes(p.graph, { name: "no-such-control" });
      expect(q.matched).toBe(0);
      expect(q.note).toMatch(/cross-site/i);
      expect(q.note).toMatch(/no recovery/i);
    } finally {
      await r.close();
    }
  }, 60_000);

  it("the session's HTML carries the child document's PROSE, which is the answer", async () => {
    // Measured before the fix: 216 chars of HTML, no "6193", and a receipt
    // saying `status: ok` … "this is the live tab, there is nothing further to
    // escalate to" — while 100% of the page's prose sat one frame down.
    const pool = new SessionPool();
    try {
      const open = await pool.open(`${base}/iframe`);
      expect(open.ok).toBe(true);
      const live = await pool.html(open.sessionId!);
      expect("gone" in live).toBe(false);
      if ("gone" in live) return;
      expect(live.html).toContain("6193");
      expect(live.html).toContain("data-veil-frame");
      expect(live.frames).toEqual({ composed: 1, hidden: 0, appended: 0 });
    } finally {
      await pool.shutdown();
    }
  }, 120_000);

  it("a FRAMESET serializes to its frames' content, not 157 chars of markup", async () => {
    const pool = new SessionPool();
    try {
      const open = await pool.open(`${base}/frameset`);
      expect(open.ok).toBe(true);
      const live = await pool.html(open.sessionId!);
      if ("gone" in live) throw new Error("session gone");
      expect(live.html).toContain("Overview");
      expect(live.frames!.composed).toBe(2);
    } finally {
      await pool.shutdown();
    }
  }, 120_000);

  it("a click on an in-frame button LANDS — asserted by its side effect, never by ok", async () => {
    // THE regression that makes this change atomic. Measured before the
    // coordinate fix: dispatchAction returned {"ok":true,"at":{"x":79.73,...}},
    // the iframe's document.title was UNCHANGED, and the top frame's
    // elementFromPoint at those coordinates was BODY. `ok: true` proves nothing
    // here, so this test refuses to assert it: it reads the title back through
    // contentDocument, which only changes if the click really landed.
    const pool = new SessionPool();
    try {
      const open = await pool.open(`${base}/iframe`);
      expect(open.ok).toBe(true);
      const sid = open.sessionId!;

      const before = await frameTitle(pool, sid);
      expect(before).toBe("Fixture");

      await pool.act(sid, "button-acknowledge-reading", { kind: "click" });

      expect(await frameTitle(pool, sid)).toBe("ACKED");
    } finally {
      await pool.shutdown();
    }
  }, 120_000);

  it("a click at DEPTH 2 lands as well — one nesting level is not a scheme", async () => {
    const pool = new SessionPool();
    try {
      const open = await pool.open(`${base}/nested`);
      expect(open.ok).toBe(true);
      const sid = open.sessionId!;
      await pool.act(sid, "button-acknowledge-reading", { kind: "click" });
      expect(await frameTitle(pool, sid, 2)).toBe("ACKED");
    } finally {
      await pool.shutdown();
    }
  }, 120_000);

  it("LOOP: the RE-RESOLVE path keeps the in-frame click landing", async () => {
    // The stale-handle branch in session.ts is a SECOND dispatchAction call
    // site. If it reads the in-frame flag off the STALE node — or not at all —
    // the false-ok returns intermittently, only on self-re-rendering pages,
    // which is the hardest place to notice it. A fixture acted on once cannot
    // fail this: act, make the page replace the frame element AFTER the rebuild,
    // then act again through the branch and assert the side effect.
    const pool = new SessionPool();
    try {
      const open = await pool.open(`${base}/churn`);
      expect(open.ok).toBe(true);
      const sid = open.sessionId!;

      const first = await pool.act(sid, "button-acknowledge-reading", { kind: "click" });
      expect(first.ok).toBe(true);
      expect(await frameTitle(pool, sid)).toBe("ACKED");

      // arm the swap; it fires after the rebuild, leaving a dead handle behind
      await pool.act(sid, "button-swap-frame", { kind: "click" });
      await new Promise((r) => setTimeout(r, 900));
      expect(await frameTitle(pool, sid)).toBe("Fixture"); // a genuinely NEW document

      const second = await pool.act(sid, "button-acknowledge-reading", { kind: "click" });
      expect(second.ok).toBe(true);
      expect(second.reResolved).toBe(true); // the branch under test actually ran
      // the side effect, on the new document. `ok` alone would pass even if the
      // click had gone to the top frame's BODY, which is exactly what it did
      // before the coordinate fix.
      expect(await frameTitle(pool, sid)).toBe("ACKED");
    } finally {
      await pool.shutdown();
    }
  }, 180_000);

  it("hidden frames are SKIPPED and the skip is counted, not silent", async () => {
    // Inlining tracking-pixel and dead-ad text into the prose an agent reads is
    // the noise risk this change introduces. The quads check is the filter, and
    // the count is what keeps the skip from being silent.
    //
    // The boundary is MEASURED (probe-quads.mts), not assumed, and this test
    // pins all three sides of it — including the hole. `display:none` gives no
    // quads and `width=0 height=0 frameborder=0` gives a zero-area quad, which
    // are the two shapes real tracking pixels take. A NAKED `width=0 height=0`
    // still has Chrome's default 2px border, measures 4×4, and IS composed:
    // asserted here so the hole lives in the suite instead of surprising someone
    // on a news page.
    const pool = new SessionPool();
    try {
      const open = await pool.open(`${base}/hidden-frames`);
      expect(open.ok).toBe(true);
      const live = await pool.html(open.sessionId!);
      if ("gone" in live) throw new Error("session gone");
      expect(live.html).toContain("Visible prose");
      expect(live.html).not.toContain("11111"); // display:none — skipped
      expect(live.html).not.toContain("22222"); // 0×0 frameborder=0 — skipped
      expect(live.html).toContain("33333"); // 4×4 because of the border — the hole
      expect(live.frames).toEqual({ composed: 1, hidden: 2, appended: 0 });
    } finally {
      await pool.shutdown();
    }
  }, 120_000);

  it("guard: a page with no frames serializes exactly as it did before", async () => {
    const pool = new SessionPool();
    try {
      const open = await pool.open(`${base}/plain`);
      const live = await pool.html(open.sessionId!);
      if ("gone" in live) throw new Error("session gone");
      expect(live.frames).toBeUndefined();
      expect(live.html).not.toContain("data-veil-frame");
      expect(live.html).toContain("Press me");
    } finally {
      await pool.shutdown();
    }
  }, 120_000);

  it("LOOP: a frame appearing AND disappearing both reach the act receipt", async () => {
    // State that accumulates across calls needs both directions, in one session.
    // A fixture driven one iteration cannot fail this.
    const pool = new SessionPool();
    try {
      const open = await pool.open(`${base}/toggle`);
      expect(open.ok).toBe(true);
      const sid = open.sessionId!;

      const added = await pool.act(sid, "button-add-frame", { kind: "click" });
      expect(added.ok).toBe(true);
      expect(added.diff?.frames?.before).toBe(0);
      expect(added.diff?.frames?.after).toBe(1);

      const removed = await pool.act(sid, "button-remove-frame", { kind: "click" });
      expect(removed.ok).toBe(true);
      expect(removed.diff?.frames?.before).toBe(1);
      expect(removed.diff?.frames?.after).toBe(0);
    } finally {
      await pool.shutdown();
    }
  }, 120_000);
});
