import type {
  BehaviorGraph,
  NetworkRequest,
} from "../graph/model.js";
import { isFrameworkFrame, extractPath } from "./utils.js";

/**
 * Stage 3: Correlate captured network requests to handler source locations.
 *
 * Builds an index of handler source locations from Stage 2's EventBinding.source,
 * then walks each request's initiator stack to find a matching handler.
 */
export function correlateNetwork(
  graph: BehaviorGraph,
  capturedRequests: NetworkRequest[],
): void {
  // Build handler index: "url:line:col" → { nodeId, eventType }
  // Also build line-only index as fallback for minified code
  const exactIndex = new Map<string, { nodeId: string; eventType: string }>();
  const lineIndex = new Map<string, { nodeId: string; eventType: string }>();

  for (const [nodeId, node] of graph.nodes) {
    for (const event of node.events) {
      if (!event.source) continue;
      const exactKey = `${event.source.scriptUrl}:${event.source.lineNumber}:${event.source.columnNumber}`;
      const lineKey = `${event.source.scriptUrl}:${event.source.lineNumber}`;
      exactIndex.set(exactKey, { nodeId, eventType: event.eventType });
      // Only set line index if not already set (first wins)
      if (!lineIndex.has(lineKey)) {
        lineIndex.set(lineKey, { nodeId, eventType: event.eventType });
      }
    }
  }

  for (const req of capturedRequests) {
    // Only correlate script-initiated requests
    if (req.initiatorType !== "script") continue;

    const reqPath = extractPath(req.url);
    let matched = false;

    if (req.initiatorStack) {
      for (const frame of req.initiatorStack) {
        if (!frame.url || isFrameworkFrame(frame.url)) continue;

        // Try exact match first
        const exactKey = `${frame.url}:${frame.lineNumber}:${frame.columnNumber}`;
        let handler = exactIndex.get(exactKey);

        // Fallback to line-only match
        if (!handler) {
          const lineKey = `${frame.url}:${frame.lineNumber}`;
          handler = lineIndex.get(lineKey);
        }

        if (handler) {
          graph.networkEdges.push({
            triggerNodeId: handler.nodeId,
            triggerEvent: handler.eventType,
            request: { method: req.method, url: req.url },
            ...(req.responseStatus != null && {
              response: {
                status: req.responseStatus,
                contentType: req.responseContentType ?? "",
              },
            }),
          });

          // Set estimatedEffect on the matching event binding
          const node = graph.nodes.get(handler.nodeId);
          if (node) {
            const event = node.events.find(
              (e) => e.eventType === handler.eventType,
            );
            if (event) {
              event.estimatedEffect = `${req.method} ${reqPath}`;
            }
          }

          matched = true;
          break;
        }
      }
    }

    // Unmatched script-initiated request
    if (!matched) {
      graph.networkEdges.push({
        triggerNodeId: "",
        triggerEvent: "script",
        request: { method: req.method, url: req.url },
        ...(req.responseStatus != null && {
          response: {
            status: req.responseStatus,
            contentType: req.responseContentType ?? "",
          },
        }),
      });
    }
  }

  // Post-correlation feedback: promote unknown handlers that have estimatedEffect
  for (const [, node] of graph.nodes) {
    for (const event of node.events) {
      if (event.category === "unknown" && event.estimatedEffect) {
        event.category = "api_call";
      }
    }
  }
}
