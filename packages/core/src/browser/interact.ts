/**
 * veil_do — dispatching a real interaction.
 *
 * Order matters and each step earns its place:
 *   1. resolve the stable display id to a LIVE node (ids are content-derived, the
 *      DOM node behind them is not)
 *   2. actionability — visible, stable, enabled, not obscured. Playwright's
 *      algorithm, reimplemented (~a page of JS) rather than imported: we need it
 *      on the CDP we already control. Failing here is a receipt, not an exception.
 *   3. dispatch trusted events through the Input domain, scrolled into view
 *   4. settle (see settle.ts)
 *
 * The rebuild and diff live in session.ts, which owns the graph.
 */
import type { CDPClient } from "./cdp-client.js";
import { debugLog } from "../debug.js";

export type ActionKind =
  | "click"
  | "type"
  | "clear"
  | "select"
  | "focus"
  | "hover"
  | "check"
  | "submit";

export interface Action {
  kind: ActionKind;
  /** For type/select. */
  value?: string;
}

export type ActionFailure =
  | "not-found"
  | "not-visible"
  | "disabled"
  | "obscured"
  | "unstable"
  | "dispatch-failed";

export interface DispatchResult {
  ok: boolean;
  failure?: ActionFailure;
  detail?: string;
  /** Accessible names of dismiss-looking controls found inside the blocking
   * overlay. The session turns these into node ids the agent can act on. */
  dismiss?: string[];
  /** The blocker is a backdrop, which has no close control by design. */
  backdrop?: boolean;
  /** What a value-bearing action left in the field, read back afterwards. */
  value?: string;
  /** Center point actually used, for debugging. */
  at?: { x: number; y: number };
}

/**
 * Actionability, evaluated on the live node. Returns a verdict plus the click
 * point, in one round trip. "Stable" means the box hasn't moved between two
 * animation frames — clicking a sliding element hits whatever slid under it.
 */
const ACTIONABLE_FN = `async function() {
  var el = this;
  function box(e){ var r = e.getBoundingClientRect(); return { x:r.x, y:r.y, w:r.width, h:r.height }; }
  try {
    if (!el.isConnected) return JSON.stringify({ ok:false, why:'not-found', detail:'detached from the document' });
    if (el.disabled === true || el.getAttribute('aria-disabled') === 'true')
      return JSON.stringify({ ok:false, why:'disabled', detail:'element reports disabled' });

    el.scrollIntoView({ block:'center', inline:'center', behavior:'instant' });

    var b1 = box(el);
    // Two frames to see whether the element is still moving — but NEVER wait on
    // rAF alone. It is suspended outright in a backgrounded tab, and this runs
    // awaited over CDP, so a frame that never comes became a 30s timeout and a
    // dispatch-failed. Focus emulation (session.ts) is what actually keeps the
    // frames coming; this guards the branch where enabling it throws, where the
    // cost of being wrong is a 30s hang rather than a slow call.
    await new Promise(function(r){
      var done = false;
      var fin = function(){ if (!done) { done = true; r(); } };
      requestAnimationFrame(function(){ requestAnimationFrame(fin); });
      setTimeout(fin, 250);
    });
    var b2 = box(el);
    if (b2.w === 0 || b2.h === 0) {
      var cs = getComputedStyle(el);
      return JSON.stringify({ ok:false, why:'not-visible',
        detail: cs.display === 'none' ? 'display:none' : cs.visibility === 'hidden' ? 'visibility:hidden' : 'zero-sized' });
    }
    if (Math.abs(b1.x-b2.x) > 1 || Math.abs(b1.y-b2.y) > 1)
      return JSON.stringify({ ok:false, why:'unstable', detail:'element is still moving' });

    var cx = b2.x + b2.w/2, cy = b2.y + b2.h/2;
    // Obscured? Whatever is on top must be us or inside us.
    var top = document.elementFromPoint(cx, cy);
    if (top && top !== el && !el.contains(top) && !top.contains(el)) {
      // Naming the blocker is not enough — an agent cannot address a raw <div>.
      // Measured: told "covered by <div class=...>", a live agent guessed at
      // "close", "Close" and "hsBackDrop", found nothing, and abandoned the
      // site. So hunt the overlay for something DISMISSIBLE and report its
      // accessible name; the host turns that into a node id it can act on.
      var scope = top.closest('[role=dialog],[aria-modal="true"],[class*=modal],[class*=overlay],[class*=popup]') || top;
      var DISMISS = /^(close|dismiss|cancel|no thanks|not now|skip|maybe later|got it|ok|okay|accept|continue|x|\u00d7|\u2715|\u2716)$/i;
      var names = [];
      try {
        var cands = scope.querySelectorAll('button,[role=button],a,[aria-label],[title]');
        for (var i = 0; i < cands.length && names.length < 4; i++) {
          var c = cands[i];
          var label = (c.getAttribute('aria-label') || c.getAttribute('title') || c.textContent || '').trim();
          if (!label || label.length > 40) continue;
          if (!DISMISS.test(label)) continue;
          if (names.indexOf(label) === -1) names.push(label);
        }
      } catch (e) {}
      // A BACKDROP is the dimming layer behind an open widget — it has no close
      // control by design, and saying so stops the agent hunting for one.
      var cls = String(top.className || '');
      var r0 = top.getBoundingClientRect();
      var backdrop = /backdrop|scrim|mask|veil/i.test(cls) ||
        (r0.width >= innerWidth * 0.9 && r0.height >= innerHeight * 0.9);
      return JSON.stringify({ ok:false, why:'obscured',
        blocker: '<' + top.tagName.toLowerCase() + (top.className ? ' class=' + String(top.className).slice(0,40) : '') + '>',
        backdrop: backdrop,
        dismiss: names,
        detail: 'covered by <' + top.tagName.toLowerCase() + (top.className ? ' class=' + String(top.className).slice(0,40) : '') + '>' });
    }
    return JSON.stringify({ ok:true, x:cx, y:cy });
  } catch (e) {
    return JSON.stringify({ ok:false, why:'not-found', detail:String(e && e.message || e) });
  }
}`;

