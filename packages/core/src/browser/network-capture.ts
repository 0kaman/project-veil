import type { CDPClient } from "./cdp-client.js";
import type { CallFrame, NetworkRequest } from "../graph/model.js";

interface CDPCallFrame {
  scriptId: string;
  url: string;
  functionName: string;
  lineNumber: number;
  columnNumber: number;
}

interface CDPStackTrace {
  callFrames: CDPCallFrame[];
  parent?: CDPStackTrace;
  parentId?: { id: string };
}

interface CDPRequestWillBeSent {
  requestId: string;
  request: { url: string; method: string };
  initiator: {
    type: string;
    stack?: CDPStackTrace;
  };
  timestamp: number;
  type?: string; // resource type: XHR, Fetch, Document, etc.
}

interface CDPResponseReceived {
  requestId: string;
  response: {
    status: number;
    mimeType: string;
  };
}

const SKIP_URL_PREFIXES = ["data:", "chrome-extension:", "chrome://"];
const CAPTURE_RESOURCE_TYPES = new Set(["XHR", "Fetch", "Document"]);

// Static resource extensions — not behavioral signals
const RESOURCE_EXTENSIONS = /\.(js|mjs|css|woff2?|ttf|eot|otf|png|jpe?g|gif|svg|ico|webp|avif|mp[34]|webm|ogg|wav|map)(\?|$)/i;

// Response MIME types that indicate static resources, not API responses
const RESOURCE_MIME_TYPES = [
  "text/javascript",
  "application/javascript",
  "text/css",
  "font/",
  "image/",
  "audio/",
  "video/",
];

interface PendingRequest {
  requestId: string;
  method: string;
  url: string;
  initiatorType: "script" | "parser" | "other";
  initiatorStack?: CallFrame[];
  timestamp: number;
}

export class NetworkCapture {
  private cdp: CDPClient;
  private pending = new Map<string, PendingRequest>();
  private completed: NetworkRequest[] = [];
  private onRequest: ((params: unknown) => void) | null = null;
  private onResponse: ((params: unknown) => void) | null = null;

  constructor(cdp: CDPClient) {
    this.cdp = cdp;
  }

  async start(): Promise<void> {
    this.pending.clear();
    this.completed = [];

    await this.cdp.send("Debugger.setAsyncCallStackDepth", { maxDepth: 32 });

    this.onRequest = (params: unknown) => {
      const p = params as CDPRequestWillBeSent;

      // Filter by resource type when available
      if (p.type && !CAPTURE_RESOURCE_TYPES.has(p.type)) return;

      // Skip non-HTTP URLs
      if (SKIP_URL_PREFIXES.some((prefix) => p.request.url.startsWith(prefix))) return;

      // Skip static resource URLs (JS bundles, CSS, fonts, images)
      try {
        const pathname = new URL(p.request.url).pathname;
        if (RESOURCE_EXTENSIONS.test(pathname)) return;
      } catch {
        // malformed URL — let it through, drain filter will catch it
      }

      const initiatorType =
        p.initiator.type === "script"
          ? "script"
          : p.initiator.type === "parser"
            ? "parser"
            : "other";

      this.pending.set(p.requestId, {
        requestId: p.requestId,
        method: p.request.method,
        url: p.request.url,
        initiatorType,
        initiatorStack: p.initiator.stack
          ? flattenStack(p.initiator.stack)
          : undefined,
        timestamp: p.timestamp,
      });
    };

    this.onResponse = (params: unknown) => {
      const p = params as CDPResponseReceived;
      const req = this.pending.get(p.requestId);
      if (!req) return;

      this.pending.delete(p.requestId);
      this.completed.push({
        ...req,
        responseStatus: p.response.status,
        responseContentType: p.response.mimeType,
      });
    };

    this.cdp.on("Network.requestWillBeSent", this.onRequest);
    this.cdp.on("Network.responseReceived", this.onResponse);
  }

  drain(): NetworkRequest[] {
    // Detach listeners
    if (this.onRequest) {
      this.cdp.off("Network.requestWillBeSent", this.onRequest);
      this.onRequest = null;
    }
    if (this.onResponse) {
      this.cdp.off("Network.responseReceived", this.onResponse);
      this.onResponse = null;
    }

    // Move any still-pending requests (no response yet) to completed without response info
    for (const req of this.pending.values()) {
      this.completed.push({ ...req });
    }
    this.pending.clear();

    const result = this.completed.filter((req) => {
      // Drop responses with static resource MIME types
      if (req.responseContentType) {
        const mime = req.responseContentType;
        if (RESOURCE_MIME_TYPES.some((prefix) => mime.startsWith(prefix))) return false;
      }
      return true;
    });
    this.completed = [];
    return result;
  }
}

function flattenStack(stack: CDPStackTrace): CallFrame[] {
  const frames: CallFrame[] = [];
  let current: CDPStackTrace | undefined = stack;

  while (current) {
    for (const f of current.callFrames) {
      frames.push({
        scriptId: f.scriptId,
        url: f.url,
        functionName: f.functionName,
        lineNumber: f.lineNumber,
        columnNumber: f.columnNumber,
      });
    }
    current = current.parent;
  }

  return frames;
}
