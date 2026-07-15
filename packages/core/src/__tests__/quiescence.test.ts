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

    // a request starts after subscribe and stays in-flight. requestId is
    // required: settle keys in-flight requests by id (real CDP always sends
    // one) so it can tell a young request from a never-closing long-poll.
    setTimeout(() => cdp.emit("Network.requestWillBeSent", { requestId: "r1" }), 5);
    await new Promise((r) => setTimeout(r, 120));
    expect(resolved).toBe(false); // still young + in-flight → held open

    // the request finishes → settle resolves shortly after
    cdp.emit("Network.loadingFinished", { requestId: "r1" });
    await p;
    expect(resolved).toBe(true);
  });

  it("stops waiting on a request older than longLivedMs (long-poll)", async () => {
    // The quiescence-cap fix (DECISIONS 2026-07-15), hermetically: a request
    // that never finishes must stop blocking settle once it's too old to be
    // what the page is waiting on — otherwise settle degrades into a flat
    // cap-length timeout on every action (google.com: 14.1s per call).
    const cdp = new FakeCDPClient();
    const start = Date.now();
    // Never balanced by loadingFinished — a long-poll.
    setTimeout(() => cdp.emit("Network.requestWillBeSent", { requestId: "poll-1" }), 5);
    await awaitQuiescence(cdp, { quietMs: 30, longLivedMs: 150, capMs: 5_000 });
    const elapsed = Date.now() - start;
    expect(elapsed).toBeGreaterThanOrEqual(140); // waited while it was young
    expect(elapsed).toBeLessThan(1_000); // but did NOT burn the 5s cap
  });

  it("honors the hard cap on a page that never goes idle", async () => {
    const cdp = new FakeCDPClient();
    // keep firing NEW requests forever (never balanced by loadingFinished), so
    // there is always a young one in flight → only the cap can end this.
    let n = 0;
    const timer = setInterval(
      () => cdp.emit("Network.requestWillBeSent", { requestId: `r${n++}` }),
      10,
    );
    const start = Date.now();
    await awaitQuiescence(cdp, { quietMs: 30, capMs: 200 });
    clearInterval(timer);
    // resolves via the cap, not hanging forever
    const elapsed = Date.now() - start;
    expect(elapsed).toBeGreaterThanOrEqual(180);
    expect(elapsed).toBeLessThan(600);
  });
});
