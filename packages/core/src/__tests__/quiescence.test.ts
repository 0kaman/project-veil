/**
 * awaitQuiescence — event-driven settle. Drives the FakeCDPClient (which returns
 * {} for Runtime.evaluate, so __veil is "absent" → the host-side fallback path
 * runs). Proves: idle resolves in ~a frame, and in-flight work holds it open
 * until the work drains — no fixed 2s floor.
 */
import { describe, it, expect } from "vitest";
import { awaitQuiescence } from "../browser/page.js";
import { FakeCDPClient } from "./fixtures/fake-cdp.js";

describe("awaitQuiescence (host fallback)", () => {
  it("resolves quickly when the page is already idle", async () => {
    const cdp = new FakeCDPClient();
    const start = Date.now();
    await awaitQuiescence(cdp, { quietMs: 30 });
    // no in-flight work → resolves after ~one quiet window, nowhere near 2s
    expect(Date.now() - start).toBeLessThan(300);
  });

  it("waits until in-flight requests drain, then resolves", async () => {
    const cdp = new FakeCDPClient();
    let resolved = false;
    const p = awaitQuiescence(cdp, { quietMs: 30 }).then(() => { resolved = true; });

    // a request starts after subscribe and stays in-flight
    setTimeout(() => cdp.emit("Network.requestWillBeSent", {}), 5);
    await new Promise((r) => setTimeout(r, 120));
    expect(resolved).toBe(false); // still in-flight → held open

    // the request finishes → settle resolves shortly after
    cdp.emit("Network.loadingFinished", {});
    await p;
    expect(resolved).toBe(true);
  });

  it("honors the hard cap on a page that never goes idle", async () => {
    const cdp = new FakeCDPClient();
    // keep firing requests forever (never balanced by loadingFinished)
    const timer = setInterval(() => cdp.emit("Network.requestWillBeSent", {}), 10);
    const start = Date.now();
    await awaitQuiescence(cdp, { quietMs: 30, capMs: 200 });
    clearInterval(timer);
    // resolves via the cap, not hanging forever
    const elapsed = Date.now() - start;
    expect(elapsed).toBeGreaterThanOrEqual(180);
    expect(elapsed).toBeLessThan(600);
  });
});
