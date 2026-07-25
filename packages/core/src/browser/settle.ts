/**
 * Settle — knowing the page is done reacting.
 *
 * The locked model (DECISIONS 2026-07-25):
 *
 *     settled ⟺ young-network-idle  AND  actionable-fingerprint stable
 *
 * v1 asked "has the DOM stopped mutating?", which is unwinnable: measured on
 * diabrowser.com the DOM churns 2,847 times and never goes quiet for more than
 * 5ms, so settle burned its full 12s cap on every action. The right question is
 * "has the set of things you can DO stopped changing?" — ambient animation moves
 * the DOM but not the actionable surface.
 *
 * Both halves are required. Measured on theverge: a 544ms gap between fingerprint
 * changes *during* load, which a 200ms quiet window alone would have mistaken for
 * done. Network bridges the DOM's pauses; actionable-stability handles
 * persistent-connection pages where the network never idles.
 *
 * ACCEPTED RESIDUAL: a delayed `setTimeout(reveal, 800)` with no network fires no
 * observable signal, so nothing can wait for it. Bounded by the quiet-window dial
 * and reported via `reason`, not hidden.
 */
import type { CDPClient } from "./cdp-client.js";
import { debugLog } from "../debug.js";

export type SettleReason = "stable" | "capped" | "error";

export interface SettleResult {
  reason: SettleReason;
  ms: number;
  /** Fingerprint changes observed — 0 means the surface never moved. */
  changes: number;
  /** Requests still in flight and young enough to matter, at exit. */
  youngInFlight: number;
}

export interface SettleConfig {
  /** How long the surface must hold still. */
  quietMs: number;
  /** Hard backstop for pages that never settle. Reported when hit. */
  capMs: number;
  /** A request older than this is a persistent connection, not work in progress. */
  longLivedMs: number;
  /** Fingerprint sampling interval. */
  pollMs: number;
}

function envNum(name: string, d: number): number {
  const v = process.env[name];
  const n = v ? Number(v) : NaN;
  return Number.isFinite(n) ? n : d;
}

export function settleConfig(over: Partial<SettleConfig> = {}): SettleConfig {
  return {
    quietMs: over.quietMs ?? envNum("VEIL_QUIET_MS", 200),
    capMs: over.capMs ?? envNum("VEIL_SETTLE_CAP_MS", 8000),
    longLivedMs: over.longLivedMs ?? envNum("VEIL_LONGPOLL_MS", 2000),
    pollMs: over.pollMs ?? envNum("VEIL_SETTLE_POLL_MS", 100),
  };
}

/**
 * The actionable-surface fingerprint, computed IN the page.
 *
 * Deliberately not the AX tree: `Accessibility.getFullAXTree` costs 8–121ms
 * depending on page size (measured), and settle has to sample every ~100ms to
 * detect a 200ms quiet window — which on a large page would mean a >100% duty
 * cycle. This walks interactive elements (piercing open shadow roots) and hashes
 * role-ish identity + actionability state, at ~1ms. It is the same SEMANTIC
 * signal — "what can be acted on, and in what state" — from a cheaper source.
 * The AX tree remains the source for PERCEPTION, where computed accessible names
 * are the whole point.
 */
const FINGERPRINT = `(function(){
  var SEL = 'a[href],button,input,select,textarea,[role],[onclick],[tabindex],[contenteditable]';
  var acc = [], n = 0;
  function scan(root){
    var els;
    try { els = root.querySelectorAll(SEL); } catch (e) { return; }
    for (var i = 0; i < els.length && n < 800; i++) {
      var el = els[i];
      var t = '';
      try {
        t = (el.tagName||'') + '|' + (el.getAttribute && (el.getAttribute('role')||'')) + '|' +
            (el.id||'') + '|' + (el.getAttribute && (el.getAttribute('name')||'')) + '|' +
            (el.disabled ? 'D' : '') + (el.checked ? 'C' : '') + (el.hidden ? 'H' : '') +
            (el.getAttribute && (el.getAttribute('aria-expanded')||'')) + '|' +
            ((el.textContent||'').slice(0,20).replace(/\\s+/g,' '));
      } catch (e) {}
      acc.push(t); n++;
      if (el.shadowRoot) scan(el.shadowRoot);
    }
  }
  scan(document);
  var s = n + ':' + acc.join(';'), h = 5381;
  for (var j = 0; j < s.length; j++) { h = ((h * 33) ^ s.charCodeAt(j)) | 0; }
  return n + '#' + h;
})()`;

/** Wait until the page has stopped reacting. Never throws. */
export async function awaitSettle(
  client: CDPClient,
  cfg: SettleConfig = settleConfig(),
): Promise<SettleResult> {
  const t0 = Date.now();

  // Network half — young requests only.
  const inflight = new Map<string, number>();
  let lastNetworkAt = Date.now();
  const onReq = (p: unknown) => {
    const id = (p as { requestId?: string })?.requestId;
    if (id) inflight.set(id, Date.now());
    else debugLog("settle: requestWillBeSent without requestId — untracked");
    lastNetworkAt = Date.now();
  };
  const onDone = (p: unknown) => {
    const id = (p as { requestId?: string })?.requestId;
    if (id) inflight.delete(id);
    lastNetworkAt = Date.now();
  };
  const youngInFlight = (): number => {
    const now = Date.now();
    let n = 0;
    for (const started of inflight.values()) if (now - started < cfg.longLivedMs) n++;
    return n;
  };

  client.on("Network.requestWillBeSent", onReq);
  client.on("Network.loadingFinished", onDone);
  client.on("Network.loadingFailed", onDone);

  let changes = 0;
  let reason: SettleReason = "stable";
  try {
    let last: string | null = null;
    let lastChangeAt = Date.now();

    for (;;) {
      if (Date.now() - t0 > cfg.capMs) {
        reason = "capped";
        debugLog(
          `settle: hit ${cfg.capMs}ms cap — ${youngInFlight()} young in flight, ${changes} surface changes`,
        );
        break;
      }

      let fp: string | null = null;
      try {
        const r = (await client.send("Runtime.evaluate", {
          expression: FINGERPRINT,
          returnByValue: true,
        })) as { result?: { value?: unknown } };
        fp = typeof r.result?.value === "string" ? r.result.value : null;
      } catch (err) {
        // A navigation mid-poll destroys the context. That IS a change; keep going.
        debugLog("settle: fingerprint eval failed (navigation?)", err);
        lastChangeAt = Date.now();
        changes++;
      }

      if (fp !== null) {
        if (last === null) {
          last = fp;
          lastChangeAt = Date.now();
        } else if (fp !== last) {
          last = fp;
          lastChangeAt = Date.now();
          changes++;
        }
      }

      const now = Date.now();
      const surfaceQuiet = now - lastChangeAt >= cfg.quietMs;
      const networkQuiet = youngInFlight() === 0 && now - lastNetworkAt >= cfg.quietMs;
      if (surfaceQuiet && networkQuiet) break;

      await new Promise((r) => setTimeout(r, cfg.pollMs));
    }
  } catch (err) {
    reason = "error";
    debugLog("settle: aborted", err);
  } finally {
    client.off("Network.requestWillBeSent", onReq);
    client.off("Network.loadingFinished", onDone);
    client.off("Network.loadingFailed", onDone);
  }

  return { reason, ms: Date.now() - t0, changes, youngInFlight: youngInFlight() };
}
