/**
 * Layer 2 — the quiescence settle vs a page holding a connection open forever.
 *
 * Regression test for DECISIONS 2026-07-15: `whenQuiet` required ZERO in-flight
 * fetch/XHR, so a single never-closing request (google's autocomplete XHR, a
 * chat socket, SSE-over-XHR) pinned it and every action burned the full 12s
 * cap. Measured on google.com: veil_open 14.1s, of which the pipeline was 211ms.
 *
 * Must be Layer 2: the bug lives in injected page-side JS reacting to real
 * network timing. FakeCDPClient cannot express "a socket that never closes".
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { existsSync } from "node:fs";
import { Veil } from "../src/index.js";
import { startFixtureServer, type FixtureServer } from "./server.js";

function chromeAvailable(): boolean {
  const p =
    process.env.CHROME_PATH ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
  return existsSync(p);
}

const suite = chromeAvailable() ? describe : describe.skip;

suite("quiescence vs long-lived connections (Layer 2)", () => {
  let server: FixtureServer;

  beforeAll(async () => {
    server = await startFixtureServer();
  });

  afterAll(async () => {
    await server.close();
  });

  it("settles promptly on a page holding a never-closing request", async () => {
    const veil = new Veil();
    try {
      const t0 = Date.now();
      const page = await veil.open(server.url("/longpoll"));
      const openMs = Date.now() - t0;

      // The cap is 12s; the long-lived window is 2s. Before the fix this page
      // burned the whole cap. Generous bound — we assert "didn't hit the cap",
      // not a precise number, so this can't flake on a slow machine.
      expect(openMs).toBeLessThan(8_000);

      // Settling early must not cost us the graph.
      const graph = await page.getGraph();
      expect([...graph.nodes.values()].some((n) => n.role === "button")).toBe(true);
      page.close();
    } finally {
      await veil.close();
    }
  }, 60_000);

  it("still waits for a real in-flight request (no premature settle)", async () => {
    // The guard on the fix. Ignoring OLD connections must not mean ignoring
    // young ones: a request the page is genuinely waiting on has to keep
    // blocking settle, or Stage 3 silently loses the edges it exists to
    // capture — which would trade a latency bug for a correctness bug.
    const veil = new Veil();
    try {
      const page = await veil.open(server.url("/longpoll"));
      await page.getGraph();

      const graph = await page.interact("button-send", { action: "click" });

      // Assert on the network edge, not on DOM text: a plain <div> is generic,
      // so Stage 1 drops it and it can never appear in the graph.
      const post = graph.networkEdges.find(
        (e) => e.request.method === "POST" && e.request.url.includes("/api/send"),
      );
      expect(post, "the click's POST should have been captured").toBeDefined();
      expect(post?.response?.status, "settle returned before the POST resolved").toBe(200);
      page.close();
    } finally {
      await veil.close();
    }
  }, 60_000);

  it("burns the cap when the long-lived window is disabled (proves the fix is load-bearing)", async () => {
    // VEIL_LONGPOLL_MS enormous ⇒ nothing is ever "too old", which is exactly
    // the pre-fix condition. If this DOESN'T get slow, the test above proves
    // nothing. Cap lowered to 3s to keep the suite quick.
    const prevLong = process.env.VEIL_LONGPOLL_MS;
    const prevCap = process.env.VEIL_QUIESCE_CAP_MS;
    process.env.VEIL_LONGPOLL_MS = "999999999";
    process.env.VEIL_QUIESCE_CAP_MS = "3000";
    const veil = new Veil();
    try {
      const t0 = Date.now();
      const page = await veil.open(server.url("/longpoll"));
      const openMs = Date.now() - t0;
      expect(openMs, "old behaviour should burn the full cap").toBeGreaterThanOrEqual(2_800);
      page.close();
    } finally {
      await veil.close();
      if (prevLong === undefined) delete process.env.VEIL_LONGPOLL_MS;
      else process.env.VEIL_LONGPOLL_MS = prevLong;
      if (prevCap === undefined) delete process.env.VEIL_QUIESCE_CAP_MS;
      else process.env.VEIL_QUIESCE_CAP_MS = prevCap;
    }
  }, 60_000);
});
