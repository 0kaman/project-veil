/**
 * Tests for navigation race conditions in VeilPage.
 *
 * These tests mock the CDP layer and pipeline stages to isolate the
 * coordination logic between interact(), MutationWatcher, and getGraph().
 *
 * Scenario: clicking "Sign In" triggers a full-page navigation.
 * Before the fix, both interact() and MutationWatcher would race to
 * rebuild the graph, often producing stale or missing results.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { VeilPage } from "../index.js";
import type { PageHandle, AXNode } from "../browser/page.js";
import type { CDPClient } from "../browser/cdp-client.js";
import type { BehaviorGraph, GraphDiff } from "../graph/model.js";

// ── Mock CDP Client ──

type CDPListener = (params: unknown) => void;

/**
 * Creates a mock CDP client with an interceptable send hook.
 * `sendHook` is checked on every send — if it returns non-undefined,
 * that value is used. Otherwise the default handler runs.
 */
function createMockCDP() {
  const listeners = new Map<string, Set<CDPListener>>();
  const sendLog: string[] = [];

  /** Override this to intercept specific methods. Return undefined to fall through. */
  let sendHook: ((method: string, params?: Record<string, unknown>) => unknown | undefined) | null = null;

  /** Mutable state for what the "page" returns */
  let currentAXTree: () => AXNode[] = makeLoginAXTree;
  let currentTitle = "Login";
  let currentUrl = "https://github.com/login";

  async function defaultSend(method: string, params?: Record<string, unknown>): Promise<unknown> {
    sendLog.push(method);

    if (method === "Accessibility.getFullAXTree") {
      return { nodes: currentAXTree() };
    }
    if (method === "Runtime.evaluate") {
      const p = params as { expression: string } | undefined;
      if (p?.expression === "document.title") {
        return { result: { value: currentTitle } };
      }
      if (p?.expression === "window.location.href") {
        return { result: { value: currentUrl } };
      }
      return { result: { value: undefined } };
    }
    if (method === "DOM.getDocument") return { root: { nodeId: 1 } };
    if (method === "DOM.getBoxModel") {
      return { model: { content: [100, 100, 200, 100, 200, 140, 100, 140] } };
    }
    if (method === "DOM.resolveNode") return { object: { objectId: "obj-1" } };
    if (method === "DOM.focus") return {};
    if (method === "Input.dispatchMouseEvent") return {};
    return {};
  }

  const cdp: CDPClient = {
    send: vi.fn(async (method: string, params?: Record<string, unknown>) => {
      // Check hook first
      if (sendHook) {
        const result = sendHook(method, params);
        if (result !== undefined) return result;
      }
      return defaultSend(method, params);
    }),

    on(event: string, callback: CDPListener) {
      let set = listeners.get(event);
      if (!set) { set = new Set(); listeners.set(event, set); }
      set.add(callback);
    },

    off(event: string, callback: CDPListener) {
      listeners.get(event)?.delete(callback);
    },

    close: vi.fn(),
  };

  function emit(event: string, params: unknown = {}) {
    const set = listeners.get(event);
    if (set) {
      for (const cb of set) cb(params);
    }
  }

  function hasListener(event: string): boolean {
    const set = listeners.get(event);
    return !!set && set.size > 0;
  }

  return {
    cdp,
    emit,
    hasListener,
    sendLog,
    /** Set a hook to intercept CDP.send. Return a value to override, or undefined to fall through. */
    setSendHook(hook: typeof sendHook) { sendHook = hook; },
    /** Change what "page" data the mock CDP returns */
    setPage(axTree: () => AXNode[], title: string, url: string) {
      currentAXTree = axTree;
      currentTitle = title;
      currentUrl = url;
    },
  };
}

// ── Mock AX Trees ──

function makeLoginAXTree(): AXNode[] {
  return [
    {
      nodeId: "root",
      ignored: false,
      role: { type: "role", value: "WebArea" },
      name: { type: "computedString", value: "Login" },
      childIds: ["username-field", "password-field", "signin-btn"],
      backendDOMNodeId: 1,
    },
    {
      nodeId: "username-field",
      ignored: false,
      role: { type: "role", value: "textbox" },
      name: { type: "computedString", value: "Username" },
      parentId: "root",
      childIds: [],
      backendDOMNodeId: 10,
    },
    {
      nodeId: "password-field",
      ignored: false,
      role: { type: "role", value: "textbox" },
      name: { type: "computedString", value: "Password" },
      parentId: "root",
      childIds: [],
      backendDOMNodeId: 11,
    },
    {
      nodeId: "signin-btn",
      ignored: false,
      role: { type: "role", value: "button" },
      name: { type: "computedString", value: "Sign In" },
      parentId: "root",
      childIds: [],
      backendDOMNodeId: 12,
    },
  ];
}

