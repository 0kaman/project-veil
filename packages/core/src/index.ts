/**
 * @veil/core — the engine. First slice: RENDER.
 *
 *   const r = new Renderer();
 *   const page = await r.render("https://spa.example/app");  // runs the JS
 *   page.html      // fully rendered HTML — what @veil/read couldn't get by fetch
 *   await r.close();
 *
 * This is the browser as a *renderer* for the read tier: it turns a js-shell
 * (content only after JavaScript runs) into real HTML. The behavior graph and
 * interaction (veil_open/do/replay) are later slices built on this same
 * CDP foundation. Zero runtime deps — pure CDP over Node's global WebSocket.
 *
 * The browser is launched lazily and held open across render() calls; each
 * render gets its OWN target (tab) so concurrent renders can't hijack one
 * another. close() shuts the browser down.
 */
export { chromeAvailable, findChromeBinary } from "./browser/launcher.js";
export type { CDPClient } from "./browser/cdp-client.js";
export type { RenderPageResult, SettleOptions } from "./browser/page.js";

// ── the behavior graph (act path) ──────────────────────────────────────────
export type {
  BehaviorGraph,
  BehaviorNode,
  EventBinding,
  EventCategory,
  GraphMeta,
  NodeState,
} from "./graph/model.js";
export { DOER_ROLES, NAV_ROLES, routeOf } from "./graph/model.js";
export { buildGraph, type BuildResult } from "./graph/build.js";
export { projectLean, type ProjectOptions } from "./graph/project.js";
export { queryNodes, type NodeFilter, type QueryResult } from "./graph/query.js";
export { assignDisplayIds } from "./graph/ids.js";
export {
  SessionPool,
  type Session,
  type OpenResult,
  type PoolOptions,
  type GoneReason,
} from "./session.js";
export { browserTreeRssMb } from "./browser/memory.js";
export type { ActResult } from "./session.js";
export type { Action, ActionKind, ActionFailure } from "./browser/interact.js";
export { awaitSettle, settleConfig, type SettleResult, type SettleConfig } from "./browser/settle.js";
export { diffGraphs, isNoOp, type GraphDiff } from "./graph/diff.js";
export { urlPattern, type CapturedRequest } from "./browser/capture.js";

import { launchBrowser, type BrowserHandle } from "./browser/launcher.js";
import { createCDPClient, type CDPClient } from "./browser/cdp-client.js";
import { renderPage, type SettleOptions } from "./browser/page.js";
import { buildGraph } from "./graph/build.js";
import { projectLean } from "./graph/project.js";
import type { BehaviorGraph } from "./graph/model.js";
import type { Stage2Stats } from "./pipeline/stage-2-events.js";
import { debugLog } from "./debug.js";

export interface RenderResult {
  /** Fully rendered HTML after JavaScript ran. Empty on failure — see `ok`. */
  html: string;
  finalUrl: string;
  ms: number;
  ok: boolean;
  /** Set when the render failed (launch, navigation, or connection). */
  error?: string;
}

/** Result of perceiving a page. Never throws — a failure is `{ ok: false }`,
 * mirroring the read/search receipts one layer up. */
export type PerceiveResult =
  | { ok: true; ms: number; graph: BehaviorGraph; lean: string; stage2: Stage2Stats }
  | { ok: false; ms: number; error: string };

export interface RendererOptions extends SettleOptions {
  /** Reuse an already-launched browser (e.g. a shared pool). */
  browser?: BrowserHandle;
}

export class Renderer {
  private browser: BrowserHandle | null;
  private launching: Promise<BrowserHandle> | null = null;
  private readonly ownsBrowser: boolean;
  private readonly settle: SettleOptions;

  constructor(opts: RendererOptions = {}) {
    const { browser, ...settle } = opts;
    this.browser = browser ?? null;
    this.ownsBrowser = !browser;
    this.settle = settle;
  }

