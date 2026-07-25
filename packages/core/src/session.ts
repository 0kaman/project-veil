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
import { awaitSettle, settleConfig, type SettleResult } from "./browser/settle.js";
import { dispatchAction, type Action, type ActionFailure } from "./browser/interact.js";
import { NetworkRecorder, pickPrimary, type CapturedRequest } from "./browser/capture.js";
import { replayRequest, type ReplayEdits, type ReplayOutcome } from "./browser/replay.js";
import { gateReplay, loadConfig, type VeilConfig } from "./config.js";
import { buildGraph } from "./graph/build.js";
import { projectLean } from "./graph/project.js";
import { queryNodes, type NodeFilter, type QueryResult } from "./graph/query.js";
import { diffGraphs, isNoOp, type GraphDiff } from "./graph/diff.js";
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
  /** Records what interactions fire — the replay cache's raw material. */
  recorder: NetworkRecorder;
  /** Replay templates, keyed by stable display id. SESSION state, not graph
   * state: it survives every rebuild (DECISIONS 2026-07-25). */
  replay: Map<string, CapturedRequest>;
  /** What the SERVER has taught us about token values here. `worked` alone
   * proves nothing (a reusable token works every time); a value only moves to
   * `spent` once rejected AFTER having worked. See browser/replay.ts. */
  tokens: { worked: Set<string>; spent: Set<string> };
}

export interface ActResult {
  ok: boolean;
  ms: number;
  /** Set when the action itself couldn't be performed. */
  failure?: ActionFailure | "gone";
  detail?: string;
  settle?: SettleResult;
  diff?: GraphDiff;
  /** What the interaction fired, if anything survived ambient filtering. */
  fired?: { method: string; url: string; status?: number };
  /** True when this taught the replay cache a new template. */
  learnedReplay?: boolean;
  /** What a type/clear/select left in the field, read back from the page. A
   * field can reject or reformat input, and saying nothing about that is how a
   * wrong value travels downstream looking like a perception failure. */
  value?: string;
  noOp?: boolean;
}

export interface ReplayResult extends Partial<ReplayOutcome> {
  ok: boolean;
  ms: number;
  /** Set when we refused before firing: no template, gone session, or the gate. */
  refusal?: "gone" | "no-template" | "gated" | "stale-token";
  /** The node whose request this is has left the page — usually because the
   * interaction that taught us the template navigated away from it. Every
   * "use veil_do instead" hint is UNREACHABLE while this is true. */
  nodeGone?: boolean;
  detail?: string;
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
  /** Replay gate + tunables. Defaults to loadConfig() (env-driven). */
  config?: Partial<VeilConfig>;
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
  /** Settle overrides, forwarded to awaitSettle. */
  private readonly settleOver: { quietMs?: number; capMs?: number; longLivedMs?: number };
  readonly config: VeilConfig;