function makeDashboardAXTree(): AXNode[] {
  return [
    {
      nodeId: "dash-root",
      ignored: false,
      role: { type: "role", value: "WebArea" },
      name: { type: "computedString", value: "Dashboard" },
      childIds: ["dash-nav", "dash-content"],
      backendDOMNodeId: 100,
    },
    {
      nodeId: "dash-nav",
      ignored: false,
      role: { type: "role", value: "navigation" },
      name: { type: "computedString", value: "Main nav" },
      parentId: "dash-root",
      childIds: [],
      backendDOMNodeId: 101,
    },
    {
      nodeId: "dash-content",
      ignored: false,
      role: { type: "role", value: "main" },
      name: { type: "computedString", value: "Dashboard content" },
      parentId: "dash-root",
      childIds: [],
      backendDOMNodeId: 102,
    },
  ];
}

// ── Mock PageHandle ──

function createMockPage(cdp: CDPClient) {
  const page: PageHandle = {
    cdp,
    navigate: vi.fn(async () => {}),
    getAXTree: vi.fn(async () => {
      const result = await cdp.send("Accessibility.getFullAXTree");
      return (result as { nodes: AXNode[] }).nodes;
    }),
    getTitle: vi.fn(async () => {
      const result = await cdp.send("Runtime.evaluate", { expression: "document.title", returnByValue: true });
      return (result as { result: { value: string } }).result.value;
    }),
    getCapturedRequests: vi.fn(() => []),
    getNewCapturedRequests: vi.fn(() => []),
    startNetworkCapture: vi.fn(async () => {}),
    getCurrentUrl: vi.fn(async () => {
      const result = await cdp.send("Runtime.evaluate", { expression: "window.location.href", returnByValue: true });
      return (result as { result: { value: string } }).result.value;
    }),
    close: vi.fn(),
  };

  return page;
}

// ── Stub infrastructure & pipeline stages ──

// Mock network idle + DOM settle — they use real CDP timers which slow tests.
// Also mock waitForSettleOrNavigation: its internal calls to the above bind
// via in-module closure and bypass the mock entries on the same module, so
// without an explicit override the real (slow) settle waits fire.
vi.mock("../browser/page.js", async (importOriginal) => {
  const orig = await importOriginal<typeof import("../browser/page.js")>();
  return {
    ...orig,
    waitForNetworkIdle: vi.fn(async () => {}),
    waitForDomSettle: vi.fn(async () => {}),
    waitForSettleOrNavigation: vi.fn(async () => {}),
  };
});

vi.mock("../pipeline/stage-2-events.js", () => ({
  enrichGraphWithEvents: vi.fn(async () => {}),
  enrichSpecificNodesWithEvents: vi.fn(async () => {}),
}));

vi.mock("../pipeline/stage-3-network.js", () => ({
  correlateNetwork: vi.fn(() => {}),
}));

vi.mock("../pipeline/stage-4-components.js", () => ({
  groupComponents: vi.fn(async () => {}),
  regroupComponents: vi.fn(async () => {}),
}));

vi.mock("../pipeline/stage-5-semantics.js", () => ({
  inferSemantics: vi.fn(async () => {}),
  reinferSemantics: vi.fn(() => {}),
}));

// ── Helper ──

function flush(ms = 100): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ── Tests ──

