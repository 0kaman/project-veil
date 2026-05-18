import { describe, it, expect, beforeEach } from "vitest";
import { Script, createContext } from "node:vm";
import { INSTRUMENTATION_SCRIPT } from "../browser/instrumentation.js";

interface FakeNetworkCall {
  type: string;
  method: string;
  url: string;
  stack: string;
  timestamp: number;
}

interface FakeNavigation {
  type: string;
  url: string;
  stack: string;
  timestamp: number;
}

interface FakeWindow {
  fetch: (input: unknown, init?: unknown) => unknown;
  __veil?: {
    getNetworkCalls(): FakeNetworkCall[];
    getNavigations(): FakeNavigation[];
    getListenerRegistry(): Array<{ eventType: string; stack: string; elementTag: string; elementId: string }>;
  };
  chrome: { runtime?: unknown };
  history: { pushState: (...args: unknown[]) => unknown; replaceState: (...args: unknown[]) => unknown };
}

/**
 * Build a minimal browser-like context that the INSTRUMENTATION_SCRIPT can run in.
 * Notable shims: EventTarget, fetch, XMLHttpRequest, history, navigator.
 */
function makeBrowserContext(): { ctx: Record<string, unknown>; win: FakeWindow } {
  const calls: Array<{ method: string; url: string }> = [];
  const fetchImpl = (input: unknown, init?: unknown) => {
    calls.push({
      method:
        typeof init === "object" && init !== null && "method" in init
          ? String((init as { method: string }).method)
          : "GET",
      url: String(input),
    });
    return Promise.resolve();
  };

  class FakeEventTarget {
    addEventListener(_t: string, _h: unknown) {
      // overwritten by the instrumentation
    }
  }

  class FakeXHR {
    open(_m: string, _u: string) {}
    send() {}
  }

  const win: FakeWindow = {
    fetch: fetchImpl,
    chrome: { runtime: undefined },
    history: {
      pushState: (..._a: unknown[]) => {},
      replaceState: (..._a: unknown[]) => {},
    },
  };

  // Build the context so the script's `var window = this` / global access works.
  const ctx: Record<string, unknown> = {
    window: win,
    document: { title: "" },
    navigator: { webdriver: false, languages: ["en-US"], plugins: [] },
    Object,
    Array,
    Error,
    String,
    Number,
    Boolean,
    JSON,
    Date,
    Promise,
    setTimeout,
    clearTimeout,
    queueMicrotask,
    EventTarget: FakeEventTarget,
    XMLHttpRequest: FakeXHR,
    WeakRef: typeof WeakRef !== "undefined" ? WeakRef : undefined,
  };
  ctx.self = ctx;
  // Mirror window properties on the global so `window.fetch = ...` reflects on global `fetch` reads
  Object.defineProperty(ctx, "fetch", {
    get: () => win.fetch,
    set: (v) => { win.fetch = v as FakeWindow["fetch"]; },
  });
  Object.defineProperty(ctx, "history", {
    get: () => win.history,
  });
  Object.defineProperty(ctx, "__veil", {
    get: () => win.__veil,
    set: (v) => { win.__veil = v as FakeWindow["__veil"]; },
  });

  return { ctx, win };
}

function runInstrumentation(ctx: Record<string, unknown>): void {
  const script = new Script(INSTRUMENTATION_SCRIPT);
  script.runInContext(createContext(ctx));
}

describe("instrumentation — eviction policy (C1)", () => {
  let ctx: Record<string, unknown>;
  let win: FakeWindow;

  beforeEach(() => {
    const built = makeBrowserContext();
    ctx = built.ctx;
    win = built.win;
    runInstrumentation(ctx);
  });

  it("network calls evict oldest entries when over cap, retaining most recent", () => {
    // NETWORK_CAP is 500 in the instrumentation script. Fire 600 fetches —
    // the first 100 should be evicted, the last 500 retained.
    for (let i = 0; i < 600; i++) {
      win.fetch(`https://example.com/api/${i}`);
    }

    const recorded = win.__veil!.getNetworkCalls();
    expect(recorded).toHaveLength(500);
    // Most recent retained
    expect(recorded[recorded.length - 1].url).toBe("https://example.com/api/599");
    // Oldest retained is 100, not 0 (the first 100 were evicted)
    expect(recorded[0].url).toBe("https://example.com/api/100");
  });

  it("navigations evict oldest when over cap", () => {
    // NAV_CAP is 100
    for (let i = 0; i < 150; i++) {
      win.history.pushState({}, "", `/page-${i}`);
    }

    const recorded = win.__veil!.getNavigations();
    expect(recorded).toHaveLength(100);
    expect(recorded[recorded.length - 1].url).toBe("/page-149");
    expect(recorded[0].url).toBe("/page-50");
  });
});
