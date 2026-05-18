import { createCDPClient, type CDPClient } from "./cdp-client.js";
import { NetworkCapture } from "./network-capture.js";
import { INSTRUMENTATION_SCRIPT } from "./instrumentation.js";
import type { NetworkRequest } from "../graph/model.js";

export interface AXNode {
  nodeId: string;
  ignored: boolean;
  role?: { type: string; value: string };
  name?: { type: string; value: string };
  description?: { type: string; value: string };
  value?: { type: string; value: string };
  properties?: Array<{ name: string; value: { type: string; value: unknown } }>;
  parentId?: string;
  childIds?: string[];
  backendDOMNodeId?: number;
}

export interface PageHandle {
  cdp: CDPClient;
  navigate(url: string, timeoutMs?: number): Promise<void>;
  getAXTree(): Promise<AXNode[]>;
  getTitle(): Promise<string>;
  getCapturedRequests(): NetworkRequest[];
  getNewCapturedRequests(): NetworkRequest[];
  startNetworkCapture(): Promise<void>;
  getCurrentUrl(): Promise<string>;
  close(): void;
}

export async function connectToPage(
  port: number,
  targetUrl?: string,
): Promise<PageHandle> {
  const listResp = await fetch(`http://127.0.0.1:${port}/json`);
  const targets = (await listResp.json()) as Array<{
    type: string;
    webSocketDebuggerUrl: string;
    url: string;
  }>;

  let target = targets.find((t) => t.type === "page");
  if (!target) {
    // No page target yet — create one via /json/new
    const newResp = await fetch(`http://127.0.0.1:${port}/json/new`);
    target = (await newResp.json()) as {
      type: string;
      webSocketDebuggerUrl: string;
      url: string;
    };
  }
  if (!target?.webSocketDebuggerUrl) {
    throw new Error("No page target found and could not create one");
  }

  const cdp = await createCDPClient(target.webSocketDebuggerUrl);

  await Promise.all([
    cdp.send("Page.enable"),
    cdp.send("DOM.enable"),
    cdp.send("Accessibility.enable"),
    cdp.send("Runtime.enable"),
    cdp.send("Network.enable"),
    cdp.send("Debugger.enable"),
  ]);

  // Required for DOM mutation events — CDP only sends events for tracked nodes
  await cdp.send("DOM.getDocument", { depth: -1 });

  await cdp.send("Page.addScriptToEvaluateOnNewDocument", {
    source: INSTRUMENTATION_SCRIPT,
  });

  const networkCapture = new NetworkCapture(cdp);

  // Start capture immediately so requests are collected from the start
  await networkCapture.start();

  const navigate = async (url: string, timeoutMs = 30_000): Promise<void> => {
    const loadPromise = new Promise<void>((resolve) => {
      const handler = () => {
        cdp.off("Page.loadEventFired", handler);
        resolve();
      };
      cdp.on("Page.loadEventFired", handler);
    });

    await cdp.send("Page.navigate", { url });

    await Promise.race([
      loadPromise,
      new Promise<void>((_, reject) =>
        setTimeout(() => reject(new Error("Navigation timed out")), timeoutMs),
      ),
    ]);

    await waitForNetworkIdle(cdp);
  };

  const getAXTree = async (): Promise<AXNode[]> => {
    const result = (await cdp.send("Accessibility.getFullAXTree")) as {
      nodes: AXNode[];
    };
    return result.nodes;
  };

  const getTitle = async (): Promise<string> => {
    const result = (await cdp.send("Runtime.evaluate", {
      expression: "document.title",
      returnByValue: true,
    })) as { result: { value: string } };
    return result.result.value ?? "";
  };

  const startNetworkCapture = async (): Promise<void> => {
    await networkCapture.start();
  };

  const getCurrentUrl = async (): Promise<string> => {
    const result = (await cdp.send("Runtime.evaluate", {
      expression: "window.location.href",
      returnByValue: true,
    })) as { result: { value: string } };
    return result.result.value ?? "";
  };

  return {
    cdp,
    navigate,
    getAXTree,
    getTitle,
    getCapturedRequests() {
      return networkCapture.drain();
    },
    getNewCapturedRequests() {
      return networkCapture.drainNew();
    },
    startNetworkCapture,
    getCurrentUrl,
    close() {
      networkCapture.drain(); // detach listeners, discard data
      cdp.close();
    },
  };
}