/**
 * The click point for a node inside a CHILD document.
 *
 * `ACTIONABLE_FN` computes its point from `getBoundingClientRect`, which is
 * FRAME-LOCAL, while `Input.dispatchMouseEvent` takes TOP-VIEWPORT coordinates.
 * Measured, before this existed: `dispatchAction` returned
 * `{"ok":true,"at":{"x":79.73,"y":112.31}}` for a click that landed on the top
 * document's BODY — the iframe's `document.title` never changed and the top
 * frame's `elementFromPoint` at those coordinates was `BODY`. A confident `ok`
 * for an action that did nothing is the exact bug class this project keeps
 * finding, and it is why merging in-frame nodes into the graph and fixing the
 * coordinate space are ONE change, not two.
 *
 * `DOM.getContentQuads` returns MAIN-FRAME coordinates (measured 18/135.78 =
 * 8+2+8 / 113.875+2+19.906 for a frame at depth 1) and lands at depth 1 AND
 * depth 2. Empty quads mean the element has no rendered box — a refusal with a
 * reason, never a false ok.
 *
 * Root-frame nodes do NOT take this path: it would change the hot path for every
 * existing Layer-2 test, and quads have their own edges (multiple quads on an
 * inline element, computed at a different instant than the stability check).
 * Worth revisiting as a simplification, with a measurement.
 */
async function frameClickPoint(
  client: CDPClient,
  backendNodeId: number,
): Promise<{ x: number; y: number } | null> {
  let quads: number[][];
  try {
    const r = (await client.send("DOM.getContentQuads", { backendNodeId })) as {
      quads?: number[][];
    };
    quads = r.quads ?? [];
  } catch (err) {
    debugLog("interact: getContentQuads failed", err);
    return null;
  }
  for (const q of quads) {
    if (q.length < 8) continue;
    const xs = [q[0]!, q[2]!, q[4]!, q[6]!];
    const ys = [q[1]!, q[3]!, q[5]!, q[7]!];
    // A zero-area quad is what a width=0/height=0 frame produces (measured).
    // Treat it as no box rather than clicking a point that hits whatever is
    // behind it.
    if (Math.max(...xs) - Math.min(...xs) <= 0 || Math.max(...ys) - Math.min(...ys) <= 0) continue;
    return { x: (xs[0] + xs[1] + xs[2] + xs[3]) / 4, y: (ys[0] + ys[1] + ys[2] + ys[3]) / 4 };
  }
  return null;
}

async function resolveObject(client: CDPClient, backendNodeId: number): Promise<string | null> {
  try {
    const r = (await client.send("DOM.resolveNode", { backendNodeId })) as {
      object?: { objectId?: string };
    };
    return r.object?.objectId ?? null;
  } catch {
    return null;
  }
}

