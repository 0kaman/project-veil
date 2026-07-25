/**
 * Sessions — a tab held open, plus everything it has learned.
 *
 * Locked design (DECISIONS 2026-07-25):
 *   - one shared browser, ONE TAB PER SESSION. v1 attached every session to the
 *     first shared page target, so concurrent sessions hijacked each other.
 *   - budget on MEMORY, not session count. Measured 396 MB/tab average with 24×
 *     variance — a fixed "~10 sessions" is meaningless against that spread.
 *   - evict LRU-idle under pressure. Measured: closing tabs reclaims 92% of what
 *     they added, 88% of it within 500ms, and the space genuinely recycles.
 *   - EVICT, don't reject. The 11th open succeeds; touching a reclaimed handle
 *     returns a receipt saying so. An agent should not have to reason about our
 *     memory ceiling.
 *
 * The cookie jar is shared for free: one browser means one profile, so a login
 * performed in any session is visible to every later fetch and tab.
 */
import { launchBrowser, type BrowserHandle } from "./browser/launcher.js";
import { createCDPClient, type CDPClient } from "./browser/cdp-client.js";
import { renderPage, type SettleOptions } from "./browser/page.js";
import { browserTreeRssMb } from "./browser/memory.js";
import { buildGraph } from "./graph/build.js";
import { projectLean } from "./graph/project.js";
import { queryNodes, type NodeFilter, type QueryResult } from "./graph/query.js";
import type { BehaviorGraph } from "./graph/model.js";
import { debugLog } from "./debug.js";

export interface Session {
  id: string;
  url: string;
  targetId: string;
  client: CDPClient;
  graph: BehaviorGraph;
  createdAt: number;
  lastUsed: number;
}

/** Why a session is no longer available — reported, never silent. */
export type GoneReason = "evicted-memory" | "evicted-idle" | "closed" | "unknown";

export interface OpenResult {
  ok: boolean;
  ms: number;
  sessionId?: string;
  lean?: string;
  /** Sessions dropped to make room for this one, so the caller can say so. */
  evicted?: string[];
  /** Browser-tree RSS after this open, MB. -1 when unmeasurable. */
  memoryMb?: number;
  error?: string;
}

export interface PoolOptions extends SettleOptions {
  /** Evict when browser-tree RSS exceeds this. Default 3000 MB — a judgement
   * about the host, NOT a measurement; override per deployment. */
  budgetMb?: number;
  /** Reap sessions untouched for this long. Default 30 min. */
  idleMs?: number;
  /** Hard ceiling as a backstop against pathological growth between checks. */
  maxSessions?: number;
}

function envNum(name: string, d: number): number {
  const v = process.env[name];
  const n = v ? Number(v) : NaN;
  return Number.isFinite(n) ? n : d;
}

export class SessionPool {
  private browser: BrowserHandle | null = null;
  private launching: Promise<BrowserHandle> | null = null;
  private sessions = new Map<string, Session>();
  /** Why each departed session went, so a stale handle gets a real answer. */
  private gone = new Map<string, GoneReason>();
  private seq = 0;
  private readonly opts: Required<Pick<PoolOptions, "budgetMb" | "idleMs" | "maxSessions">>;
  private readonly settle: SettleOptions;

  constructor(options: PoolOptions = {}) {
    const { budgetMb, idleMs, maxSessions, ...settle } = options;
    this.settle = settle;
    this.opts = {
      budgetMb: budgetMb ?? envNum("VEIL_MEMORY_BUDGET_MB", 3000),
      idleMs: idleMs ?? envNum("VEIL_SESSION_IDLE_MS", 30 * 60_000),
      maxSessions: maxSessions ?? envNum("VEIL_MAX_SESSIONS", 24),
    };
  }

  private async ensureBrowser(): Promise<BrowserHandle> {
    if (this.browser) return this.browser;
    if (!this.launching) {
      this.launching = launchBrowser()
        .then((b) => (this.browser = b))
        .finally(() => (this.launching = null));
    }
    return this.launching;
  }

