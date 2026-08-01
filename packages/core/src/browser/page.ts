/**
 * Drive one page target: navigate, wait for it to settle, return rendered HTML.
 *
 * This is the render path — the browser as a *renderer* for the read tier, not
 * the behavior-graph builder (that's a later slice). It exists to turn a
 * js-shell (content only after JS runs) into real HTML the extractor can read.
 *
 * Settle is network-idle, young-request-aware: a request in flight longer than
 * longLivedMs is a persistent connection (long-poll / SSE / keepalive) and stops
 * blocking idle. This is the v1 quiescence-cap bug fixed at the source — without
 * it, google-shaped pages burn the full cap on every render.
 */
import type { CDPClient } from "./cdp-client.js";
import { composeFrameHtml, listFrames } from "./frames.js";
import { debugLog } from "../debug.js";

export interface RenderPageResult {
  html: string;
  finalUrl: string;
  /** Set when navigation itself failed (DNS, connection, blocked). */
  errorText?: string;
  /** What the HTML covers when the page has child documents. Present only then.
   * NOTE (named partial): @veil/read consumes the html STRING, so these counts
   * do not currently reach the read receipt — that needs read-side plumbing this
   * change deliberately does not touch. */
  frames?: { composed: number; hidden: number; appended: number };
}

export interface SettleOptions {
  navTimeoutMs?: number;
  quietMs?: number;
  capMs?: number;
  longLivedMs?: number;
}

async function evalString(client: CDPClient, expression: string): Promise<string | null> {
  try {
    const res = (await client.send("Runtime.evaluate", {
      expression,
      returnByValue: true,
    })) as { result?: { value?: unknown } };
    const v = res.result?.value;
    return typeof v === "string" ? v : null;
  } catch (err) {
    debugLog("render: eval failed", expression.slice(0, 40), err);
    return null;
  }
}

/** Resolve on Page.loadEventFired, or after timeout — whichever comes first. A
 * slow page yields a partial render, never a hang. */
function waitForLoad(client: CDPClient, timeoutMs: number): Promise<void> {
  return new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      client.off("Page.loadEventFired", onLoad);
      clearTimeout(timer);
      resolve();
    };
    const onLoad = () => finish();
    client.on("Page.loadEventFired", onLoad);
    const timer = setTimeout(finish, timeoutMs);
  });
}

/** Wait until the page stops making young requests for a quiet window, capped. */
function awaitNetworkIdle(client: CDPClient, o: Required<SettleOptions>): Promise<void> {
  return new Promise((resolve) => {
    const inflight = new Map<string, number>();
    let lastActivity = Date.now();
    let done = false;
    const onReq = (p: unknown) => {
      const id = (p as { requestId?: string })?.requestId;
      if (id) inflight.set(id, Date.now());
      lastActivity = Date.now();
    };
    const onDone = (p: unknown) => {
      const id = (p as { requestId?: string })?.requestId;
      if (id) inflight.delete(id);
      lastActivity = Date.now();
    };
    const young = (): number => {
      const now = Date.now();
      let n = 0;
      for (const t of inflight.values()) if (now - t < o.longLivedMs) n++;
      return n;
    };
    const finish = () => {
      if (done) return;
      done = true;
      client.off("Network.requestWillBeSent", onReq);
      client.off("Network.loadingFinished", onDone);
      client.off("Network.loadingFailed", onDone);
      clearInterval(poll);
      clearTimeout(cap);
      resolve();
    };
    client.on("Network.requestWillBeSent", onReq);
    client.on("Network.loadingFinished", onDone);
    client.on("Network.loadingFailed", onDone);
    const poll = setInterval(() => {
      if (young() === 0 && Date.now() - lastActivity >= o.quietMs) finish();
    }, 50);
    const cap = setTimeout(() => {
      debugLog(`render: network-idle hit ${o.capMs}ms cap — ${young()} young in flight`);
      finish();
    }, o.capMs);
  });
}

export async function renderPage(
  client: CDPClient,
  url: string,
  opts: SettleOptions = {},
): Promise<RenderPageResult> {
  // Guarded env parse: Number(undefined) is NaN, and `??` does NOT catch NaN, so
  // a naive chain leaves these NaN when the env var is unset — which makes every
  // setTimeout fire immediately (TimeoutNaNWarning) and the render grab HTML
  // before the page has loaded. (Same trap fixed earlier in @veil/search.)
  const env = (name: string, d: number): number => {
    const v = process.env[name];
    const n = v ? Number(v) : NaN;
    return Number.isFinite(n) ? n : d;
  };
  const settle: Required<SettleOptions> = {
    navTimeoutMs: opts.navTimeoutMs ?? env("VEIL_RENDER_NAV_MS", 20_000),
    quietMs: opts.quietMs ?? 500,
    capMs: opts.capMs ?? env("VEIL_RENDER_CAP_MS", 8_000),
    longLivedMs: opts.longLivedMs ?? 2_000,
  };

  await client.send("Page.enable");
  await client.send("Network.enable");
  await client.send("Runtime.enable");

  // Strip the "HeadlessChrome" token from the UA before navigating — the one
  // fingerprint tell that's free to remove. Must be set before the request.
  const ua = await evalString(client, "navigator.userAgent");
  if (ua && /Headless/.test(ua)) {
    await client
      .send("Network.setUserAgentOverride", { userAgent: ua.replace(/Headless/g, "") })
      .catch((err) => debugLog("render: UA override failed", err));
  }

  const nav = (await client.send("Page.navigate", { url })) as { errorText?: string };
  if (nav.errorText) {
    return { html: "", finalUrl: url, errorText: nav.errorText };
  }

  await waitForLoad(client, settle.navTimeoutMs);
  await awaitNetworkIdle(client, settle);

  const raw = (await evalString(client, "document.documentElement.outerHTML")) ?? "";
  const finalUrl = (await evalString(client, "location.href")) ?? url;

  // A page whose content is an iframe serializes to markup with none of its
  // prose in it (measured: 216 chars, no answer). Splice the child documents in
  // — the render rung exists to hand the extractor real HTML, and top-frame-only
  // HTML is not that.
  try {
    const frames = await listFrames(client);
    if (frames.length > 1) {
      // DOM methods below take backendNodeIds; the domain has to be live.
      await client.send("DOM.enable").catch(() => {});
      await client.send("DOM.getDocument", { depth: -1 }).catch(() => {});
      const c = await composeFrameHtml(client, frames, raw);
      return {
        html: c.html,
        finalUrl,
        frames: { composed: c.composed, hidden: c.hidden, appended: c.appended },
      };
    }
  } catch (err) {
    // Degradation-by-design: a compose failure returns the top document, which
    // is exactly what this call returned before. VEIL_DEBUG=1 surfaces it.
    debugLog("render: frame composition failed", err);
  }
  return { html: raw, finalUrl };
}