async function callOn(client: CDPClient, objectId: string, fn: string): Promise<string | null> {
  const r = (await client.send("Runtime.callFunctionOn", {
    objectId,
    functionDeclaration: fn,
    awaitPromise: true,
    returnByValue: true,
  })) as { result?: { value?: unknown } };
  return typeof r.result?.value === "string" ? r.result.value : null;
}

async function mouseClick(client: CDPClient, x: number, y: number): Promise<void> {
  const base = { x, y, button: "left" as const, clickCount: 1 };
  await client.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
  await client.send("Input.dispatchMouseEvent", { type: "mousePressed", ...base });
  await client.send("Input.dispatchMouseEvent", { type: "mouseReleased", ...base });
}

/**
 * Press Enter on the focused element, as a REAL key event.
 *
 * Note the key identity — `text` alone is enough to insert a printable
 * character but NOT to trigger Chrome's implicit form submission; without
 * `key`/`code`/`windowsVirtualKeyCode` this dispatches cleanly and does nothing,
 * which is the silent-degradation shape this project keeps designing out.
 *
 * A real keypress is deliberately chosen over `form.requestSubmit()`: it covers
 * the form case (implicit submission) AND the no-form case (a JS keydown
 * listener), which is what a search box with no button actually needs.
 */
async function pressEnter(client: CDPClient): Promise<void> {
  const key = { key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 };
  await client.send("Input.dispatchKeyEvent", { type: "keyDown", text: "\r", ...key });
  await client.send("Input.dispatchKeyEvent", { type: "keyUp", ...key });
}

/** Focus and empty a field. Native setter + events, so React's onChange fires. */
const CLEAR_FN = `function(){ this.focus();
  var d = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(this), 'value');
  if (d && d.set) d.set.call(this, ''); else this.value = '';
  this.dispatchEvent(new Event('input', {bubbles:true}));
  this.dispatchEvent(new Event('change', {bubbles:true})); return "ok"; }`;

/** What the field holds NOW. A field can reject or reformat what was typed —
 * date masks, phone formatting — and silence about that is how a wrong value
 * travels downstream looking like someone else's bug. */
const READ_VALUE_FN = `function(){
  try { return this.value !== undefined ? String(this.value) : (this.textContent || ''); }
  catch (e) { return ''; }
}`;

/** Type into the focused element as real key events, so frameworks see them. */
async function typeText(client: CDPClient, textToType: string): Promise<void> {
  for (const ch of textToType) {
    await client.send("Input.dispatchKeyEvent", { type: "keyDown", text: ch });
    await client.send("Input.dispatchKeyEvent", { type: "keyUp" });
  }
}

export interface DispatchOptions {
  /** The node lives in a child document, so its rect is in the WRONG coordinate
   * space for Input.dispatchMouseEvent. Set from `BehaviorNode.frame`. */
  inFrame?: boolean;
}

