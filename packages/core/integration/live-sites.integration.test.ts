/**
 * Live real-site smoke tests — Veil against actual production websites.
 *
 * This is NOT hermetic: it hits the public internet, so it is OFF by default and
 * only runs with VEIL_LIVE=1 (and Chrome present). CI stays deterministic; this
 * is the layer you run to check Veil survives real-world mess — the whole reason
 * the project exists.
 *
 *   VEIL_LIVE=1 pnpm --filter @veil/core test:integration
 *
 * Assertions are deliberately REDESIGN-ROBUST: they check structural invariants
 * (a graph builds, has interactive nodes, serializes cleanly, compresses) rather
 * than specific markup that a site redesign would break.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { existsSync } from "node:fs";
import { Veil } from "../src/index.js";

function chromeAvailable(): boolean {
  const p = process.env.CHROME_PATH ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
  return existsSync(p);
}
const enabled = process.env.VEIL_LIVE === "1" && chromeAvailable();
const suite = enabled ? describe : describe.skip;

suite("Veil — live real sites (VEIL_LIVE=1)", () => {
  let veil: Veil;
  beforeAll(() => {
    veil = new Veil();
  });
  afterAll(async () => {
    await veil.close();
  });

  it("example.com: minimal page builds a valid graph", async () => {
    const page = await veil.open("https://example.com");
    try {
      const g = await page.getGraph();
      expect(g.nodes.size).toBeGreaterThan(0);
      expect(g.metadata.url).toContain("example.com");
      // serializes without corruption regardless of content
      const text = await page.toCompactText();
      expect(text).toContain("PAGE ");
    } finally {
      page.close();
    }
  });

  it("github.com/login: a real login page yields interactive + auth-ish structure", async () => {
    const page = await veil.open("https://github.com/login");
    try {
      const g = await page.getGraph();
      const nodes = [...g.nodes.values()];
      // structural invariants that survive redesigns:
      expect(g.nodes.size).toBeGreaterThan(3);
      expect(nodes.some((n) => n.role === "textbox")).toBe(true);      // has inputs
      expect(nodes.some((n) => n.role === "button" || n.role === "link")).toBe(true);
      // it's a login page — SOME node should read as auth OR be a password field
      const authish =
        nodes.some((n) => n.semanticLabel?.category === "auth") ||
        nodes.some((n) => n.role === "textbox" && /password/i.test(n.name));
      expect(authish).toBe(true);
      // the compact text is well-formed (every node on its own line)
      const text = await page.toCompactText();
      expect(text.startsWith("PAGE ")).toBe(true);
    } finally {
      page.close();
    }
  });

  it("a content-heavy page builds and stays under the hard node cap", async () => {
    // MDN is content-dense but app-shaped — a good stress case that should still
    // build in time. (Encyclopedia-scale pages like Wikipedia articles can exceed
    // the default nav timeout — a documented limitation, not asserted here.)
    const page = await veil.open("https://developer.mozilla.org/en-US/");
    try {
      const g = await page.getGraph();
      expect(g.nodes.size).toBeGreaterThan(20);
      // sanity ceiling: even a dense page shouldn't blow past a few thousand
      // behavior nodes (if it does, the AX filter regressed).
      expect(g.nodes.size).toBeLessThan(4000);
      // real semantic coverage on a real site
      expect([...g.nodes.values()].filter((n) => n.semanticLabel).length).toBeGreaterThan(0);
    } finally {
      page.close();
    }
  });
});