describe("VeilPage navigation race conditions", () => {
  let mock: ReturnType<typeof createMockCDP>;
  let page: PageHandle;
  let veilPage: VeilPage;

  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    mock = createMockCDP();
    page = createMockPage(mock.cdp);
    veilPage = new VeilPage(page, "https://github.com/login");
  });

  afterEach(() => {
    veilPage.close();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  // ─── getGraph() concurrent build guard ───

  describe("getGraph() concurrent build guard", () => {
    it("should deduplicate concurrent getGraph() calls", async () => {
      const [graph1, graph2] = await Promise.all([
        veilPage.getGraph(),
        veilPage.getGraph(),
      ]);

      expect(graph1).toBe(graph2);
      expect(page.getAXTree).toHaveBeenCalledTimes(1);
    });

    it("should return cached graph on subsequent calls", async () => {
      const graph1 = await veilPage.getGraph();
      const graph2 = await veilPage.getGraph();

      expect(graph1).toBe(graph2);
      expect(page.getAXTree).toHaveBeenCalledTimes(1);
    });
  });

  // ─── interact() with full-page navigation ───

  describe("interact() with full-page navigation", () => {
    it("should detect navigation and rebuild graph for new page", async () => {
      // Build initial graph (login page)
      const loginGraph = await veilPage.getGraph();
      expect(loginGraph.nodes.has("signin-btn")).toBe(true);
      expect(loginGraph.metadata.title).toBe("Login");

      // Hook: when click dispatched, simulate browser navigation
      mock.setSendHook((method, params) => {
        if (method === "Input.dispatchMouseEvent" && (params as { type?: string })?.type === "mouseReleased") {
          // Emit frameNavigated synchronously (happens before waits resolve)
          mock.emit("Page.frameNavigated", { frame: { id: "main" } });
          mock.emit("DOM.documentUpdated");
          // loadEventFired fires after interact() sets up its listener
          setTimeout(() => {
            mock.setPage(makeDashboardAXTree, "Dashboard", "https://github.com/dashboard");
            mock.emit("Page.loadEventFired");
          }, 10);
          return {}; // handled
        }
        return undefined; // fall through to default
      });

      // Track change listener notifications
      const changes: Array<{ graph: BehaviorGraph; diff: GraphDiff }> = [];
      veilPage.onGraphChange((graph, diff) => {
        changes.push({ graph, diff });
      });

      // Click "Sign In" — triggers navigation
      const resultGraph = await veilPage.interact("signin-btn", { action: "click" });

      // Result should be the dashboard graph
      expect(resultGraph.nodes.has("dash-root")).toBe(true);
      expect(resultGraph.nodes.has("dash-nav")).toBe(true);
      expect(resultGraph.nodes.has("signin-btn")).toBe(false);
      expect(resultGraph.metadata.title).toBe("Dashboard");

      // Change listeners should have been notified
      expect(changes.length).toBeGreaterThanOrEqual(1);
      const lastChange = changes[changes.length - 1];
      expect(lastChange.graph.nodes.has("dash-root")).toBe(true);
      expect(lastChange.diff.removed).toContain("signin-btn");
      expect(lastChange.diff.added).toContain("dash-root");
    });

    it("should suppress mutation watcher during interact", async () => {
      await veilPage.getGraph();

      // Count AXTree fetches after initial build
      let buildCount = 0;
      const origGetAXTree = page.getAXTree as ReturnType<typeof vi.fn>;
      const origImpl = origGetAXTree.getMockImplementation()!;
      origGetAXTree.mockImplementation(async () => {
        buildCount++;
        return origImpl();
      });
      buildCount = 0;

      // Hook: emit DOM.documentUpdated during click (watcher would normally react)
      mock.setSendHook((method, params) => {
        if (method === "Input.dispatchMouseEvent" && (params as { type?: string })?.type === "mouseReleased") {
          mock.emit("DOM.documentUpdated");
          return {};
        }
        return undefined;
      });

      await veilPage.interact("signin-btn", { action: "click" });

      // interact() does: 1 incrementalUpdate attempt + 1 full rebuild fallback = 2 max
      // If watcher were NOT suppressed, it would add another concurrent rebuild
      expect(buildCount).toBeLessThanOrEqual(2);
    });

    it("should unsuppress watcher after interact completes", async () => {
      await veilPage.getGraph();

      // Simple non-navigating interact
      await veilPage.interact("signin-btn", { action: "click" });

      // After interact, emit a mutation and verify watcher is active
      mock.emit("DOM.childNodeInserted", {});
      await vi.advanceTimersByTimeAsync(200);
      await flush(100);

      // No errors thrown = watcher is running and unsuppressed
    });
  });

  // ─── interact() without navigation ───

  describe("interact() without navigation", () => {
    it("should return valid graph when no navigation occurs", async () => {
      const graph = await veilPage.getGraph();
      expect(graph.nodes.has("signin-btn")).toBe(true);

      const result = await veilPage.interact("signin-btn", { action: "click" });

      expect(result).toBeDefined();
      expect(result.nodes.size).toBeGreaterThan(0);
    });
  });

  // ─── MutationWatcher suppression ───

  describe("MutationWatcher suppression", () => {
    it("suppress() should buffer highest-priority reason", async () => {
      const { MutationWatcher } = await import("../browser/mutation-watcher.js");

      const reasons: string[] = [];
      const watcher = new MutationWatcher(
        mock.cdp,
        (reason) => { reasons.push(reason); },
        50,
      );
      await watcher.start();

      watcher.suppress();

      mock.emit("DOM.childNodeInserted", {});  // mutation (buffered)
      mock.emit("DOM.documentUpdated", {});     // navigation > mutation
      mock.emit("DOM.childNodeInserted", {});   // mutation < navigation

      expect(reasons).toEqual([]);

      watcher.unsuppress();
      expect(reasons).toEqual(["navigation"]);

      watcher.stop();
    });

    it("suppress() should capture in-flight debounced mutation", async () => {
      const { MutationWatcher } = await import("../browser/mutation-watcher.js");

      const reasons: string[] = [];
      const watcher = new MutationWatcher(
        mock.cdp,
        (reason) => { reasons.push(reason); },
        100,
      );
      await watcher.start();

      // Start a mutation debounce
      mock.emit("DOM.childNodeInserted", {});

      // Suppress before debounce fires — should capture the in-flight mutation
      watcher.suppress();
      await vi.advanceTimersByTimeAsync(200);

      // Debounced callback should NOT have fired
      expect(reasons).toEqual([]);

      // Unsuppress replays the captured mutation
      watcher.unsuppress();
      expect(reasons).toEqual(["mutation"]);

      watcher.stop();
    });

    it("unsuppress() with no pending reason should be a no-op", async () => {
      const { MutationWatcher } = await import("../browser/mutation-watcher.js");

      const reasons: string[] = [];
      const watcher = new MutationWatcher(
        mock.cdp,
        (reason) => { reasons.push(reason); },
      );
      await watcher.start();

      watcher.suppress();
      watcher.unsuppress();

      expect(reasons).toEqual([]);
      watcher.stop();
    });
  });

  // ─── Error recovery ───

  describe("error recovery", () => {
    it("should invalidate cache when MutationWatcher nav rebuild fails", async () => {
      const graph = await veilPage.getGraph();
      expect(graph).toBeDefined();

      // Make AXTree fail on next call
      let failNext = false;
      const origImpl = (page.getAXTree as ReturnType<typeof vi.fn>).getMockImplementation()!;
      (page.getAXTree as ReturnType<typeof vi.fn>).mockImplementation(async () => {
        if (failNext) throw new Error("Simulated CDP error");
        return origImpl();
      });

      // Trigger navigation via watcher — rebuild will fail
      failNext = true;
      mock.emit("DOM.documentUpdated", {});

      // Wait for async rebuild to fail
      await vi.advanceTimersByTimeAsync(8_000);
      await flush(500);

      // Fix the error — next getGraph() should do a fresh build
      failNext = false;
      const freshGraph = await veilPage.getGraph();
      expect(freshGraph).toBeDefined();
      expect(freshGraph.nodes.size).toBeGreaterThan(0);
    });
  });

  // ─── WS listener notification ───

  describe("WS listener notification on navigation", () => {
    it("should notify all change listeners after navigation interact", async () => {
      await veilPage.getGraph();

      const listener1: Array<{ nodeCount: number; version: number }> = [];
      const listener2: Array<{ nodeCount: number; version: number }> = [];

      veilPage.onGraphChange((graph) => {
        listener1.push({ nodeCount: graph.nodes.size, version: graph.version });
      });
      veilPage.onGraphChange((graph) => {
        listener2.push({ nodeCount: graph.nodes.size, version: graph.version });
      });

      // Hook: simulate navigation on click
      mock.setSendHook((method, params) => {
        if (method === "Input.dispatchMouseEvent" && (params as { type?: string })?.type === "mouseReleased") {
          setTimeout(() => mock.emit("Page.frameNavigated", {}), 10);
          setTimeout(() => {
            mock.setPage(makeDashboardAXTree, "Dashboard", "https://github.com/dashboard");
            mock.emit("Page.loadEventFired");
          }, 50);
          return {};
        }
        return undefined;
      });

      await veilPage.interact("signin-btn", { action: "click" });

      // Both listeners notified
      expect(listener1.length).toBeGreaterThanOrEqual(1);
      expect(listener2.length).toBeGreaterThanOrEqual(1);

      // Both received the same dashboard graph
      const last1 = listener1[listener1.length - 1];
      const last2 = listener2[listener2.length - 1];
      expect(last1.nodeCount).toBe(last2.nodeCount);
      expect(last1.version).toBe(last2.version);
    });
  });
});
