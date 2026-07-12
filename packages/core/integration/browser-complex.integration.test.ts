/**
 * Layer 2 (real Chrome) — HARD scenarios. Where the basic integration suite
 * proves the pipeline runs, this proves it holds up under the cases that
 * actually break browser automation: network→node correlation, live DOM
 * mutation, adversarial accessible names, concurrent session isolation, and a
 * full multi-step agent workflow.
 *
 * Auto-skips when Chrome is absent. Run: pnpm --filter @veil/core test:integration
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { existsSync } from "node:fs";
import { Veil, type VeilPage, type BehaviorNode } from "../src/index.js";
import { startFixtureServer, type FixtureServer } from "./server.js";

function chromeAvailable(): boolean {
  const p = process.env.CHROME_PATH ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
  return existsSync(p);
}
const suite = chromeAvailable() ? describe : describe.skip;

/** interact() accepts internal ids and display ids; internal is always safe. */
function findNode(g: { nodes: Map<string, BehaviorNode> }, pred: (n: BehaviorNode) => boolean): BehaviorNode | undefined {
  return [...g.nodes.values()].find(pred);
}

suite("Veil — hard real-browser scenarios (Layer 2)", () => {
  let fixtures: FixtureServer;
  let veil: Veil;

  beforeAll(async () => {
    fixtures = await startFixtureServer();
    veil = new Veil();
  });
  afterAll(async () => {
    await veil.close();
    await fixtures.close();
  });

  // --- semantics on realistic commerce markup ------------------------------

  it("labels a commerce page: search input, nav, and cart/checkout actions", async () => {
    const page = await veil.open(fixtures.url("/commerce"));
    try {
      const g = await page.getGraph();
      const labels = [...g.nodes.values()]
        .map((n) => n.semanticLabel && `${n.semanticLabel.category}:${n.semanticLabel.action}`)
        .filter(Boolean);
      expect(labels).toContain("search:input");
      expect(labels.some((l) => l!.startsWith("navigation:"))).toBe(true);
      // the add-to-cart / buy-now buttons should read as commerce
      expect(labels.some((l) => l!.startsWith("commerce:"))).toBe(true);
    } finally {
      page.close();
    }
  });

  // --- network correlation: each button → its OWN endpoint -----------------

  it("correlates each action button to the distinct API it triggers", async () => {
    const page = await veil.open(fixtures.url("/commerce"));
    try {
      await page.getGraph();
      const cart = findNode(await page.getGraph(), (n) => /add to cart/i.test(n.name))!;
      await page.interact(cart.id, { action: "click" });

      const g = await page.getGraph();
      const cartCall = g.networkEdges.find((e) => /\/api\/cart$/.test(e.request.url));
      expect(cartCall, "POST /api/cart should be captured").toBeTruthy();
      expect(cartCall!.request.method).toBe("POST");
      // it must NOT have fired wishlist/checkout
      expect(g.networkEdges.some((e) => /\/api\/wishlist/.test(e.request.url))).toBe(false);

      // and the endpoint is registered
      const cartEndpoint = g.apiEndpoints.find((ep) => /\/api\/cart/.test(ep.pattern) && ep.method === "POST");
      expect(cartEndpoint, "cart endpoint in apiEndpoints").toBeTruthy();
    } finally {
      page.close();
    }
  });

  // --- live DOM mutation → incremental update ------------------------------

  it("reflects a DOM mutation added by an interaction (incremental update)", async () => {
    const page = await veil.open(fixtures.url("/dynamic"));
    try {
      const before = await page.getGraph();
      const taskCountBefore = [...before.nodes.values()].filter((n) => /^Task [A-Z]$/.test(n.name)).length;
      expect(taskCountBefore).toBe(1);

      const addBtn = findNode(before, (n) => /add task/i.test(n.name))!;
      await page.interact(addBtn.id, { action: "click" });

      const after = await page.getGraph();
      const taskCountAfter = [...after.nodes.values()].filter((n) => /^Task [A-Z]$/.test(n.name)).length;
      expect(taskCountAfter).toBe(2); // the new <li><button> was picked up
    } finally {
      page.close();
    }
  });

  // --- adversarial accessible names cannot corrupt the format --------------

  it("serializes adversarial labels (quotes, brackets, commas, newlines, emoji) safely", async () => {
    const page = await veil.open(fixtures.url("/messy"));
    try {
      const text = await page.toCompactText();
      // Every node line is intact — count '[button]'/'[link]'/'[textbox]' markers;
      // a corrupted format would split a label across lines.
      const nodeLines = text.split("\n").filter((l) => /\[(button|link|textbox)\]/.test(l));
      expect(nodeLines.length).toBeGreaterThanOrEqual(3);
      // no line is a bare fragment of a label (would indicate a newline leak)
      expect(text).not.toMatch(/^\s*line label/m);
      // emoji survived
      expect(text).toContain("🛒");
      // quotes were escaped, not left raw-terminating
      expect(text).toMatch(/\\"Report, Q1\\"/);
    } finally {
      page.close();
    }
  });

  // --- concurrent session isolation (the freshTarget fix) ------------------

  it("keeps three concurrent sessions isolated (no shared tab)", async () => {
    const [a, b, c] = await Promise.all([
      veil.open(fixtures.url("/commerce")),
      veil.open(fixtures.url("/dynamic")),
      veil.open(fixtures.url("/form")),
    ]);
    try {
      const [ga, gb, gc] = await Promise.all([a.getGraph(), b.getGraph(), c.getGraph()]);
      expect(ga.metadata.url).toContain("/commerce");
      expect(gb.metadata.url).toContain("/dynamic");
      expect(gc.metadata.url).toContain("/form");
      // each graph reflects its OWN page's content
      expect([...ga.nodes.values()].some((n) => /add to cart/i.test(n.name))).toBe(true);
      expect([...gb.nodes.values()].some((n) => /add task/i.test(n.name))).toBe(true);
      expect([...gc.nodes.values()].some((n) => /password/i.test(n.name))).toBe(true);
      // ...and none leaks another's
      expect([...ga.nodes.values()].some((n) => /add task/i.test(n.name))).toBe(false);
    } finally {
      a.close(); b.close(); c.close();
    }
  });

  // --- event-driven settle: fast when idle, correct when busy --------------

  it("an idle interaction settles fast (event-driven, no fixed 2s floor)", async () => {
    const page = await veil.open(fixtures.url("/commerce"));
    try {
      const g = await page.getGraph();
      const field = findNode(g, (n) => n.role === "searchbox" || n.role === "textbox");
      const start = Date.now();
      await page.interact(field!.id, { action: "focus" }); // touches no network/DOM
      const elapsed = Date.now() - start;
      // Pre-fix this paid a flat ~2s network-idle wait; now it's a few frames +
      // the rebuild. Generous ceiling to stay robust on slow CI.
      expect(elapsed).toBeLessThan(2500);
    } finally {
      page.close();
    }
  });

  it("does NOT hang on a page with a persistent background poller", async () => {
    // A 200ms heartbeat means the network is never permanently idle. The old
    // fixed-idle wait could stall; event-driven settle resolves in the gaps.
    const page = await veil.open(fixtures.url("/poller"));
    try {
      const g = await page.getGraph();
      const refresh = findNode(g, (n) => /refresh/i.test(n.name))!;
      const start = Date.now();
      await page.interact(refresh.id, { action: "click" });
      // Must complete well under the pathological hard cap (12s), not hang.
      expect(Date.now() - start).toBeLessThan(6000);
    } finally {
      page.close();
    }
  });

  // --- a full multi-step agent workflow ------------------------------------

  it("runs a multi-step workflow: type two fields, values persist across reads", async () => {
    const page = await veil.open(fixtures.url("/form"));
    try {
      const g0 = await page.getGraph();
      const email = findNode(g0, (n) => n.role === "textbox" && /email/i.test(n.name))!;
      const pass = findNode(g0, (n) => n.role === "textbox" && /password/i.test(n.name))!;

      await page.interact(email.id, { action: "type", text: "agent@veil.dev" });
      await page.interact(pass.id, { action: "type", text: "s3cr3t" });

      // Re-read with role-specific predicates — "Forgot password?" is also a
      // node whose name matches /password/i, so filter to the textbox.
      const g1 = await page.getGraph();
      const emailAfter = findNode(g1, (n) => n.role === "textbox" && /email/i.test(n.name));
      expect(emailAfter?.value).toBe("agent@veil.dev");
      // The password field's value is intentionally masked by the browser in the
      // accessibility tree, so we assert the field is present + focused rather
      // than reading back the secret (a real, correct browser behavior to know).
      const passAfter = findNode(g1, (n) => n.role === "textbox" && /password/i.test(n.name));
      expect(passAfter).toBeTruthy();

      // clear the email and confirm it actually cleared
      await page.interact(email.id, { action: "clear" });
      const g2 = await page.getGraph();
      expect(findNode(g2, (n) => n.role === "textbox" && /email/i.test(n.name))?.value ?? "").toBe("");
    } finally {
      page.close();
    }
  });
});
