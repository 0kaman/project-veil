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
    return origFetch.apply(this, arguments);
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