  /** Launch once, then reuse. Guarded so concurrent render()s can't spawn two. */
  private async ensureBrowser(): Promise<BrowserHandle> {
    if (this.browser) return this.browser;
    if (!this.launching) {
      this.launching = launchBrowser()
        .then((b) => (this.browser = b))
        .finally(() => (this.launching = null));
    }
    return this.launching;
  }

  /**
   * Render a URL with a real browser and return the HTML after JS has run.
   * Never throws — a failure comes back as `{ ok: false, error }`, mirroring
   * the read/search receipts one layer up.
   */
  async render(url: string): Promise<RenderResult> {
    const t0 = Date.now();
    let browser: BrowserHandle;
    try {
      browser = await this.ensureBrowser();
    } catch (err) {
      return { html: "", finalUrl: url, ms: Date.now() - t0, ok: false, error: `launch failed: ${msg(err)}` };
    }

    let targetId: string | undefined;
    let client: CDPClient | undefined;
    try {
      const browserClient = await createCDPClient(browser.wsUrl);
      // A fresh target per render — isolation between concurrent renders.
      const created = (await browserClient.send("Target.createTarget", { url: "about:blank" })) as {
        targetId: string;
      };
      targetId = created.targetId;
      browserClient.close();

      client = await createCDPClient(`ws://127.0.0.1:${browser.port}/devtools/page/${targetId}`);
      const page = await renderPage(client, url, this.settle);
      const ms = Date.now() - t0;
      if (page.errorText) {
        return { html: "", finalUrl: page.finalUrl, ms, ok: false, error: page.errorText };
      }
      return { html: page.html, finalUrl: page.finalUrl, ms, ok: true };
    } catch (err) {
      return { html: "", finalUrl: url, ms: Date.now() - t0, ok: false, error: msg(err) };
    } finally {
      client?.close();
      if (targetId) await this.closeTarget(browser, targetId);
    }
  }

  /**
   * Perceive a page: navigate, settle, build the behavior graph, and project the
   * lean view. Slice 1 of the act path — it opens a target, reads, and closes it.
   * The real session model (a tab held open across veil_do calls) lands next.
   */
  async perceive(url: string): Promise<PerceiveResult> {
    const t0 = Date.now();
    let browser: BrowserHandle;
    try {
      browser = await this.ensureBrowser();
    } catch (err) {
      return { ok: false, ms: Date.now() - t0, error: `launch failed: ${msg(err)}` };
    }

    let targetId: string | undefined;
    let client: CDPClient | undefined;
    try {
      const bc = await createCDPClient(browser.wsUrl);
      const created = (await bc.send("Target.createTarget", { url: "about:blank" })) as {
        targetId: string;
      };
      targetId = created.targetId;
      bc.close();

      client = await createCDPClient(`ws://127.0.0.1:${browser.port}/devtools/page/${targetId}`);
      // DOM + Accessibility must be enabled before the graph passes run.
      await client.send("DOM.enable");
      await client.send("Accessibility.enable");
      const page = await renderPage(client, url, this.settle);
      if (page.errorText) {
        return { ok: false, ms: Date.now() - t0, error: page.errorText };
      }
      // renderPage navigated the document; re-prime DOM for the new one.
      await client.send("DOM.getDocument", { depth: -1 });

      const { graph, stage2 } = await buildGraph(client);
      return {
        ok: true,
        ms: Date.now() - t0,
        graph,
        lean: projectLean(graph),
        stage2,
      };
    } catch (err) {
      return { ok: false, ms: Date.now() - t0, error: msg(err) };
    } finally {
      client?.close();
      if (targetId) await this.closeTarget(browser, targetId);
    }
  }

  private async closeTarget(browser: BrowserHandle, targetId: string): Promise<void> {
    try {
      const bc = await createCDPClient(browser.wsUrl);
      await bc.send("Target.closeTarget", { targetId });
      bc.close();
    } catch (err) {
      debugLog("render: closeTarget failed", err);
    }
  }

  /** Shut the browser down. No-op if a browser was injected (caller owns it). */
  async close(): Promise<void> {
    if (this.ownsBrowser && this.browser) {
      await this.browser.close();
      this.browser = null;
    }
  }
}

function msg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
