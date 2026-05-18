import { describe, it, expect } from "vitest";
import { FakeCDPClient } from "./fixtures/fake-cdp.js";
import {
  waitForNetworkIdle,
  waitForDomSettle,
  waitForSettleOrNavigation,
} from "../browser/page.js";

/**
 * Primitive-level leak tests — sanity checks that the individual settle
 * helpers clean up their listeners. These were never broken, but they
 * are the building blocks B2 composes.
 */
describe("waitForNetworkIdle / waitForDomSettle — primitive leak resistance", () => {
  it("waitForNetworkIdle removes all listeners on resolution", async () => {
    const cdp = new FakeCDPClient();
    await waitForNetworkIdle(cdp);
    expect(cdp.listenerCount("Network.requestWillBeSent")).toBe(0);
    expect(cdp.listenerCount("Network.loadingFinished")).toBe(0);
    expect(cdp.listenerCount("Network.loadingFailed")).toBe(0);
  }, 10_000);

  it("waitForDomSettle removes all listeners on resolution", async () => {
    const cdp = new FakeCDPClient();
    await waitForDomSettle(cdp, 50, 200);
    expect(cdp.totalListenerCount()).toBe(0);
  });

  it("waitForDomSettle resets debounce on activity", async () => {
    const cdp = new FakeCDPClient();
    const promise = waitForDomSettle(cdp, 100, 1000);
    await new Promise((r) => setTimeout(r, 50));
    cdp.emit("DOM.childNodeInserted", {});
    await promise;
    expect(cdp.totalListenerCount()).toBe(0);
  });
});

/**
 * B2 regression tests — verify the actual composition that was broken.
 * Pre-fix: settle-throw never called `done()`, the Page.frameNavigated
 * listener leaked, and the promise hung forever.
 */
describe("waitForSettleOrNavigation — settle-throw leak (B2)", () => {
  it("clears Page.frameNavigated listener on normal settle", async () => {
    const cdp = new FakeCDPClient();
    await waitForSettleOrNavigation(cdp);
    expect(cdp.listenerCount("Page.frameNavigated")).toBe(0);
  }, 10_000);

  it("clears Page.frameNavigated listener when a top-level navigation fires", async () => {
    const cdp = new FakeCDPClient();
    // Fire a top-frame navigation shortly after the function starts.
    setTimeout(() => {
      cdp.emit("Page.frameNavigated", { frame: { parentId: undefined } });
    }, 20);
    await waitForSettleOrNavigation(cdp);
    expect(cdp.listenerCount("Page.frameNavigated")).toBe(0);
  });

  it("ignores subframe navigations", async () => {
    const cdp = new FakeCDPClient();
    let resolved = false;
    const promise = waitForSettleOrNavigation(cdp).then(() => { resolved = true; });

    // Fire only subframe navigations — should NOT short-circuit the settle wait.
    setTimeout(() => {
      cdp.emit("Page.frameNavigated", { frame: { parentId: "ad-iframe-1" } });
      cdp.emit("Page.frameNavigated", { frame: { parentId: "ad-iframe-2" } });
    }, 20);

    // At 100ms, settle hasn't naturally completed yet (network idle wait is 2s).
    await new Promise((r) => setTimeout(r, 100));
    expect(resolved).toBe(false);

    // Now fire a real top-frame nav to unblock.
    cdp.emit("Page.frameNavigated", { frame: { parentId: undefined } });
    await promise;
    expect(resolved).toBe(true);
    expect(cdp.listenerCount("Page.frameNavigated")).toBe(0);
  }, 10_000);

  it("does NOT leak Page.frameNavigated listener when the inner settle path throws", async () => {
    // The B2 bug scenario: simulate waitForNetworkIdle behavior by injecting
    // a CDPClient whose `on(Network.requestWillBeSent)` throws synchronously.
    // The settle promise rejects; the outer function must catch via the
    // race+catch pattern and still clean up.
    const cdp = new FakeCDPClient();
    const origOn = cdp.on.bind(cdp);
    cdp.on = ((event: string, cb: (params: unknown) => void) => {
      if (event === "Network.requestWillBeSent") {
        throw new Error("simulated CDP failure");
      }
      origOn(event, cb);
    }) as typeof cdp.on;

    // Function must not throw, must not hang, must clean up.
    await waitForSettleOrNavigation(cdp);
    expect(cdp.listenerCount("Page.frameNavigated")).toBe(0);
  }, 5_000);
});