export async function dispatchAction(
  client: CDPClient,
  backendNodeId: number,
  action: Action,
  opts: DispatchOptions = {},
): Promise<DispatchResult> {
  const objectId = await resolveObject(client, backendNodeId);
  if (!objectId) {
    return { ok: false, failure: "not-found", detail: "the node is no longer in the document" };
  }

  // Actionability first — a failure here is information, not an error.
  let verdict: {
    ok: boolean;
    why?: ActionFailure;
    detail?: string;
    x?: number;
    y?: number;
    blocker?: string;
    /** The blocker is a full-bleed backdrop — by design it has no close control. */
    backdrop?: boolean;
    /** Accessible names of dismiss-looking controls inside the overlay. */
    dismiss?: string[];
  };
  try {
    const raw = await callOn(client, objectId, ACTIONABLE_FN);
    verdict = raw ? JSON.parse(raw) : { ok: false, why: "not-found", detail: "no verdict" };
  } catch (err) {
    return { ok: false, failure: "dispatch-failed", detail: `actionability check failed: ${msg(err)}` };
  }
  if (!verdict.ok) {
    return {
      ok: false,
      failure: verdict.why ?? "not-found",
      detail: verdict.detail,
      ...(verdict.dismiss?.length ? { dismiss: verdict.dismiss } : {}),
      ...(verdict.backdrop ? { backdrop: true } : {}),
    };
  }
  let at = { x: verdict.x!, y: verdict.y! };

  // ACTIONABLE_FN has already run — including its scrollIntoView, which measured
  // scrolls the PARENT too (y 3749 → 949 in a 993px viewport), so the quads below
  // are taken with the element on screen. Only the coordinate SPACE is wrong, and
  // only for a node in a child document.
  if (opts.inFrame) {
    const point = await frameClickPoint(client, backendNodeId);
    if (!point) {
      return {
        ok: false,
        failure: "not-visible",
        detail:
          "this node is inside a child document and has no rendered box there " +
          "(DOM.getContentQuads returned nothing), so there is no point to click. " +
          "The frame may be display:none or zero-sized.",
      };
    }
    at = point;
  }

  try {
    switch (action.kind) {
      case "click":
      case "check":
        await mouseClick(client, at.x, at.y);
        break;
      case "hover":
        await client.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: at.x, y: at.y });
        break;
      case "focus":
        await callOn(client, objectId, `function(){ this.focus(); return "ok"; }`);
        break;
      case "clear":
        await callOn(client, objectId, CLEAR_FN);
        break;
      case "type": {
        // REPLACE, not append. An agent means "set this field to X" — Playwright
        // splits fill() from type(); we have one verb and it is used as fill.
        // Measured: Google Flights pre-fills the origin by geolocation, so
        // typing "BLR" produced "BLRBengaluru", which matches no airport. The
        // live AX tree then said "No matching locations found" and the whole
        // failure read as a PERCEPTION bug for two rounds. Clear first, via the
        // native setter so React's onChange fires, then send real keystrokes so
        // frameworks that listen for them behave normally.
        await callOn(client, objectId, CLEAR_FN);
        await typeText(client, action.value ?? "");
        break;
      }
      case "submit": {
        // Focus first: implicit submission is a property of the focused control,
        // not of the document. Optionally type a value in the same breath, so a
        // search is one call rather than two.
        await callOn(client, objectId, `function(){ this.focus(); return "ok"; }`);
        if (action.value !== undefined && action.value !== "") {
          await typeText(client, action.value);
        }
        await pressEnter(client);
        break;
      }
      case "select": {
        // Match by VALUE or by visible LABEL, case-insensitively.
        //
        // The graph shows an option's LABEL (`combobox-size [combobox] ="Small"`),
        // so an agent naturally passes "Large" — but the option's value attribute
        // is "large". Assigning an unmatched string to a <select> silently sets
        // `.value` to "", so the old code reported ok while selecting nothing and
        // the form submitted with the field absent. Found by the arena: Veil lost
        // a task it should have drawn, and its own value-echo receipt showed
        // `value=""` on an action it had called ok.
        const raw = (await callOn(
          client,
          objectId,
          `function(){
             var want = ${JSON.stringify(action.value ?? "")};
             var norm = function(s){ return String(s == null ? "" : s).trim().toLowerCase(); };
             var opts = this.options ? Array.prototype.slice.call(this.options) : [];
             var hit = null;
             for (var i = 0; i < opts.length; i++) {
               if (norm(opts[i].value) === norm(want)) { hit = opts[i]; break; }
             }
             if (!hit) {
               for (var j = 0; j < opts.length; j++) {
                 if (norm(opts[j].text) === norm(want)) { hit = opts[j]; break; }
               }
             }
             if (!hit) {
               return JSON.stringify({ ok:false,
                 options: opts.slice(0, 12).map(function(o){ return o.text || o.value; }) });
             }
             this.value = hit.value;
             this.dispatchEvent(new Event('input', {bubbles:true}));
             this.dispatchEvent(new Event('change', {bubbles:true}));
             return JSON.stringify({ ok:true });
           }`,
        )) ?? "";
        let verdict: { ok?: boolean; options?: string[] } = {};
        try {
          verdict = JSON.parse(raw) as typeof verdict;
        } catch {
          /* non-select element — fall through as a plain success */
          verdict = { ok: true };
        }
        if (verdict.ok === false) {
          // A refusal that names the real choices, rather than a false ok.
          return {
            ok: false,
            failure: "dispatch-failed",
            detail:
              `no option matches ${JSON.stringify(action.value ?? "")}` +
              (verdict.options?.length ? ` — available: ${verdict.options.join(", ")}` : ""),
            at,
          };
        }
        break;
      }
    }
    // Read back what the field ended up holding, for the receipt.
    let value: string | undefined;
    if (action.kind === "type" || action.kind === "clear" || action.kind === "select") {
      value = (await callOn(client, objectId, READ_VALUE_FN)) ?? undefined;
    }
    return { ok: true, at, ...(value !== undefined && { value }) };
  } catch (err) {
    debugLog("interact: dispatch failed", action.kind, err);
    return { ok: false, failure: "dispatch-failed", detail: msg(err), at };
  }
}

function msg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
