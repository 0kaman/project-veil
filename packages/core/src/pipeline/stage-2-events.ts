/**
 * Stage 2 — what each node DOES. Half the moat.
 *
 * `DOMDebugger.getEventListeners` is the direct signal, and on its own it is not
 * enough: measured on github.com/login it returns **[]** for the Sign in button.
 * Two reasons, both common:
 *   1. Frameworks DELEGATE — React binds one listener at the root and dispatches
 *      internally, so no listener exists on the element itself.
 *   2. Server-rendered pages have no listeners at all — the behaviour lives in
 *      `<form action>` and `<a href>`.
 *
 * So this stage combines three sources:
 *   a. direct listeners      (getEventListeners)
 *   b. structural semantics  (form action / href / input type=submit)
 *   c. delegated-handler     (a listener on an ancestor that would receive the
 *                             bubbled event)
 * Nothing here throws: a node that has gone away between the AX walk and now is
 * simply left without events, and that's reported rather than hidden.
 */
import type { CDPClient } from "../browser/cdp-client.js";
import { debugLog } from "../debug.js";
import type { BehaviorNode, EventBinding, EventCategory } from "../graph/model.js";

/** Batch size for the resolve+listeners round trips. v1 used 20; the probe
 * measured 120 nodes in 4–17ms, so 20 is comfortably right. */
const BATCH = 20;

/**
 * Read structural behaviour straight from the DOM node, in one evaluation.
 * Returns the semantics `getEventListeners` cannot see.
 */
const STRUCTURAL_FN = `function() {
  var el = this, out = { href: null, action: null, method: null, type: null, inForm: false, delegated: [] };
  try {
    if (el.tagName === 'A' && el.getAttribute('href')) out.href = el.getAttribute('href');
    out.type = (el.getAttribute && el.getAttribute('type')) || null;
    var f = el.closest && el.closest('form');
    if (f) { out.inForm = true; out.action = f.getAttribute('action') || ''; out.method = (f.getAttribute('method') || 'GET').toUpperCase(); }
    // Delegated handlers: walk ancestors for a framework root marker or an
    // inline handler that would receive our bubbled click.
    var p = el.parentElement, depth = 0;
    while (p && depth < 12) {
      var keys = Object.keys(p);
      for (var i = 0; i < keys.length; i++) {
        var k = keys[i];
        if (k.indexOf('__reactContainer') === 0 || k.indexOf('_reactRootContainer') === 0 ||
            k.indexOf('__vue') === 0 || k.indexOf('__svelte') === 0) { out.delegated.push('framework-root'); p = null; break; }
      }
      if (!p) break;
      if (p.getAttribute && p.getAttribute('onclick')) out.delegated.push('inline-ancestor');
      p = p.parentElement; depth++;
    }
  } catch (e) {}
  return JSON.stringify(out);
}`;

interface Structural {
  href: string | null;
  action: string | null;
  method: string | null;
  type: string | null;
  inForm: boolean;
  delegated: string[];
}

function categorize(type: string, s: Structural | null): { category: EventCategory; effect?: string } {
  if (s?.href) {
    // In-page anchors and javascript: links are not navigation.
    if (s.href.startsWith("#")) return { category: "dom_mutation", effect: `in-page ${s.href}` };
    if (s.href.startsWith("javascript:")) return { category: "unknown" };
    return { category: "navigation", effect: `GET ${s.href}` };
  }
  if (type === "submit" || (s?.inForm && (s.type === "submit" || type === "click"))) {
    if (s?.action !== null && s?.action !== undefined) {
      return { category: "form_submit", effect: `${s.method ?? "GET"} ${s.action || "(self)"}` };
    }
    return { category: "form_submit" };
  }
  if (type === "click" || type === "change" || type === "input") return { category: "dom_mutation" };
  return { category: "unknown" };
}

export interface Stage2Stats {
  queried: number;
  withDirect: number;
  withStructural: number;
  withDelegated: number;
  vanished: number;
}

export async function enrichWithEvents(
  client: CDPClient,
  nodes: BehaviorNode[],
): Promise<Stage2Stats> {
  const stats: Stage2Stats = { queried: 0, withDirect: 0, withStructural: 0, withDelegated: 0, vanished: 0 };
  const targets = nodes.filter((n) => n.backendNodeId !== undefined);

  for (let i = 0; i < targets.length; i += BATCH) {
    const batch = targets.slice(i, i + BATCH);
    await Promise.all(
      batch.map(async (node) => {
        try {
          const resolved = (await client.send("DOM.resolveNode", {
            backendNodeId: node.backendNodeId,
          })) as { object?: { objectId?: string } };
          const objectId = resolved.object?.objectId;
          if (!objectId) {
            stats.vanished++;
            return;
          }
          stats.queried++;

          // (a) direct listeners
          const listeners = (await client.send("DOMDebugger.getEventListeners", {
            objectId,
          })) as { listeners?: { type: string }[] };
          const directTypes = [...new Set((listeners.listeners ?? []).map((l) => l.type))];

          // (b)+(c) structural semantics and delegation, in one call
          let structural: Structural | null = null;
          try {
            const call = (await client.send("Runtime.callFunctionOn", {
              objectId,
              functionDeclaration: STRUCTURAL_FN,
              returnByValue: true,
            })) as { result?: { value?: string } };
            structural = call.result?.value ? (JSON.parse(call.result.value) as Structural) : null;
          } catch (err) {
            debugLog("stage2: structural read failed", node.id, err);
          }

          const events: EventBinding[] = [];
          for (const t of directTypes) {
            const { category, effect } = categorize(t, structural);
            events.push({ type: t, category, ...(effect && { effect }) });
          }
          if (directTypes.length > 0) stats.withDirect++;

          // Synthesize the structural event when no direct listener explains it.
          const hasClickish = events.some((e) => e.type === "click" || e.type === "submit");
          if (!hasClickish && structural && (structural.href || structural.inForm)) {
            const type = structural.href ? "click" : "submit";
            const { category, effect } = categorize(type, structural);
            events.push({ type, category, ...(effect && { effect }) });
            stats.withStructural++;
          }

          // Delegated: mark it, so the agent knows the node is live even though
          // no listener sits on it. This is what getEventListeners can't tell you.
          if (!hasClickish && structural?.delegated.length && events.length === 0) {
            events.push({ type: "click", category: "unknown", delegated: true });
            stats.withDelegated++;
          }

          node.events = events;
          // The most informative effect becomes the node's headline "fires".
          const best = events.find((e) => e.effect);
          if (best?.effect) node.fires = best.effect;
        } catch (err) {
          stats.vanished++;
          debugLog("stage2: node vanished", node.id, err);
        }
      }),
    );
  }
  return stats;
}
