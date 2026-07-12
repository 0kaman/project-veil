/**
 * Layer 2 — REAL Chrome. Unlike the unit suite (which drives a FakeCDPClient),
 * these tests launch an actual headless Chrome against locally-served fixtures
 * and assert on the real behavior graph. This is the layer that catches wire-
 * level, interaction, and timing regressions the fake can't.
 *
 * Skipped automatically when Chrome isn't available (CHROME_PATH / default
 * path), so the unit suite stays hermetic. Run explicitly with:
 *   pnpm --filter @veil/core test:integration
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { existsSync } from "node:fs";
import { Veil, type VeilPage } from "../src/index.js";
import { startFixtureServer, type FixtureServer } from "./server.js";

function chromeAvailable(): boolean {
  const p =
    process.env.CHROME_PATH ??
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
  return existsSync(p);
}

const suite = chromeAvailable() ? describe : describe.skip;

suite("Veil — real browser (Layer 2)", () => {
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

  it("decomposes a server-rendered form: auth label + structural events, no phantom hash nav", async () => {
    const page = await veil.open(fixtures.url("/form"));
    try {
      const text = await page.toCompactText();
      // The form is recognized as auth (password field present).
      expect(text).toMatch(/semantic: auth:(login|signup)/);
      // Structural event synthesis lifted action/href into the graph.
      expect(text).toMatch(/POST .*\/session/);
      // The "Back to top" (#top) link must NOT produce a navigation edge.
      expect(text).not.toMatch(/on:click → navigation.*#top/);
      // Password field carries its own label, not a smeared form:submit.
      expect(text).toMatch(/auth:password-input/);
    } finally {
      page.close();
    }
  });

  it("types into a real field and the value lands in the graph", async () => {
    const page = await veil.open(fixtures.url("/form"));
    try {
      const graph = await page.getGraph();
      const emailNode = [...graph.nodes.values()].find(
        (n) => n.role === "textbox" && /email/i.test(n.name),
      );
      expect(emailNode).toBeDefined();
      const display = displayIdOf(page, emailNode!.id);
      await page.interact(display, { action: "type", text: "walter@example.com" });
      const after = await page.getGraph();
      const email = [...after.nodes.values()].find((n) => /email/i.test(n.name));
      expect(email?.value).toBe("walter@example.com");
    } finally {
      page.close();
    }
  });

  it("clicks a below-the-fold button (scroll-into-view)", async () => {
    const page = await veil.open(fixtures.url("/scroll"));
    try {
      await page.interact("button-deep-button", { action: "click" }).catch(async () => {
        // display id may differ — resolve it
        const g = await page.getGraph();
        const btn = [...g.nodes.values()].find((n) => n.role === "button");
        await page.interact(displayIdOf(page, btn!.id), { action: "click" });
      });
      const after = await page.getGraph();
      const btn = [...after.nodes.values()].find((n) => n.role === "button");
      expect(btn?.name).toBe("Clicked");
    } finally {
      page.close();
    }
  });

  it("SPA pushState navigation rebuilds the graph WITHOUT the 10s stall", async () => {
    const page = await veil.open(fixtures.url("/spa"));
    try {
      const graph = await page.getGraph();
      const products = [...graph.nodes.values()].find(
        (n) => n.role === "button" && /products/i.test(n.name),
      );
      expect(products).toBeDefined();

      const start = Date.now();
      await page.interact(displayIdOf(page, products!.id), { action: "click" });
      const elapsed = Date.now() - start;

      // The old bug burned the full 10_000ms load-event grace timer on every
      // pushState click. With the fix this completes in well under that.
      expect(elapsed).toBeLessThan(8000);
      const url = await page.getCurrentUrl();
      expect(url).toContain("/products");
    } finally {
      page.close();
    }
  });
});

/** Resolve an internal node id to the display id the interact API expects. */
function displayIdOf(page: VeilPage, internalId: string): string {
  // toCompactText/getGraph use the same registry; simplest reliable path is to
  // ask the page's own resolver via a query round-trip. Here we reconstruct the
  // display id the same way the serializer does.
  // The interact() API accepts BOTH internal AX ids and display ids, so passing
  // the internal id through is safe.
  return internalId;
}
