import type {
  BehaviorGraph,
  NetworkRequest,
} from "../graph/model.js";
import { isFrameworkFrame, extractPath } from "./utils.js";
import { inferJsonShape, buildApiEndpoints } from "./api-endpoints.js";

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

  // --- Enrichment: body shapes + URL patterns + API endpoints ---

  // Build request index for body lookups: "METHOD:url" → NetworkRequest
  const requestIndex = new Map<string, NetworkRequest>();
  for (const req of capturedRequests) {
    requestIndex.set(`${req.method}:${req.url}`, req);
  }

  // Enrich edges with body shapes from captured requests
  for (const edge of graph.networkEdges) {
    const req = requestIndex.get(`${edge.request.method}:${edge.request.url}`);
    if (!req) continue;

    // Response body shape
    if (req.responseBody && edge.response) {
      const shape = inferJsonShape(req.responseBody);
      if (shape) {
        edge.response.bodyShape = shape;
      }
    }

    // Request body shape (attach to response metadata for simplicity)
    // Request shapes are collected during buildApiEndpoints below
  }

  // Build API endpoint catalog and set urlPatterns on edges
  graph.apiEndpoints = buildApiEndpoints(graph.networkEdges);

  // Back-fill urlPattern on edges from endpoint patterns
  const patternByMethodPrefix = new Map<string, string>();
  for (const ep of graph.apiEndpoints) {
    patternByMethodPrefix.set(`${ep.method}:${ep.pattern}`, ep.pattern);
  }
  for (const edge of graph.networkEdges) {
    // Find the endpoint whose pattern matches this edge
    for (const ep of graph.apiEndpoints) {
      if (ep.method !== edge.request.method) continue;
      // Check if this edge's URL belongs to this endpoint group
      try {
        const pathname = new URL(edge.request.url).pathname;
        if (pathMatchesPattern(pathname, ep.pattern)) {
          edge.urlPattern = ep.pattern;
          break;
        }
      } catch {
        // skip
      }
    }
  }

  // Enrich endpoints with request body shapes
  for (const ep of graph.apiEndpoints) {
    for (const req of capturedRequests) {
      if (req.method !== ep.method || !req.requestBody) continue;
      try {
        const pathname = new URL(req.url).pathname;
        if (pathMatchesPattern(pathname, ep.pattern)) {
          const shape = inferJsonShape(req.requestBody);
          if (shape) {
            ep.requestShape = shape;
            break; // first match is enough
          }
        }
      } catch {
        // skip
      }
    }
  }
}

/** Check if a concrete pathname matches a parameterized pattern. */
function pathMatchesPattern(pathname: string, pattern: string): boolean {
  // Strip query from pattern
  const patternPath = pattern.split("?")[0];
  const pathSegs = pathname.split("/").filter(Boolean);
  const patternSegs = patternPath.split("/").filter(Boolean);

  if (pathSegs.length !== patternSegs.length) return false;

  for (let i = 0; i < patternSegs.length; i++) {
    const ps = patternSegs[i];
    if (ps.startsWith("{") && ps.endsWith("}")) continue; // wildcard
    if (ps !== pathSegs[i]) return false;
  }
  return true;
}
