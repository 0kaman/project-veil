// Auth types
export type { AuthOptions, AuthResult } from "./browser/auth.js";

// Core classes
export type {
  BehaviorNode,
  BehaviorGraph,
  EventBinding,
  NetworkEdge,
  NetworkRequest,
  CallFrame,
  InteractAction,
  NodeFilter,
  VeilErrorCode,
  GraphDiff,
  GraphChangeCallback,
  ApiEndpoint,
  ComponentGroup,
  SemanticLabel,
  CapturedRequest,
} from "./graph/model.js";
export { VeilError } from "./graph/model.js";
export { serializeCompactText, serializeJGF } from "./graph/serializer.js";
export { buildDisplayIdRegistry, type DisplayIdRegistry } from "./graph/display-ids.js";
export { queryNodes } from "./graph/query.js";
export { SessionPool, type SessionInfo, type SessionPoolOptions } from "./session-pool.js";
export { buildApiEndpoints } from "./pipeline/api-endpoints.js";
export { groupComponents } from "./pipeline/stage-4-components.js";
export { inferSemantics } from "./pipeline/stage-5-semantics.js";
export { pruneToNodeBudget, MAX_NODES } from "./pipeline/prune.js";
export { buildCapturedRequests } from "./pipeline/capture.js";
export {
  type SemanticEnricher,
  type EnrichCandidate,
  type EnricherResult,
  OpenAICompatEnricher,
} from "./pipeline/enricher.js";

import { launchBrowser, type BrowserHandle } from "./browser/launcher.js";
import { connectToPage, type PageHandle } from "./browser/page.js";
import { awaitQuiescence, waitForSettleOrNavigation } from "./browser/page.js";
import { performAuthFlow, type AuthOptions, type AuthResult } from "./browser/auth.js";
import type { CDPClient } from "./browser/cdp-client.js";
import { buildGraphFromAXTree, patchGraphFromDiff, enrichStructuralEvents } from "./pipeline/stage-1-axtree.js";
import { enrichGraphWithEvents, enrichSpecificNodesWithEvents } from "./pipeline/stage-2-events.js";
import { correlateNetwork } from "./pipeline/stage-3-network.js";
import { buildSnapshot, diffSnapshots, type DiffableSnapshot } from "./graph/differ.js";
import { MutationWatcher } from "./browser/mutation-watcher.js";
import { dispatchInteraction } from "./browser/interactions.js";
import { buildDisplayIdRegistry } from "./graph/display-ids.js";
import { queryNodes } from "./graph/query.js";
import type { BehaviorGraph, BehaviorNode, InteractAction, NodeFilter, GraphDiff, GraphChangeCallback, CapturedRequest } from "./graph/model.js";
import { VeilError } from "./graph/model.js";
import { serializeCompactText, serializeJGF } from "./graph/serializer.js";
import { groupComponents, regroupComponents } from "./pipeline/stage-4-components.js";
import { inferSemantics, reinferSemantics } from "./pipeline/stage-5-semantics.js";
import { pruneToNodeBudget } from "./pipeline/prune.js";
import { buildCapturedRequests, indexByNode } from "./pipeline/capture.js";
import type { SemanticEnricher } from "./pipeline/enricher.js";

export class VeilPage {
  private page: PageHandle;
  private url: string;
  private cachedGraph: BehaviorGraph | null = null;
  private lastSnapshot: DiffableSnapshot | null = null;
  private graphBuildPromise: Promise<BehaviorGraph> | null = null;
  private mutationWatcher: MutationWatcher | null = null;
  private changeListeners: Set<GraphChangeCallback> = new Set();
  private graphVersion = 0;
  private updateInProgress = false;
  private pendingUpdate = false;

  // Replay cache: node id → the full requests its interaction fired. Populated
  // from network correlation; the foundation of the direct-API fast path.
  private capturedRequests = new Map<string, CapturedRequest[]>();

  private enricher?: SemanticEnricher;

  constructor(page: PageHandle, url: string, enricher?: SemanticEnricher) {
    this.page = page;
    this.url = url;
    this.enricher = enricher;
  }

  /** Public entry — deduplicates concurrent calls via shared promise. */
  async getGraph(): Promise<BehaviorGraph> {
    if (this.cachedGraph) return this.cachedGraph;
    if (this.graphBuildPromise) return this.graphBuildPromise;

    this.graphBuildPromise = this.buildGraph();
    try {
      return await this.graphBuildPromise;
    } finally {
      this.graphBuildPromise = null;
    }
  }

