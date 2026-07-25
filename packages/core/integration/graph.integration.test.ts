/**
 * Layer 2 — the graph pipeline against real headless Chrome.
 *
 * The fixture is built around the case that motivates stage 2's existence:
 * a submit button with NO direct event listener, whose behaviour lives entirely
 * in `<form action>`. Measured on github.com/login, `getEventListeners` returns
 * `[]` for exactly that button — so a pipeline that trusted it alone would report
 * a page where nothing does anything.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createServer, type Server } from "node:http";
import { Renderer, chromeAvailable, queryNodes } from "../src/index.js";

const suite = chromeAvailable() ? describe : describe.skip;

const PAGE = `<!doctype html><html><head><title>Sign in — Fixture</title></head><body>
  <a href="#top">Skip to content</a>
  <form action="/session" method="POST">
    <input name="user" aria-label="Username" required>
    <input name="pw" type="password" aria-label="Password" required>
    <!-- no JS listener anywhere: behaviour is purely structural -->
    <button type="submit">Sign in</button>
    <input type="checkbox" aria-label="Remember me">
  </form>
  <button id="js" aria-label="Toggle panel">Toggle</button>
  <button disabled aria-label="Locked">Locked</button>
  <a href="/signup">Create an account</a>
  <a href="/reset">Forgot password?</a>
  <!-- Hacker News' shape: a site-search input with NO label of any kind, inside a
       form that GETs. It is unnamed but it is the only way to search the page. -->
  <form action="/find" method="GET"><input name="q"></form>
  <script>document.getElementById('js').addEventListener('click', function(){});</script>
</body></html>`;

suite("behavior graph — real Chrome (Layer 2)", () => {
  let server: Server;
  let base: string;

  beforeAll(async () => {
    server = createServer((_req, res) => {
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

  it("perceives doers with stable ids, and counts links separately", async () => {
    const r = new Renderer();
    try {
      const p = await r.perceive(`${base}/login`);
      expect(p.ok).toBe(true);
      if (!p.ok) return;

      // doers are addressable by content-derived id
      expect(p.graph.nodes.has("button-sign-in")).toBe(true);
      expect(p.graph.nodes.has("textbox-username")).toBe(true);
      expect(p.graph.nodes.has("checkbox-remember-me")).toBe(true);

      // links are NOT in the doers list — they're counted
      expect(p.graph.links.length).toBeGreaterThanOrEqual(3);
      expect(p.graph.doers).not.toContain("link-create-an-account");
      expect(p.lean).toMatch(/LINKS \(\d+\)/);
      expect(p.lean).not.toMatch(/link-create-an-account \[link\]/);
    } finally {
      await r.close();
    }
  });

  it("surfaces an UNNAMED control — the role is the addressability test, not the name", async () => {
    // Regression: requiring a name hid Hacker News' site search, so the front
    // page reported "nothing on this page is actionable" while holding a node
    // that fires GET //hn.algolia.com/. A live model read that and reported
    // itself stuck. Ids are stable and `fires` describes the node, so an unnamed
    // control is perfectly addressable.
    const r = new Renderer();
    try {
      const p = await r.perceive(`${base}/login`);
      expect(p.ok).toBe(true);
      if (!p.ok) return;

      const unnamed = [...p.graph.nodes.values()].filter((n) => !n.name && n.role !== "link");
      expect(unnamed.length).toBeGreaterThan(0);
      const q = unnamed[0]!;

      // it is a DOER, not filed away as navigation
      expect(p.graph.doers).toContain(q.id);
      // we know what it does, which is what makes it addressable
      expect(q.fires).toMatch(/find/);
      // and it reaches the agent, not just the graph
      expect(p.lean).toContain(q.id);
      expect(p.lean).not.toMatch(/nothing on this page is actionable/);
    } finally {
      await r.close();
    }
  }, 90_000);

  it("recovers what the submit button fires WITHOUT a direct listener (the moat)", async () => {
    const r = new Renderer();
    try {
      const p = await r.perceive(`${base}/login`);
      expect(p.ok).toBe(true);
      if (!p.ok) return;

      const signIn = p.graph.nodes.get("button-sign-in")!;
      // This is the assertion that matters: no JS is bound to this button, yet
      // the graph knows it POSTs to /session.
      expect(signIn.fires).toMatch(/POST \/session/);
      expect(signIn.events.some((e) => e.category === "form_submit")).toBe(true);
      // and stage 2 reports it as structurally derived, not direct
      expect(p.stage2.withStructural).toBeGreaterThan(0);
    } finally {
      await r.close();
    }
  });

  it("captures actionability state and link destinations", async () => {
    const r = new Renderer();
    try {
      const p = await r.perceive(`${base}/login`);
      expect(p.ok).toBe(true);
      if (!p.ok) return;

      expect(p.graph.nodes.get("textbox-username")!.state.required).toBe(true);
      expect(p.graph.nodes.get("button-locked")!.state.disabled).toBe(true);

      // an in-page anchor is NOT navigation
      const skip = p.graph.nodes.get("link-skip-to-content");
      expect(skip?.fires).toMatch(/in-page #top/);

      // a real link is
      const q = queryNodes(p.graph, { name: "Create an account" });
      expect(q.returned[0]?.fires).toMatch(/GET \/signup/);
    } finally {
      await r.close();
    }
  });

  it("finds the direct listener on a JS-wired button", async () => {
    const r = new Renderer();
    try {
      const p = await r.perceive(`${base}/login`);
      expect(p.ok).toBe(true);
      if (!p.ok) return;
      const toggle = p.graph.nodes.get("button-toggle-panel")!;
      expect(toggle.events.some((e) => e.type === "click")).toBe(true);
      expect(p.stage2.withDirect).toBeGreaterThan(0);
    } finally {
      await r.close();
    }
  });
});
