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
} from "./graph/model.js";
export { VeilError } from "./graph/model.js";
export { serializeCompactText, serializeJGF } from "./graph/serializer.js";
export { buildDisplayIdRegistry, type DisplayIdRegistry } from "./graph/display-ids.js";
export { queryNodes } from "./graph/query.js";
export { buildApiEndpoints } from "./pipeline/api-endpoints.js";

import { launchBrowser, type BrowserHandle } from "./browser/launcher.js";
import { connectToPage, type PageHandle } from "./browser/page.js";
import { waitForNetworkIdle } from "./browser/page.js";
import { buildGraphFromAXTree, patchGraphFromDiff } from "./pipeline/stage-1-axtree.js";
import { enrichGraphWithEvents, enrichSpecificNodesWithEvents } from "./pipeline/stage-2-events.js";
import { correlateNetwork } from "./pipeline/stage-3-network.js";
import { buildSnapshot, diffSnapshots, type DiffableSnapshot } from "./graph/differ.js";
import { MutationWatcher } from "./browser/mutation-watcher.js";
import { dispatchInteraction } from "./browser/interactions.js";
import { buildDisplayIdRegistry } from "./graph/display-ids.js";
import { queryNodes } from "./graph/query.js";
import type { BehaviorGraph, BehaviorNode, InteractAction, NodeFilter, GraphDiff, GraphChangeCallback } from "./graph/model.js";
import { VeilError } from "./graph/model.js";
import { serializeCompactText, serializeJGF } from "./graph/serializer.js";

export class VeilPage {
  private page: PageHandle;
  private url: string;
  private cachedGraph: BehaviorGraph | null = null;
  private lastSnapshot: DiffableSnapshot | null = null;
  private mutationWatcher: MutationWatcher | null = null;
  private changeListeners: Set<GraphChangeCallback> = new Set();
  private graphVersion = 0;
  private updateInProgress = false;
  private pendingUpdate = false;

  constructor(page: PageHandle, url: string) {
    this.page = page;
    this.url = url;
  }

  async getGraph(): Promise<BehaviorGraph> {
    if (this.cachedGraph) return this.cachedGraph;

    const [axNodes, title] = await Promise.all([
      this.page.getAXTree(),
      this.page.getTitle(),
    ]);
    const graph = buildGraphFromAXTree(axNodes, this.url, title);
    this.graphVersion++;
    graph.version = this.graphVersion;

    await enrichGraphWithEvents(graph, this.page.cdp);
    const capturedRequests = this.page.getCapturedRequests();
    correlateNetwork(graph, capturedRequests);

    // drain() detaches CDP listeners — restart so future requests are captured
    await this.page.startNetworkCapture();

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

    // Dispatch the interaction via CDP
    await dispatchInteraction(this.page.cdp, node.backendDOMNodeId, action);

    // Wait for network idle + DOM settle
    await waitForNetworkIdle(this.page.cdp);
    await sleep(100);

    // Update URL (may have navigated)
    this.url = await this.page.getCurrentUrl();

    // Try incremental update first
    try {
      const updated = await this.incrementalUpdate();
      if (updated) return this.cachedGraph!;
    } catch {
      // Incremental failed — fall through to full rebuild
    }

    // Fallback: full rebuild
    this.cachedGraph = null;
    this.lastSnapshot = null;
    return this.getGraph();
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

  async toCompactText(): Promise<string> {
    const graph = await this.getGraph();
    return serializeCompactText(graph);
  }

  async toJSON(): Promise<Record<string, unknown>> {
    const graph = await this.getGraph();
    return serializeJGF(graph);
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
          // Full-page navigation — force full rebuild
          this.cachedGraph = null;
          this.lastSnapshot = null;
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

      // 4. Patch graph — Stage 1 incremental
      patchGraphFromDiff(this.cachedGraph, axNodes, diff, this.url, title);

      // 5. Selective event enrichment — Stage 2 on added ∪ modified
      const changedNodeIds = new Set([...diff.added, ...diff.modified]);
      if (changedNodeIds.size > 0) {
        await enrichSpecificNodesWithEvents(this.cachedGraph, this.page.cdp, changedNodeIds);
      }

      // 6. Correlate new network requests — Stage 3 incremental
      const newRequests = this.page.getNewCapturedRequests();
      if (newRequests.length > 0) {
        correlateNetwork(this.cachedGraph, newRequests);
      }

      // 7. Remove stale networkEdges for removed nodes
      if (diff.removed.length > 0) {
        const removedSet = new Set(diff.removed);
        this.cachedGraph.networkEdges = this.cachedGraph.networkEdges.filter(
          (e) => !removedSet.has(e.triggerNodeId),
        );
      }

      // 8. Update snapshot, notify listeners
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

export class Veil {
  private browser: BrowserHandle | null = null;

  async open(url: string): Promise<VeilPage> {
    if (!this.browser) {
      this.browser = await launchBrowser();
    }

    const page = await connectToPage(this.browser.port);
    await page.navigate(url);
    return new VeilPage(page, url);
  }

  async close(): Promise<void> {
    if (this.browser) {
      await this.browser.close();
      this.browser = null;
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