  /** Full pipeline build — only called from getGraph(). */
  private async buildGraph(): Promise<BehaviorGraph> {
    const [axNodes, title] = await Promise.all([
      this.page.getAXTree(),
      this.page.getTitle(),
    ]);
    const graph = buildGraphFromAXTree(axNodes, this.url, title);
    this.graphVersion++;
    graph.version = this.graphVersion;

    await enrichGraphWithEvents(graph, this.page.cdp);
    // Structural enrichment for server-rendered pages: synthesize click/submit
    // events from href/action on link/form nodes Stage 2 left event-less.
    await enrichStructuralEvents(graph, this.page.cdp);
    // Let in-flight response-body fetches land before we read shapes.
    await this.page.settleNetwork();
    const capturedRequests = this.page.getCapturedRequests();
    correlateNetwork(graph, capturedRequests);
    // Record replayable request templates (full method/url/headers/body), keyed
    // by the node that fired them — a fresh cache per full build.
    this.capturedRequests = indexByNode(buildCapturedRequests(graph, capturedRequests));

    // drain() detaches CDP listeners — restart so future requests are captured
    await this.page.startNetworkCapture();

    // Stage 4: Component grouping
    await groupComponents(graph, this.page.cdp);

    // Stage 5: Semantic inference
    await inferSemantics(graph, this.enricher);

    // Bound the graph on content-dense pages — drop low-value bulk links AFTER
    // events/semantics are known so behavioral nodes are never the ones cut.
    pruneToNodeBudget(graph);

    this.cachedGraph = graph;

    // Store snapshot for future diffing
    this.lastSnapshot = buildSnapshot(axNodes);

    // Start mutation watcher after first build
    this.startMutationWatcher();

    return graph;
  }

  async interact(nodeId: string, action: InteractAction): Promise<BehaviorGraph> {
    const graph = await this.getGraph();
    const node = this.resolveNode(graph, nodeId);

    if (!node) {
      throw new VeilError("NODE_NOT_FOUND", `Node "${nodeId}" not found in graph`);
    }

    const prevUrl = this.url;
    const prevNodeIds = new Set(graph.nodes.keys());

    // Suppress mutation watcher — interact() owns the update cycle
    this.mutationWatcher?.suppress();

    // Navigation detector — top-frame only. Subframe (iframe) navigations
    // are common on real pages (ad networks, OAuth popups, tracking pixels)
    // and must not trigger a full-page rebuild.
    let navigated = false;
    const onNav = (params: unknown) => {
      const frame = (params as { frame?: { parentId?: string } })?.frame;
      if (frame?.parentId) return;
      navigated = true;
    };
    this.page.cdp.on("Page.frameNavigated", onNav);
    // SPA route changes (history.pushState) fire navigatedWithinDocument, NOT
    // frameNavigated — and loadEventFired never follows. Track them separately
    // so the full-navigation branch (with its load-event wait) is never taken
    // for an in-document route change.
    let softNavigated = false;
    const onSoftNav = () => {
      softNavigated = true;
    };
    this.page.cdp.on("Page.navigatedWithinDocument", onSoftNav);

    try {
      // Dispatch the interaction via CDP
      await dispatchInteraction(this.page.cdp, node.backendDOMNodeId, action);

      // Navigation-aware settle: wait for network idle OR top-level
      // frameNavigated, whichever comes first. Form POSTs with 302 redirects
      // fire frameNavigated after the POST completes but before the new
      // page finishes loading — we must not wait the full idle timeout.
      await waitForSettleOrNavigation(this.page.cdp);

      // Double-check: a URL change without frameNavigated is a SOFT (SPA)
      // navigation — it must not enter the hard-navigation branch, whose
      // loadEventFired wait would stall the full 10s grace timer.
      if (!navigated && !softNavigated) {
        const currentUrl = await this.page.getCurrentUrl();
        if (currentUrl !== prevUrl) {
          softNavigated = true;
        }
      }

      if (navigated) {
        // Full-page navigation: wait for the new page to fully load
        await new Promise<void>((resolve) => {
          // loadEventFired may have already fired — check with a short
          // grace period, then listen for it
          const handler = () => {
            this.page.cdp.off("Page.loadEventFired", handler);
            clearTimeout(timer);
            resolve();
          };
          const timer = setTimeout(() => {
            this.page.cdp.off("Page.loadEventFired", handler);
            resolve();
          }, 10_000);
          this.page.cdp.on("Page.loadEventFired", handler);
        });

        // New page settle
        await awaitQuiescence(this.page.cdp);

        // Re-enable DOM tracking for new document
        await this.page.cdp.send("DOM.getDocument", { depth: -1 });

        // Update URL + full rebuild
        this.url = await this.page.getCurrentUrl();
        this.cachedGraph = null;
        this.lastSnapshot = null;
        this.graphBuildPromise = null;
        const newGraph = await this.getGraph();
        this.notifyRebuild(prevNodeIds, newGraph);
        return newGraph;
      }

      if (softNavigated) {
        // SPA route change: the document never unloads, so there is no load
        // event to wait for — settle the network and rebuild the graph (a new
        // route is a new virtual page).
        await awaitQuiescence(this.page.cdp);
        this.url = await this.page.getCurrentUrl();
        this.cachedGraph = null;
        this.lastSnapshot = null;
        this.graphBuildPromise = null;
        const newGraph = await this.getGraph();
        this.notifyRebuild(prevNodeIds, newGraph);
        return newGraph;
      }

      // Non-navigation path
      this.url = await this.page.getCurrentUrl();

      // Try incremental update first
      try {
        const updated = await this.incrementalUpdate();
        if (updated) return this.cachedGraph!;
      } catch {
        // Incremental failed — fall through to full rebuild
      }

      // Fallback: full rebuild + notify listeners
      this.cachedGraph = null;
      this.lastSnapshot = null;
      this.graphBuildPromise = null;
      const newGraph = await this.getGraph();
      this.notifyRebuild(prevNodeIds, newGraph);
      return newGraph;
    } finally {
      this.page.cdp.off("Page.frameNavigated", onNav);
      this.page.cdp.off("Page.navigatedWithinDocument", onSoftNav);
      this.mutationWatcher?.unsuppress();
    }
  }

