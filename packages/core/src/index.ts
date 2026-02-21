export type { BehaviorNode, BehaviorGraph } from "./graph/model.js";
export { serializeCompactText, serializeJGF } from "./graph/serializer.js";

import { launchBrowser, type BrowserHandle } from "./browser/launcher.js";
import { connectToPage, type PageHandle } from "./browser/page.js";
import { buildGraphFromAXTree } from "./pipeline/stage-1-axtree.js";
import type { BehaviorGraph } from "./graph/model.js";
import { serializeCompactText, serializeJGF } from "./graph/serializer.js";

export class VeilPage {
  private page: PageHandle;
  private url: string;

  constructor(page: PageHandle, url: string) {
    this.page = page;
    this.url = url;
  }

  async getGraph(): Promise<BehaviorGraph> {
    const [axNodes, title] = await Promise.all([
      this.page.getAXTree(),
      this.page.getTitle(),
    ]);
    return buildGraphFromAXTree(axNodes, this.url, title);
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