  constructor(options: PoolOptions = {}) {
    const { budgetMb, idleMs, maxSessions, config, ...settle } = options;
    this.config = loadConfig(config);
    this.settle = settle;
    this.settleOver = {
      ...(settle.quietMs !== undefined && { quietMs: settle.quietMs }),
      ...(settle.capMs !== undefined && { capMs: settle.capMs }),
      ...(settle.longLivedMs !== undefined && { longLivedMs: settle.longLivedMs }),
    };
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
      await client.send("Network.enable");
      // Every session is "the front tab" as far as its agent is concerned, but
      // only one Chrome tab really is. An occluded renderer produces no frames,
      // and Input.dispatchMouseEvent waits on a compositor ack that therefore
      // never comes — measured at a flat 5,467ms per mouse event on a
      // backgrounded tab against 235ms on the foreground one, while focus/type
      // (no Input domain) stayed at ~470ms. Focus emulation makes the page
      // believe it is frontmost without actually switching tabs, which would
      // serialise the very concurrency the pool exists to provide.
      try {
        await client.send("Emulation.setFocusEmulationEnabled", { enabled: true });
      } catch (err) {
        debugLog("focus emulation unavailable — mouse input on background tabs will be slow", err);
      }

      // Attach the recorder BEFORE navigating. The baseline is only as good as
      // what we've observed: attaching after settle meant zero requests had been
      // seen, so the first ambient poll after an action looked novel and got
      // misattributed to it. Load-time traffic IS the ambient baseline.
      const recorder = new NetworkRecorder(client);
      recorder.attach();

      const page = await renderPage(client, url, this.settle);
      if (page.errorText) {
        recorder.detach();
        client.close();
        await this.closeTarget(browser, targetId);
        return { ok: false, ms: Date.now() - t0, error: page.errorText, evicted };
      }
      await client.send("DOM.getDocument", { depth: -1 });

      // The page has loaded; now wait for the ACTIONABLE SURFACE to hold still
      // before perceiving it, so the graph isn't a snapshot of a half-built page.
      await awaitSettle(client, settleConfig(this.settleOver));

      const { graph } = await buildGraph(client);
      const id = `s${++this.seq}`;
      const now = Date.now();
      // Everything the page fired while loading and settling is ambient.
      recorder.markBaseline();
      this.sessions.set(id, {
        id,
        url: page.finalUrl,
        targetId,
        client,
        graph,
        createdAt: now,
        lastUsed: now,
        recorder,
        replay: new Map(),
        tokens: { worked: new Set(), spent: new Set() },
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

  /**
   * Act on a node: dispatch → settle → rebuild → diff. Never throws; an action
   * that can't be performed comes back as a receipt with the reason.
   */
  async act(sessionId: string, nodeId: string, action: Action): Promise<ActResult> {
    const t0 = Date.now();
    const s = this.sessions.get(sessionId);
    if (!s) {
      return {
        ok: false,
        ms: Date.now() - t0,
        failure: "gone",
        detail: `session ${sessionId} is gone (${this.goneReason(sessionId)}) — re-open the page`,
      };
    }
    s.lastUsed = Date.now();

    const node = s.graph.nodes.get(nodeId);
    if (!node || node.backendNodeId === undefined) {
      // Offer the closest thing we do have, rather than a bare failure.
      const near = [...s.graph.nodes.keys()]
        .filter((k) => k.includes(nodeId.split("-")[0] ?? ""))
        .slice(0, 3);
      return {
        ok: false,
        ms: Date.now() - t0,
        failure: "not-found",
        detail:
          `no node "${nodeId}" on this page` +
          (near.length ? ` — did you mean ${near.join(", ")}?` : " — use veil_query to find one"),
      };
    }

    const before = s.graph;
    // Anything already in flight is ambient; only what starts now is ours.
    s.recorder.markBaseline();
    const firedAfter = Date.now();

    const dispatched = await dispatchAction(s.client, node.backendNodeId, action);
    if (!dispatched.ok) {
      // "covered by <div class=...>" names the blocker but cannot be acted on.
      // Turn the overlay's dismiss controls into NODE IDS, which can be.
      let detail = dispatched.detail;
      if (dispatched.dismiss?.length) {
        const wanted = dispatched.dismiss.map((d) => d.toLowerCase());
        const ids = [...s.graph.nodes.values()]
          .filter((n) => n.name && wanted.includes(n.name.trim().toLowerCase()))
          .map((n) => n.id);
        detail = ids.length
          ? `${detail} — dismiss it first: veil_do ${ids.slice(0, 3).join(" or ")}`
          : `${detail} — it offers ${dispatched.dismiss
              .map((d) => `"${d}"`)
              .join(", ")}, but no matching node is in the graph; veil_query for it`;
      } else if (dispatched.backdrop) {
        // Measured: given only "covered by <div class=hsBackDrop>", a live agent
        // ran four queries guessing at "close"/"Close"/"hsBackDrop", found
        // nothing, and abandoned the site. There is nothing to find — say so.
        detail =
          `${detail} — that is a BACKDROP behind an open widget (a menu, calendar or ` +
          `dialog). It has no close control, so do not search for one. Finish or ` +
          `cancel whatever is open — the control you want is inside it, not under it.`;
      }
      return { ok: false, ms: Date.now() - t0, failure: dispatched.failure, detail };
    }

    const settle = await awaitSettle(s.client, settleConfig(this.settleOver));

    // Full rebuild — always. Cheap relative to settle, and structurally cannot
    // go stale (v1's incremental path produced stale request shapes that then
    // fed replay: a confidently wrong ACTION).
    let after = before;
    try {
      await s.client.send("DOM.getDocument", { depth: -1 });
      after = (await buildGraph(s.client)).graph;
      s.graph = after;
      s.url = after.meta.url;
    } catch (err) {
      debugLog("act: rebuild failed", err);
    }

    // What did it fire? Teach the replay cache if this is new.
    // Pass the typed value: it identifies WHICH of the fired requests was meant.
    const fired = pickPrimary(s.recorder.since(firedAfter), action.value);
    let learnedReplay = false;
    if (fired) {
      if (!s.replay.has(nodeId)) {
        s.replay.set(nodeId, fired);
        learnedReplay = true;
      }
      const n = s.graph.nodes.get(nodeId);
      if (n) {
        n.fires = `${fired.method} ${shortUrl(fired.url)}`;
        n.replayable = true;
      }
    }
    s.recorder.prune();

    const diff = diffGraphs(before, after);
    return {
      ok: true,
      ms: Date.now() - t0,
      settle,
      diff,
      ...(fired && {
        fired: { method: fired.method, url: shortUrl(fired.url), status: fired.status },
      }),
      learnedReplay,
      ...(dispatched.value !== undefined && { value: dispatched.value }),
      noOp: isNoOp(diff) && !fired,
    };
  }

  /**
   * Replay what a node's interaction fired, with optional edits. Returns the API
   * RESPONSE, not a graph — a raw request changes server state and returns data;
   * it does not drive the app's DOM. Read the graph afterwards if you need the
   * resulting page state.
   */
  async replay(sessionId: string, nodeId: string, edits?: ReplayEdits): Promise<ReplayResult> {
    const t0 = Date.now();
    const s = this.sessions.get(sessionId);
    if (!s) {
      return {
        ok: false,
        ms: Date.now() - t0,
        refusal: "gone",
        detail: `session ${sessionId} is gone (${this.goneReason(sessionId)}) — re-open the page`,
      };
    }
    s.lastUsed = Date.now();

    const tmpl = s.replay.get(nodeId);
    if (!tmpl) {
      // You cannot replay what was never observed. That's the guard, not a gap:
      // veil_do has to perform it once so we know what "it" is.
      const known = [...s.replay.keys()];
      return {
        ok: false,
        ms: Date.now() - t0,
        refusal: "no-template",
        detail:
          `nothing captured for "${nodeId}" — veil_do it once first so its request is learned` +
          (known.length ? `. Replayable here: ${known.join(", ")}` : ""),
      };
    }

    // Every refusal below points at veil_do. Check FIRST whether veil_do could
    // actually run: the replay cache is keyed by node id and survives
    // navigation, so a template happily outlives the node that taught it.
    // Measured — a live agent was told "use veil_do to perform it for real"
    // after submitting a form, did exactly that, and got NOT-FOUND, because the
    // submit had navigated to the response page. Advice that cannot be followed
    // is worse than no advice.
    const nodeGone = !s.graph.nodes.has(nodeId);
    const reopen = nodeGone
      ? ` NOTE: "${nodeId}" is no longer on this page — it is now at ${s.url}. ` +
        `veil_open the original page again first, then veil_do; the node id will be there.`
      : "";

    // The gate, checked again HERE and not only at tool registration: config at
    // startup is not the same thing as config at the moment a request leaves.
    const verdict = gateReplay(this.config, tmpl.method, tmpl.url);
    if (!verdict.allowed) {
      return {
        ok: false,
        ms: Date.now() - t0,
        refusal: "gated",
        ...(nodeGone && { nodeGone }),
        detail: (verdict.reason ?? "") + reopen,
      };
    }

    const outcome = await replayRequest(s.client, tmpl, edits, s.tokens);
    if (outcome.staleRefusal) {
      return {
        ok: false,
        ms: Date.now() - t0,
        refusal: "stale-token",
        ...(nodeGone && { nodeGone }),
        detail: outcome.staleRefusal + reopen,
      };
    }
    // Keep the ledger on SERVER evidence only. A success means the value worked
    // — not that it is used up, since a session-scoped token works every time.
    // A value is spent only once rejected after it had previously worked.
    // `desynced` already encodes the full evidence test (unedited + a rejection
    // of a previously-working value). Reusing it keeps one rule, not two.
    for (const t of outcome.tokensSent) {
      if (outcome.ok) s.tokens.worked.add(t);
      else if (outcome.desynced) s.tokens.spent.add(t);
    }
    const detail = outcome.desynced
      ? `that token worked before and the server has now rejected it, so it was ` +
        `single-use — and the page still holds it. The page is out of step with the ` +
        `server: real clicks on this node will fail too. Re-perceive (veil_open).`
      : undefined;
    return {
      ...outcome,
      ms: Date.now() - t0,
      ...(nodeGone && { nodeGone }),
      ...(detail && { detail: detail + reopen }),
    };
  }

  /**
   * The live document of an open session, as HTML.
   *
   * The graph is behaviour, deliberately — but after an agent has ACTED, the
   * answer it was after is prose, and that prose exists nowhere else. Measured:
   * an agent drove a flight search to a results page, called veil_read with the
   * session id, and got FETCH-FAILED; re-fetching the URL would have discarded
   * the form state that produced the results. So the session has to be readable.
   */
  async html(sessionId: string): Promise<{ html: string; url: string } | { gone: GoneReason }> {
    const s = this.sessions.get(sessionId);
    if (!s) return { gone: this.gone.get(sessionId) ?? "unknown" };
    s.lastUsed = Date.now();
    try {
      const r = (await s.client.send("Runtime.evaluate", {
        expression: "document.documentElement.outerHTML",
        returnByValue: true,
      })) as { result?: { value?: string } };
      return { html: r.result?.value ?? "", url: s.url };
    } catch (err) {
      debugLog("session.html failed", err);
      return { html: "", url: s.url };
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
      s.recorder.detach();
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

/** Path + a bounded query string — a full analytics URL is 400 chars of noise. */
function shortUrl(url: string): string {
  try {
    const u = new URL(url);
    const q = u.search.length > 48 ? u.search.slice(0, 47) + "…" : u.search;
    return u.pathname + q;
  } catch {
    return url.slice(0, 80);
  }
}