  onGraphChange(callback: GraphChangeCallback): () => void {
    this.changeListeners.add(callback);
    return () => {
      this.changeListeners.delete(callback);
    };
  }

  waitForGraphUpdate(timeoutMs = 30_000): Promise<BehaviorGraph> {
    return new Promise<BehaviorGraph>((resolve, reject) => {
      const timer = setTimeout(() => {
        unsubscribe();
        reject(new Error("waitForGraphUpdate timed out"));
      }, timeoutMs);

      const unsubscribe = this.onGraphChange((graph) => {
        clearTimeout(timer);
        unsubscribe();
        resolve(graph);
      });
    });
  }

  async query(filter: NodeFilter): Promise<BehaviorNode[]> {
    const graph = await this.getGraph();
    return queryNodes(graph, filter);
  }

  async getNode(nodeId: string): Promise<BehaviorNode | undefined> {
    const graph = await this.getGraph();
    return this.resolveNode(graph, nodeId);
  }

  /** The replayable request template(s) a node's interaction fired, if we've
   * observed them (accepts internal AX id or display id). The raw material for
   * the direct-API fast path: replay these with edited fields instead of
   * re-clicking. Empty until an interaction (or prior load) reveals the request. */
  async capturedRequestsFor(nodeId: string): Promise<CapturedRequest[]> {
    const graph = await this.getGraph();
    const node = this.resolveNode(graph, nodeId);
    return node ? this.capturedRequests.get(node.id) ?? [] : [];
  }

  /** Every replayable request template captured this session. */
  allCapturedRequests(): CapturedRequest[] {
    return [...this.capturedRequests.values()].flat();
  }

  async toCompactText(): Promise<string> {
    const graph = await this.getGraph();
    return serializeCompactText(graph);
  }

  async toJSON(): Promise<Record<string, unknown>> {
    const graph = await this.getGraph();
    return serializeJGF(graph);
  }

  /** @internal — expose CDP client for auth flow */
  getCdp(): CDPClient {
    return this.page.cdp;
  }

  async getCurrentUrl(): Promise<string> {
    return this.page.getCurrentUrl();
  }

  invalidateCache(): void {
    this.cachedGraph = null;
    this.lastSnapshot = null;
    this.graphBuildPromise = null;
  }

  close(): void {
    if (this.mutationWatcher) {
      this.mutationWatcher.stop();
      this.mutationWatcher = null;
    }
    this.page.close();
  }

