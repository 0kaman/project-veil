import type { CDPClient } from "./cdp-client.js";

// --- TypeScript interfaces for injected data ---

export interface InjectedListenerEntry {
  eventType: string;
  stack: string;
  elementTag: string;
  elementId: string;
}

export interface InjectedNetworkCall {
  type: "fetch" | "xhr";
  method: string;
  url: string;
  stack: string;
  timestamp: number;
}

export interface InjectedNavigation {
  type: "pushState" | "replaceState";
  url: string;
  stack: string;
  timestamp: number;
}

export interface InjectedRegistryData {
  listeners: InjectedListenerEntry[];
  networkCalls: InjectedNetworkCall[];
  navigations: InjectedNavigation[];
}

// --- Injected script (runs before page JS) ---

export const INSTRUMENTATION_SCRIPT = `(function() {
  if (window.__veil) return;

  // --- Stealth: mask automation signals ---
  Object.defineProperty(navigator, 'webdriver', { get: function() { return false; } });
  if (window.chrome && !window.chrome.runtime) {
    window.chrome.runtime = { connect: function() {}, sendMessage: function() {} };
  }
  Object.defineProperty(navigator, 'languages', { get: function() { return ['en-US', 'en']; } });
  Object.defineProperty(navigator, 'plugins', {
    get: function() {
      return [
        { name: 'Chrome PDF Plugin', filename: 'internal-pdf-viewer', description: 'Portable Document Format' },
        { name: 'Chrome PDF Viewer', filename: 'mhjfbmdgcfjbbpaeojofohoefgiehjai', description: '' },
        { name: 'Native Client', filename: 'internal-nacl-plugin', description: '' }
      ];
    }
  });

  var listeners = [];
  var networkCalls = [];
  var navigations = [];
  var NETWORK_CAP = 500;
  var NAV_CAP = 100;
  var LISTENER_CAP = 2000;

  // --- Quiescence tracking: drives event-driven interaction settle ---
  // Instead of the host waiting a fixed 2s and hoping the page is done, the page
  // reports when it's ACTUALLY done reacting: no in-flight fetch/XHR AND no DOM
  // mutation for a short window. whenQuiet() is awaited from the host via CDP.
  //
  // Requests are keyed by a synthetic id -> the ms they STARTED, not counted as
  // a bare integer. A counter cannot tell "a request the page is waiting on"
  // from "a long-poll that will never close" — and real pages hold connections
  // open forever (google's autocomplete XHR, SSE-over-XHR, chat, dashboards).
  // With a plain counter those pin the count above zero permanently, so settle
  // can never fire and every interaction burns the full cap. A start time lets
  // whenQuiet ignore connections too old to be what the page is waiting on.
  var inflight = {};               // id -> startedAt (plain object: ES5-safe)
  var reqSeq = 0;
  var lastRequestStart = 0;        // when the most recent request began
  var lastMutation = Date.now();   // when the DOM last changed
  function reqStart() { var id = ++reqSeq; inflight[id] = Date.now(); lastRequestStart = Date.now(); return id; }
  function reqEnd(id) { delete inflight[id]; }
  // Requests started within longLivedMs — i.e. still plausibly in progress.
  function youngPending(now, longLivedMs) {
    var n = 0;
    for (var k in inflight) { if (Object.prototype.hasOwnProperty.call(inflight, k) && (now - inflight[k]) < longLivedMs) n++; }
    return n;
  }
  function totalPending() {
    var n = 0;
    for (var k in inflight) { if (Object.prototype.hasOwnProperty.call(inflight, k)) n++; }
    return n;
  }
  try {
    var mo = new MutationObserver(function() { lastMutation = Date.now(); });
    var startObs = function() {
      try { if (document.documentElement) mo.observe(document.documentElement, { childList: true, subtree: true, attributes: true, characterData: true }); } catch (e) {}
    };
    startObs();
    document.addEventListener('DOMContentLoaded', startObs);
  } catch (e) {}

  // FIFO push: when arr is at cap, drop oldest entry to keep the most recent.
  // Previous implementation dropped NEW entries, causing long sessions to
  // retain stale initial-page traffic while recent activity went uncaptured.
  function pushCapped(arr, item, cap) {
    if (arr.length >= cap) arr.shift();
    arr.push(item);
  }

  // --- Listener registry ---
  var origAddEventListener = EventTarget.prototype.addEventListener;
  EventTarget.prototype.addEventListener = function(type, handler, options) {
    if (handler) {
      var el = this;
      var tag = '';
      var id = '';
      try { tag = el.tagName || ''; } catch(e) {}
      try { id = el.id || ''; } catch(e) {}
      var stack = '';
      try { stack = new Error().stack || ''; } catch(e) {}
      pushCapped(listeners, {
        ref: typeof WeakRef !== 'undefined' ? new WeakRef(el) : { deref: function() { return el; } },
        eventType: type,
        stack: stack,
        elementTag: tag,
        elementId: id
      }, LISTENER_CAP);
    }
    return origAddEventListener.apply(this, arguments);
  };

  // --- Network proxy: fetch ---
  var origFetch = window.fetch;
  window.fetch = function(input, init) {
    var method = (init && init.method) ? init.method.toUpperCase() : 'GET';
    var url = '';
    try {
      url = typeof input === 'string' ? input : (input && input.url ? input.url : String(input));
    } catch(e) {}
    var stack = '';
    try { stack = new Error().stack || ''; } catch(e) {}
    pushCapped(networkCalls, {
      type: 'fetch',
      method: method,
      url: url,
      stack: stack,
      timestamp: Date.now()
    }, NETWORK_CAP);
    var rid = reqStart();
    var fp = origFetch.apply(this, arguments);
    // Attach a settle handler WITHOUT changing the promise the caller receives
    // (returning fp, not fp.then(...)), so page semantics are untouched.
    // Bound to rid: reqEnd now takes an id, and a rejected fetch must release
    // its slot too — hence the same handler on both paths.
    var end = function() { reqEnd(rid); };
    try { fp.then(end, end); } catch (e) { end(); }
    return fp;
  };

  // --- Network proxy: XHR ---
  var origXHROpen = XMLHttpRequest.prototype.open;
  var origXHRSend = XMLHttpRequest.prototype.send;

  XMLHttpRequest.prototype.open = function(method, url) {
    this.__veil_method = (method || 'GET').toUpperCase();
    this.__veil_url = String(url);
    return origXHROpen.apply(this, arguments);
  };

  XMLHttpRequest.prototype.send = function() {
    var stack = '';
    try { stack = new Error().stack || ''; } catch(e) {}
    pushCapped(networkCalls, {
      type: 'xhr',
      method: this.__veil_method || 'GET',
      url: this.__veil_url || '',
      stack: stack,
      timestamp: Date.now()
    }, NETWORK_CAP);
    var rid = reqStart();
    // 'loadend' fires exactly once on success, error, OR abort — one release.
    var settled = false;
    var dec = function() { if (!settled) { settled = true; reqEnd(rid); } };
    try { this.addEventListener('loadend', dec); } catch (e) {}
    return origXHRSend.apply(this, arguments);
  };

  // --- Navigation proxy ---
  var origPushState = history.pushState;
  var origReplaceState = history.replaceState;

  history.pushState = function(state, title, url) {
    var stack = '';
    try { stack = new Error().stack || ''; } catch(e) {}
    pushCapped(navigations, {
      type: 'pushState',
      url: url ? String(url) : '',
      stack: stack,
      timestamp: Date.now()
    }, NAV_CAP);
    return origPushState.apply(this, arguments);
  };

  history.replaceState = function(state, title, url) {
    var stack = '';
    try { stack = new Error().stack || ''; } catch(e) {}
    pushCapped(navigations, {
      type: 'replaceState',
      url: url ? String(url) : '',
      stack: stack,
      timestamp: Date.now()
    }, NAV_CAP);
    return origReplaceState.apply(this, arguments);
  };

  // --- Query interface ---
  window.__veil = {
    getListenerRegistry: function() {
      var result = [];
      var alive = [];
      for (var i = 0; i < listeners.length; i++) {
        var entry = listeners[i];
        var el = entry.ref.deref();
        if (el) {
          alive.push(entry);
          result.push({
            eventType: entry.eventType,
            stack: entry.stack,
            elementTag: entry.elementTag,
            elementId: entry.elementId
          });
        }
      }
      listeners = alive;
      return result;
    },
    getNetworkCalls: function() {
      return networkCalls.slice();
    },
    getNavigations: function() {
      return navigations.slice();
    },
    // Event-driven settle: resolves when the page is genuinely done reacting —
    // no in-flight requests and the DOM has been quiet for a short window. The
    // host awaits this over CDP (awaitPromise) instead of a fixed timer, so an
    // idle interaction returns in ~a frame and a real fetch is waited out for
    // exactly its real duration. A cap backstops pathological never-idle pages.
    whenQuiet: function(opts) {
      opts = opts || {};
      var quietMs = opts.quietMs || 40;      // DOM-quiet window (~2-3 frames)
      var cap = opts.capMs || 12000;         // pathological-page backstop
      var longLivedMs = opts.longLivedMs || 2000;
      var start = Date.now();
      return new Promise(function(resolve) {
        function check() {
          var now = Date.now();
          var young = youngPending(now, longLivedMs);
          if (now - start > cap) {
            resolve({ reason: 'cap', pending: totalPending(), young: young });
            return;
          }
          var domQuiet = (now - lastMutation) >= quietMs;
          // Only requests YOUNG enough to still be "the page working" block
          // settle. A request open longer than longLivedMs is a persistent
          // connection (long-poll, SSE-over-XHR, keepalive) that will never
          // close; waiting for it degrades this event-driven settle into a
          // fixed cap-length timeout on every action. Data that lands later
          // still reaches the graph via the MutationWatcher's incremental
          // update path, so settling early loses nothing permanently.
          var reqQuiet = young === 0 && (now - lastRequestStart) >= quietMs;
          if (domQuiet && reqQuiet) { resolve({ reason: 'quiet' }); return; }
          setTimeout(check, 12);
        }
        // Defer one macrotask so a handler firing a request/mutation synchronously
        // after the interaction is observed before we sample.
        setTimeout(check, 0);
      });
    }
  };
})();`;

// --- Query helper ---

export async function queryInjectedRegistry(
  cdp: CDPClient,
): Promise<InjectedRegistryData> {
  const empty: InjectedRegistryData = {
    listeners: [],
    networkCalls: [],
    navigations: [],
  };

  try {
    const result = (await cdp.send("Runtime.evaluate", {
      expression: `(function() {
        if (!window.__veil) return null;
        return {
          listeners: window.__veil.getListenerRegistry(),
          networkCalls: window.__veil.getNetworkCalls(),
          navigations: window.__veil.getNavigations()
        };
      })()`,
      returnByValue: true,
      awaitPromise: false,
    })) as { result: { value?: InjectedRegistryData | null } };

    return result.result?.value ?? empty;
  } catch {
    return empty;
  }
}