/**
 * Wait until no DOM mutation events have been received for `quietMs`.
 * Hard cap at `maxMs` to avoid infinite waits on rapid mutations.
 */
export function waitForDomSettle(cdp: CDPClient, quietMs = 150, maxMs = 2_000): Promise<void> {
  return new Promise<void>((resolve) => {
    let timer: ReturnType<typeof setTimeout> | undefined;

    const reset = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(done, quietMs);
    };

    const done = () => {
      cdp.off("DOM.childNodeInserted", reset);
      cdp.off("DOM.childNodeRemoved", reset);
      cdp.off("DOM.attributeModified", reset);
      if (timer) clearTimeout(timer);
      clearTimeout(hardCap);
      resolve();
    };

    cdp.on("DOM.childNodeInserted", reset);
    cdp.on("DOM.childNodeRemoved", reset);
    cdp.on("DOM.attributeModified", reset);

    // If DOM is already quiet, resolve after quietMs
    timer = setTimeout(done, quietMs);

    // Hard cap to prevent infinite waiting
    const hardCap = setTimeout(done, maxMs);
  });
}

/**
 * Wait for network idle + DOM settle, but abort early if a top-level
 * frame navigation fires. Subframe navigations (iframes) are ignored.
 *
 * Cleanup is guaranteed via try/finally: if either settle primitive throws,
 * the Page.frameNavigated listener is still removed. The previous
 * `.then().then()` chain had no `.catch()`, so a settle-throw left the
 * listener dangling and any caller awaiting this promise hung forever.
 */
export async function waitForSettleOrNavigation(cdp: CDPClient): Promise<void> {
  let settled = false;
  let resolveNav: (() => void) | null = null;

  const onNav = (params: unknown) => {
    const frame = (params as { frame?: { parentId?: string } })?.frame;
    if (frame?.parentId) return;
    if (settled) return;
    settled = true;
    resolveNav?.();
  };

  cdp.on("Page.frameNavigated", onNav);

  try {
    const navPromise = new Promise<void>((r) => { resolveNav = r; });
    const settlePromise = (async () => {
      await waitForNetworkIdle(cdp);
      await waitForDomSettle(cdp);
      if (!settled) settled = true;
    })();

    await Promise.race([navPromise, settlePromise.catch(() => {})]);
  } finally {
    cdp.off("Page.frameNavigated", onNav);
  }
}

export async function waitForNetworkIdle(cdp: CDPClient): Promise<void> {
  let inflight = 0;
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  const IDLE_WAIT = 2_000;
  const HARD_CAP = 5_000;

  return new Promise<void>((resolve) => {
    const onRequest = () => {
      inflight++;
      if (idleTimer) {
        clearTimeout(idleTimer);
        idleTimer = undefined;
      }
    };

    const onDone = () => {
      inflight = Math.max(0, inflight - 1);
      if (inflight === 0 && !idleTimer) {
        idleTimer = setTimeout(cleanup, IDLE_WAIT);
      }
    };

    const cleanup = () => {
      cdp.off("Network.requestWillBeSent", onRequest);
      cdp.off("Network.loadingFinished", onDone);
      cdp.off("Network.loadingFailed", onDone);
      if (idleTimer) clearTimeout(idleTimer);
      if (hardCapTimer) clearTimeout(hardCapTimer);
      resolve();
    };

    cdp.on("Network.requestWillBeSent", onRequest);
    cdp.on("Network.loadingFinished", onDone);
    cdp.on("Network.loadingFailed", onDone);

    // Start idle timer immediately (page might already be idle)
    if (inflight === 0) {
      idleTimer = setTimeout(cleanup, IDLE_WAIT);
    }

    const hardCapTimer = setTimeout(cleanup, HARD_CAP);
  });
}