  private startMutationWatcher(): void {
    if (this.mutationWatcher) return;

    this.mutationWatcher = new MutationWatcher(
      this.page.cdp,
      (reason) => {
        if (reason === "navigation") {
          // Full-page navigation — rebuild graph for new page
          const prevNodeIds = this.cachedGraph
            ? new Set(this.cachedGraph.nodes.keys())
            : new Set<string>();
          this.cachedGraph = null;
          this.lastSnapshot = null;

          // Wait for new page to settle, re-enable DOM tracking, rebuild + notify
          awaitQuiescence(this.page.cdp)
            .then(() => this.page.cdp.send("DOM.getDocument", { depth: -1 }))
            .then(() => this.getGraph())
            .then((newGraph) => this.notifyRebuild(prevNodeIds, newGraph))
            .catch(() => {
              // Rebuild failed — invalidate cache so next getGraph() retries
              this.cachedGraph = null;
              this.lastSnapshot = null;
              this.graphBuildPromise = null;
            });
          return;
        }
        // Debounced mutation or poll — run incremental update
        this.scheduleIncrementalUpdate();
      },
    );

    this.mutationWatcher.start().catch(() => {
      // Mutation watcher failed to start — non-fatal, incremental updates
      // will still work via interact() and explicit getGraph() calls
    });
  }

  private scheduleIncrementalUpdate(): void {
    if (this.updateInProgress) {
      this.pendingUpdate = true;
      return;
    }

    this.incrementalUpdate().catch(() => {
      // Incremental update failed — null the cache so next getGraph() does full rebuild
      this.cachedGraph = null;
      this.lastSnapshot = null;
    });
  }

  private async incrementalUpdate(): Promise<boolean> {
    if (!this.cachedGraph || !this.lastSnapshot) return false;

    if (this.updateInProgress) {
      this.pendingUpdate = true;
      return false;
    }

    this.updateInProgress = true;
    this.pendingUpdate = false;

    try {
      // 1. Fetch fresh AXTree + metadata
      const [axNodes, title, currentUrl] = await Promise.all([
        this.page.getAXTree(),
        this.page.getTitle(),
        this.page.getCurrentUrl(),
      ]);
      this.url = currentUrl;

      // 2. Build new snapshot and diff
      const newSnapshot = buildSnapshot(axNodes);
      const diff = diffSnapshots(this.lastSnapshot, newSnapshot);

      // 3. No changes — return early
      if (diff.added.length === 0 && diff.removed.length === 0 && diff.modified.length === 0) {
        return false;
      }

      // 4. Patch graph — Stage 1 incremental. Bump the single monotonic version
      // counter (never the graph field directly — that let version regress when
      // a later full rebuild reset it below the incrementally-advanced value).
      patchGraphFromDiff(this.cachedGraph, axNodes, diff, this.url, title);
      this.graphVersion++;
      this.cachedGraph.version = this.graphVersion;

      // 5. Selective event enrichment — Stage 2 on added ∪ modified
      const changedNodeIds = new Set([...diff.added, ...diff.modified]);
      if (changedNodeIds.size > 0) {
        await enrichSpecificNodesWithEvents(this.cachedGraph, this.page.cdp, changedNodeIds);
        // Structural enrichment for any changed link/form left event-less
        await enrichStructuralEvents(this.cachedGraph, this.page.cdp, changedNodeIds);
      }

      // 6. Correlate new network requests — Stage 3 incremental
      await this.page.settleNetwork();
      const newRequests = this.page.getNewCapturedRequests();
      if (newRequests.length > 0) {
        correlateNetwork(this.cachedGraph, newRequests);
        // Merge any newly-observed replayable requests into the cache — this is
        // how an interaction TEACHES us its request the first time it fires.
        for (const [nodeId, reqs] of indexByNode(
          buildCapturedRequests(this.cachedGraph, newRequests),
        )) {
          const existing = this.capturedRequests.get(nodeId);
          if (existing) existing.push(...reqs);
          else this.capturedRequests.set(nodeId, reqs);
        }
      }

      // 7. Remove stale networkEdges for removed nodes
      if (diff.removed.length > 0) {
        const removedSet = new Set(diff.removed);
        this.cachedGraph.networkEdges = this.cachedGraph.networkEdges.filter(
          (e) => !removedSet.has(e.triggerNodeId),
        );
      }

      // 8. Re-group components (Stage 4 incremental)
      await regroupComponents(this.cachedGraph, this.page.cdp, changedNodeIds);

      // 9. Re-infer semantics (Stage 5 heuristics only — preserves LLM labels)
      reinferSemantics(this.cachedGraph);

      // 10. Update snapshot, notify listeners
      this.lastSnapshot = newSnapshot;

      for (const listener of this.changeListeners) {
        try {
          listener(this.cachedGraph, diff);
        } catch {
          // Listener error — don't break the update loop
        }
      }

      return true;
    } catch (err) {
      // On failure: null the cache, next getGraph() does full rebuild
      this.cachedGraph = null;
      this.lastSnapshot = null;
      throw err;
    } finally {
      this.updateInProgress = false;

      // If another update was requested while we were running, schedule it
      if (this.pendingUpdate) {
        this.pendingUpdate = false;
        this.scheduleIncrementalUpdate();
      }
    }
  }

