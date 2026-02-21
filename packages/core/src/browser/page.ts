import { createCDPClient, type CDPClient } from "./cdp-client.js";

export interface AXNode {
  nodeId: string;
  ignored: boolean;
  role?: { type: string; value: string };
  name?: { type: string; value: string };
  description?: { type: string; value: string };
  value?: { type: string; value: string };
  properties?: Array<{ name: string; value: { type: string; value: unknown } }>;
  parentId?: string;
  childIds?: string[];
  backendDOMNodeId?: number;
}

export interface PageHandle {
  cdp: CDPClient;
  navigate(url: string, timeoutMs?: number): Promise<void>;
  getAXTree(): Promise<AXNode[]>;
  getTitle(): Promise<string>;
  close(): void;
}

export async function connectToPage(
  port: number,
  targetUrl?: string,
): Promise<PageHandle> {
  const listResp = await fetch(`http://127.0.0.1:${port}/json`);
  const targets = (await listResp.json()) as Array<{
    type: string;
    webSocketDebuggerUrl: string;
    url: string;
  }>;

  let target = targets.find((t) => t.type === "page");
  if (!target) {
    // No page target yet — create one via /json/new
    const newResp = await fetch(`http://127.0.0.1:${port}/json/new`);
    target = (await newResp.json()) as {
      type: string;
      webSocketDebuggerUrl: string;
      url: string;
    };
  }
  if (!target?.webSocketDebuggerUrl) {
    throw new Error("No page target found and could not create one");
  }

  const cdp = await createCDPClient(target.webSocketDebuggerUrl);

  await Promise.all([
    cdp.send("Page.enable"),
    cdp.send("DOM.enable"),
    cdp.send("Accessibility.enable"),
    cdp.send("Runtime.enable"),
    cdp.send("Network.enable"),
    cdp.send("Debugger.enable"),
  ]);

  const navigate = async (url: string, timeoutMs = 30_000): Promise<void> => {
    const loadPromise = new Promise<void>((resolve) => {
      const handler = () => {
        cdp.off("Page.loadEventFired", handler);
        resolve();
      };
      cdp.on("Page.loadEventFired", handler);
    });

    await cdp.send("Page.navigate", { url });

    await Promise.race([
      loadPromise,
      new Promise<void>((_, reject) =>
        setTimeout(() => reject(new Error("Navigation timed out")), timeoutMs),
      ),
    ]);

    await waitForNetworkIdle(cdp);
  };

  const getAXTree = async (): Promise<AXNode[]> => {
    const result = (await cdp.send("Accessibility.getFullAXTree")) as {
      nodes: AXNode[];
    };
    return result.nodes;
  };

  const getTitle = async (): Promise<string> => {
    const result = (await cdp.send("Runtime.evaluate", {
      expression: "document.title",
      returnByValue: true,
    })) as { result: { value: string } };
    return result.result.value ?? "";
  };

  return {
    cdp,
    navigate,
    getAXTree,
    getTitle,
    close() {
      cdp.close();
    },
  };
}

async function waitForNetworkIdle(cdp: CDPClient): Promise<void> {
  let inflight = 0;
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  const IDLE_WAIT = 2_000;
  const HARD_CAP = 5_000;

  return new Promise<void>((resolve) => {
    const onRequest = () => {
      inflight++;
      if (idleTimer) {
        clearTimeout(idleTimer);
        idleTimer = undefined;
      }
    };

    const onDone = () => {
      inflight = Math.max(0, inflight - 1);
      if (inflight === 0 && !idleTimer) {
        idleTimer = setTimeout(cleanup, IDLE_WAIT);
      }
    };

    const cleanup = () => {
      cdp.off("Network.requestWillBeSent", onRequest);
      cdp.off("Network.loadingFinished", onDone);
      cdp.off("Network.loadingFailed", onDone);
      if (idleTimer) clearTimeout(idleTimer);
      if (hardCapTimer) clearTimeout(hardCapTimer);
      resolve();
    };

    cdp.on("Network.requestWillBeSent", onRequest);
    cdp.on("Network.loadingFinished", onDone);
    cdp.on("Network.loadingFailed", onDone);

    // Start idle timer immediately (page might already be idle)
    if (inflight === 0) {
      idleTimer = setTimeout(cleanup, IDLE_WAIT);
    }

    const hardCapTimer = setTimeout(cleanup, HARD_CAP);
  });
}
