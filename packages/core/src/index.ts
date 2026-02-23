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
} from "./graph/model.js";
export { VeilError } from "./graph/model.js";
export { serializeCompactText, serializeJGF } from "./graph/serializer.js";
export { buildDisplayIdRegistry, type DisplayIdRegistry } from "./graph/display-ids.js";
export { queryNodes } from "./graph/query.js";

import { launchBrowser, type BrowserHandle } from "./browser/launcher.js";
import { connectToPage, type PageHandle } from "./browser/page.js";
import { waitForNetworkIdle } from "./browser/page.js";
import { buildGraphFromAXTree } from "./pipeline/stage-1-axtree.js";
import { enrichGraphWithEvents } from "./pipeline/stage-2-events.js";
import { correlateNetwork } from "./pipeline/stage-3-network.js";
import { dispatchInteraction } from "./browser/interactions.js";
import { buildDisplayIdRegistry } from "./graph/display-ids.js";
import { queryNodes } from "./graph/query.js";
import type { BehaviorGraph, BehaviorNode, InteractAction, NodeFilter } from "./graph/model.js";
import { VeilError } from "./graph/model.js";
import { serializeCompactText, serializeJGF } from "./graph/serializer.js";

export class VeilPage {
  private page: PageHandle;
  private url: string;
  private cachedGraph: BehaviorGraph | null = null;

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
    await enrichGraphWithEvents(graph, this.page.cdp);
    const capturedRequests = this.page.getCapturedRequests();
    correlateNetwork(graph, capturedRequests);
    this.cachedGraph = graph;
    return graph;
  }

  async interact(nodeId: string, action: InteractAction): Promise<BehaviorGraph> {
    const graph = await this.getGraph();
    const node = this.resolveNode(graph, nodeId);

    if (!node) {
      throw new VeilError("NODE_NOT_FOUND", `Node "${nodeId}" not found in graph`);
    }

    // Start capturing network before interaction
    await this.page.startNetworkCapture();

    // Dispatch the interaction via CDP
    await dispatchInteraction(this.page.cdp, node.backendDOMNodeId, action);

    // Wait for network idle + DOM settle
    await waitForNetworkIdle(this.page.cdp);
    await sleep(100);

    // Update URL (may have navigated)
    this.url = await this.page.getCurrentUrl();

    // Invalidate cache and re-run pipeline
    this.cachedGraph = null;
    return this.getGraph();
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
    this.page.close();
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
