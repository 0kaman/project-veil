import { createCDPClient, type CDPClient } from "./cdp-client.js";
import { NetworkCapture } from "./network-capture.js";
import { INSTRUMENTATION_SCRIPT } from "./instrumentation.js";
import type { NetworkRequest } from "../graph/model.js";
import { debugLog } from "../debug.js";

// Default navigation timeout; encyclopedia-scale pages need more than the old
// hard 30s. Configurable via env; navigation soft-fails (partial graph) rather
// than throwing when it's exceeded.
const NAV_TIMEOUT_MS = Number(process.env.VEIL_NAV_TIMEOUT_MS) || 45_000;

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
  settleNetwork(timeoutMs?: number): Promise<void>;
  startNetworkCapture(): Promise<void>;
  getCurrentUrl(): Promise<string>;
  close(): void;
}

export async function connectToPage(
  port: number,
  targetUrl?: string,
  freshTarget = false,
): Promise<PageHandle> {
  type Target = { id?: string; type: string; webSocketDebuggerUrl: string; url: string };
  let target: Target | undefined;

  if (freshTarget) {
    // Always create a DEDICATED tab so concurrent sessions are isolated —
    // otherwise every session attaches to the first shared page target and one
    // session's navigate() hijacks another's page.
    const newResp = await fetch(`http://127.0.0.1:${port}/json/new`, { method: "PUT" });
    target = (await newResp.json()) as Target;
  } else {
    const listResp = await fetch(`http://127.0.0.1:${port}/json`);
    const targets = (await listResp.json()) as Target[];
    target = targets.find((t) => t.type === "page");
    if (!target) {
      const newResp = await fetch(`http://127.0.0.1:${port}/json/new`, { method: "PUT" });
      target = (await newResp.json()) as Target;
    }
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

  const navigate = async (url: string, timeoutMs = NAV_TIMEOUT_MS): Promise<void> => {
    let handler: (() => void) | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let timedOut = false;
    try {
      const loadPromise = new Promise<void>((resolve) => {
        handler = () => resolve();
        cdp.on("Page.loadEventFired", handler);
      });

      await cdp.send("Page.navigate", { url });

      // SOFT-fail: an encyclopedia-scale page can still be loading at the
      // timeout, but its DOM is usually interactive well before the load event.
      // Resolving (not rejecting) lets us build a PARTIAL graph from what's
      // there instead of failing the whole open() — a partial perception beats
      // none. The timeout is configurable (VEIL_NAV_TIMEOUT_MS).
      await Promise.race([
        loadPromise,
        new Promise<void>((resolve) => {
          timer = setTimeout(() => {
            timedOut = true;
            resolve();
          }, timeoutMs);
        }),
      ]);
    } finally {
      // The load handler leaked on every timeout — a long-lived daemon session
      // doing many navigations accumulated stale loadEventFired handlers that
      // fired on unrelated future loads. Always detach.
      if (handler) cdp.off("Page.loadEventFired", handler);
      if (timer) clearTimeout(timer);
    }
    if (timedOut) debugLog("navigate: load event timed out, building partial graph", url);

    await awaitQuiescence(cdp);
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
    settleNetwork(timeoutMs?: number) {
      return networkCapture.settle(timeoutMs);
    },
    startNetworkCapture,
    getCurrentUrl,
    close() {
      networkCapture.drain(); // detach listeners, discard data
      // Close the underlying tab too (not just the socket) so a fresh-target
      // session doesn't leak a Chrome page every time it's closed. Best effort:
      // send before the socket goes, ignore if the target is already gone.
      if (target?.id) {
        cdp.send("Target.closeTarget", { targetId: target.id }).catch(() => {});
      }
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
    // awaitQuiescence already covers BOTH network and DOM quiet in one
    // event-driven wait — no more sequential network-then-dom fixed windows.
    const settlePromise = (async () => {
      await awaitQuiescence(cdp);
      if (!settled) settled = true;
    })();

    await Promise.race([navPromise, settlePromise.catch(() => {})]);
  } finally {
    cdp.off("Page.frameNavigated", onNav);
  }
}

// Event-driven settle window. quietMs is how long the page must be free of
// in-flight requests AND DOM mutation before we call it done — a few frames, not
// the old fixed 2s. quiesceCap backstops pathological never-idle pages.
//
// Read per call, NOT bound at module load: a host that loads its .env after
// importing @veil/core would otherwise silently get the defaults, and tests
// could not exercise the settle without spawning a subprocess.
const quietMsDefault = (): number => Number(process.env.VEIL_QUIET_MS) || 40;
const quiesceCapDefault = (): number => Number(process.env.VEIL_QUIESCE_CAP_MS) || 12_000;
/**
 * A request in flight longer than this is treated as a persistent connection
 * (long-poll / SSE-over-XHR / keepalive), not something the page is waiting on,
 * and stops blocking settle. Real sites hold such connections open forever —
 * google's autocomplete XHR never closes — and requiring zero in-flight
 * requests made settle unreachable there, turning it into a flat cap-length
 * timeout on every single action. See DECISIONS 2026-07-15.
 */
const longLivedMsDefault = (): number => Number(process.env.VEIL_LONGPOLL_MS) || 2_000;

/**
 * Wait until the page is genuinely done reacting — event-driven, not timed.
 *
 * Primary path: ask the injected instrumentation (window.__veil.whenQuiet),
 * which tracks its OWN fetch/XHR completion + a MutationObserver, and resolve
 * over CDP via awaitPromise. This waits EXACTLY the real network duration and
 * returns in ~a frame when nothing happened — no fixed floor.
 *
 * Fallback path (strict-CSP pages where injection is blocked / __veil absent):
 * a host-side quiescence counter driven by the same CDP events (in-flight from
 * Network.*, activity from DOM.*). Same logic, computed host-side.
 */
export async function awaitQuiescence(
  cdp: CDPClient,
  opts: { quietMs?: number; capMs?: number; longLivedMs?: number } = {},
): Promise<void> {
  const quietMs = opts.quietMs ?? quietMsDefault();
  const capMs = opts.capMs ?? quiesceCapDefault();
  const longLivedMs = opts.longLivedMs ?? longLivedMsDefault();
  try {
    const res = (await cdp.send("Runtime.evaluate", {
      expression:
        `(window.__veil && window.__veil.whenQuiet) ` +
        `? window.__veil.whenQuiet({quietMs:${quietMs},capMs:${capMs},longLivedMs:${longLivedMs}}) : null`,
      awaitPromise: true,
      returnByValue: true,
    })) as { result?: { value?: { reason?: string; pending?: number; young?: number } | null } };
    const verdict = res.result?.value;
    if (verdict != null) {
      // Hitting the cap used to be indistinguishable from genuine quiet — the
      // verdict was discarded, which is why a 12s-per-action stall stayed
      // invisible for so long. Say so.
      if (verdict.reason === "cap") {
        debugLog(
          `quiescence: hit ${capMs}ms cap — ${verdict.young ?? 0} young / ${verdict.pending ?? 0} total request(s) in flight. ` +
            `Settling anyway; a stuck request may be pinning this page.`,
        );
      }
      return;
    }
    // value == null → __veil absent (injection blocked); use the host fallback.
  } catch (err) {
    debugLog("quiescence: page-side failed, host fallback", err);
  }
  await hostQuiescence(cdp, quietMs, capMs, longLivedMs);
}

function hostQuiescence(
  cdp: CDPClient,
  quietMs: number,
  capMs: number,
  longLivedMs: number,
): Promise<void> {
  return new Promise<void>((resolve) => {
    // Keyed by requestId -> startedAt, mirroring the page-side tracker: a bare
    // counter can't tell a pending request from a never-closing long-poll.
    const inflight = new Map<string, number>();
    let lastActivity = Date.now();
    let done = false;
    const bump = () => (lastActivity = Date.now());
    const onReq = (p: unknown) => {
      const id = (p as { requestId?: string })?.requestId;
      // Real CDP always sends a requestId. Without one we cannot pair start to
      // finish, so the request can't be tracked — say so rather than silently
      // letting settle return early.
      if (id) inflight.set(id, Date.now());
      else debugLog("quiescence(host): requestWillBeSent without requestId — not tracked");
      bump();
    };
    const onDone = (p: unknown) => {
      const id = (p as { requestId?: string })?.requestId;
      if (id) inflight.delete(id);
      bump();
    };
    const youngPending = (): number => {
      const now = Date.now();
      let n = 0;
      for (const startedAt of inflight.values()) if (now - startedAt < longLivedMs) n++;
      return n;
    };
    const finish = () => {
      if (done) return;
      done = true;
      cdp.off("Network.requestWillBeSent", onReq);
      cdp.off("Network.loadingFinished", onDone);
      cdp.off("Network.loadingFailed", onDone);
      cdp.off("DOM.childNodeInserted", bump);
      cdp.off("DOM.childNodeRemoved", bump);
      cdp.off("DOM.attributeModified", bump);
      clearInterval(poll);
      clearTimeout(cap);
      resolve();
    };
    cdp.on("Network.requestWillBeSent", onReq);
    cdp.on("Network.loadingFinished", onDone);
    cdp.on("Network.loadingFailed", onDone);
    cdp.on("DOM.childNodeInserted", bump);
    cdp.on("DOM.childNodeRemoved", bump);
    cdp.on("DOM.attributeModified", bump);
    const poll = setInterval(() => {
      if (youngPending() === 0 && Date.now() - lastActivity >= quietMs) finish();
    }, 12);
    const cap = setTimeout(() => {
      debugLog(
        `quiescence(host): hit ${capMs}ms cap — ${youngPending()} young / ${inflight.size} total in flight`,
      );
      finish();
    }, capMs);
  });
}