  /** Open a URL in a fresh tab, build its graph, return a handle + lean view. */
  async open(url: string): Promise<OpenResult> {
    const t0 = Date.now();
    let browser: BrowserHandle;
    try {
      browser = await this.ensureBrowser();
    } catch (err) {
      return { ok: false, ms: Date.now() - t0, error: `launch failed: ${msg(err)}` };
    }

    // Make room BEFORE allocating, so we never spike past the budget.
    const evicted = await this.reclaim(browser);

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
      await client.send("DOM.enable");
      await client.send("Accessibility.enable");

      const page = await renderPage(client, url, this.settle);
      if (page.errorText) {
        client.close();
        await this.closeTarget(browser, targetId);
        return { ok: false, ms: Date.now() - t0, error: page.errorText, evicted };
      }
      await client.send("DOM.getDocument", { depth: -1 });

      const { graph } = await buildGraph(client);
      const id = `s${++this.seq}`;
      const now = Date.now();
      this.sessions.set(id, {
        id,
        url: page.finalUrl,
        targetId,
        client,
        graph,
        createdAt: now,
        lastUsed: now,
      });

      return {
        ok: true,
        ms: Date.now() - t0,
        sessionId: id,
        lean: projectLean(graph),
        evicted,
        memoryMb: await browserTreeRssMb(browser.process.pid!),
      };
    } catch (err) {
      client?.close();
      if (targetId) await this.closeTarget(browser, targetId);
      return { ok: false, ms: Date.now() - t0, error: msg(err), evicted };
    }
  }

  /** Query a session's host-side graph. Zero browser cost — it's a filter. */
  query(sessionId: string, filter: NodeFilter): QueryResult | { gone: GoneReason } {
    const s = this.sessions.get(sessionId);
    if (!s) return { gone: this.gone.get(sessionId) ?? "unknown" };
    s.lastUsed = Date.now();
    return queryNodes(s.graph, filter);
  }

  get(sessionId: string): Session | undefined {
    const s = this.sessions.get(sessionId);
    if (s) s.lastUsed = Date.now();
    return s;
  }

  /** Why a handle is unavailable — so the caller can report it honestly. */
  goneReason(sessionId: string): GoneReason {
    return this.gone.get(sessionId) ?? "unknown";
  }

  list(): Array<{ id: string; url: string; ageMs: number; idleMs: number; doers: number }> {
    const now = Date.now();
    return [...this.sessions.values()].map((s) => ({
      id: s.id,
      url: s.url,
      ageMs: now - s.createdAt,
      idleMs: now - s.lastUsed,
      doers: s.graph.doers.length,
    }));
  }

  async close(sessionId: string, reason: GoneReason = "closed"): Promise<boolean> {
    const s = this.sessions.get(sessionId);
    if (!s) return false;
    this.sessions.delete(sessionId);
    this.gone.set(sessionId, reason);
    try {
      s.client.close();
    } catch {
      /* already gone */
    }
    if (this.browser) await this.closeTarget(this.browser, s.targetId);
    return true;
  }

  /**
   * Evict until we're under budget (and under the idle/count backstops).
   * Returns the ids dropped so the caller can report them.
   */
  private async reclaim(browser: BrowserHandle): Promise<string[]> {
    const dropped: string[] = [];

    // 1. Idle reaping — cheap, and independent of memory.
    const now = Date.now();
    for (const s of [...this.sessions.values()]) {
      if (now - s.lastUsed > this.opts.idleMs) {
        await this.close(s.id, "evicted-idle");
        dropped.push(s.id);
      }
    }

    // 2. Memory pressure — the primary control.
    const pid = browser.process.pid;
    if (pid) {
      let rss = await browserTreeRssMb(pid);
      // rss === -1 means unmeasurable. Fall back to the count backstop rather
      // than assuming we have room.
      while (rss > this.opts.budgetMb && this.sessions.size > 0) {
        const lru = [...this.sessions.values()].sort((a, b) => a.lastUsed - b.lastUsed)[0];
        debugLog(`session: evicting ${lru.id} — RSS ${rss}MB over budget ${this.opts.budgetMb}MB`);
        await this.close(lru.id, "evicted-memory");
        dropped.push(lru.id);
        // Reclamation is fast (88% within 500ms) but not instant; give it a beat
        // so the next reading reflects the eviction rather than evicting again.
        await new Promise((r) => setTimeout(r, 500));
        rss = await browserTreeRssMb(pid);
      }
    }

    // 3. Count backstop — catches growth between memory checks, and covers the
    // case where RSS is unmeasurable.
    while (this.sessions.size >= this.opts.maxSessions) {
      const lru = [...this.sessions.values()].sort((a, b) => a.lastUsed - b.lastUsed)[0];
      if (!lru) break;
      await this.close(lru.id, "evicted-memory");
      dropped.push(lru.id);
    }

    return dropped;
  }

  private async closeTarget(browser: BrowserHandle, targetId: string): Promise<void> {
    try {
      const bc = await createCDPClient(browser.wsUrl);
      await bc.send("Target.closeTarget", { targetId });
      bc.close();
    } catch (err) {
      debugLog("session: closeTarget failed", err);
    }
  }

  /** Shut everything down — every tab, then the browser. */
  async shutdown(): Promise<void> {
    for (const id of [...this.sessions.keys()]) await this.close(id, "closed");
    if (this.browser) {
      await this.browser.close();
      this.browser = null;
    }
  }
}

function msg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