  private notifyRebuild(prevNodeIds: Set<string>, newGraph: BehaviorGraph): void {
    const newNodeIds = new Set(newGraph.nodes.keys());
    const diff: GraphDiff = {
      added: [...newNodeIds].filter((id) => !prevNodeIds.has(id)),
      removed: [...prevNodeIds].filter((id) => !newNodeIds.has(id)),
      modified: [...newNodeIds].filter((id) => prevNodeIds.has(id)),
    };

    if (diff.added.length === 0 && diff.removed.length === 0 && diff.modified.length === 0) return;

    for (const listener of this.changeListeners) {
      try {
        listener(newGraph, diff);
      } catch {
        // Don't break the notification loop
      }
    }
  }

  private resolveNode(graph: BehaviorGraph, nodeId: string): BehaviorNode | undefined {
    // Try direct internal AX ID first
    const direct = graph.nodes.get(nodeId);
    if (direct) return direct;

    // Try display ID lookup
    const registry = buildDisplayIdRegistry(graph);
    const internalId = registry.toInternal.get(nodeId);
    if (internalId) return graph.nodes.get(internalId);

    return undefined;
  }
}

export interface VeilOptions {
  /** Pluggable LLM semantic enricher. Also configurable via VEIL_ENRICH_BASE_URL. */
  enricher?: SemanticEnricher;
}

export class Veil {
  private browser: BrowserHandle | null = null;
  private launchPromise: Promise<BrowserHandle> | null = null;
  private enricher?: SemanticEnricher;

  constructor(options?: VeilOptions) {
    this.enricher = options?.enricher;
  }

  /** Launch (or reuse) the single shared browser. Guarded by an in-flight
   * promise so two concurrent open() calls — common under the daemon, whose
   * dispatch is fully async — can never spawn two Chrome processes and orphan
   * one. */
  private async ensureBrowser(): Promise<BrowserHandle> {
    if (this.browser) return this.browser;
    if (!this.launchPromise) {
      this.launchPromise = launchBrowser()
        .then((b) => {
          this.browser = b;
          return b;
        })
        .finally(() => {
          this.launchPromise = null;
        });
    }
    return this.launchPromise;
  }

  async open(url: string): Promise<VeilPage> {
    const browser = await this.ensureBrowser();
    // freshTarget: each open() gets its own tab so concurrent sessions can't
    // hijack each other's page.
    const page = await connectToPage(browser.port, undefined, true);
    await page.navigate(url);
    return new VeilPage(page, url, this.enricher);
  }

  async auth(page: VeilPage, options?: AuthOptions): Promise<AuthResult> {
    const cdp = page.getCdp();
    const currentUrl = await page.getCurrentUrl();
    const result = await performAuthFlow(cdp, currentUrl, options);
    if (result.success) {
      await cdp.send("Page.reload");
      // Wait for page to load
      await new Promise<void>((resolve) => {
        const handler = () => {
          cdp.off("Page.loadEventFired", handler);
          clearTimeout(timer);
          resolve();
        };
        const timer = setTimeout(() => {
          cdp.off("Page.loadEventFired", handler);
          resolve();
        }, 10_000);
        cdp.on("Page.loadEventFired", handler);
      });
      await awaitQuiescence(cdp);
      page.invalidateCache();
      await page.getGraph(); // rebuild
    }
    return result;
  }

  async close(): Promise<void> {
    if (this.browser) {
      await this.browser.close();
      this.browser = null;
    }
  }
}

