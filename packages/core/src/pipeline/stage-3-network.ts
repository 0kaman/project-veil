import type {
  BehaviorGraph,
  CallFrame,
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
  // Two-level handler index. Real production bundles compile every handler
  // to a small set of lines (often just bundle.js:1), so a flat "first-wins"
  // line index attributes every network request to whichever handler was
  // indexed first. We keep ALL candidates per (url, line) and rank below.
  const exactIndex = new Map<string, Candidate>();
  const lineIndex = new Map<string, Candidate[]>();

  for (const [nodeId, node] of graph.nodes) {
    for (const event of node.events) {
      if (!event.source) continue;
      const cand: Candidate = {
        nodeId,
        eventType: event.eventType,
        scriptUrl: event.source.scriptUrl,
        lineNumber: event.source.lineNumber,
        columnNumber: event.source.columnNumber,
      };
      const lineKey = `${cand.scriptUrl}:${cand.lineNumber}`;
      // Only register in exactIndex when col is a real signal (>0). col=0
      // is the fallback Stage 2 emits when CDP's [[FunctionLocation]] doesn't
      // expose a column (bound functions, optimized-out source maps, certain
      // V8 paths). Treating col=0 as "exact" causes collisions: many handlers
      // → "url:line:0" → Map.set last-wins → arbitrary handler wins every
      // stack frame that also happens to have col=0. Fall through to the
      // line-ranking path instead.
      if (cand.columnNumber > 0) {
        const exactKey = `${cand.scriptUrl}:${cand.lineNumber}:${cand.columnNumber}`;
        exactIndex.set(exactKey, cand);
      }
      const list = lineIndex.get(lineKey);
      if (list) list.push(cand);
      else lineIndex.set(lineKey, [cand]);
    }
  }

  for (const req of capturedRequests) {
    const reqPath = extractPath(req.url);
    let handler: Candidate | undefined;

    // Parser/other initiators have no useful stack — skip the lookup loop
    // and fall through to the unmatched emit below.
    if (req.initiatorType === "script" && req.initiatorStack) {
      handler = pickHandler(req.initiatorStack, exactIndex, lineIndex);
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

      const node = graph.nodes.get(handler.nodeId);
      if (node) {
        const event = node.events.find((e) => e.eventType === handler!.eventType);
        if (event) event.estimatedEffect = `${req.method} ${reqPath}`;
      }
    }

    // Emit unmatched edge. triggerEvent reflects initiator type so consumers
    // can distinguish "script that we couldn't attribute" from "parser/other".
    if (!handler) {
      graph.networkEdges.push({
        triggerNodeId: "",
        triggerEvent: req.initiatorType,
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

interface Candidate {
  nodeId: string;
  eventType: string;
  scriptUrl: string;
  lineNumber: number;
  columnNumber: number;
}

/**
 * Pick the best handler candidate for a given initiator stack.
 *
 * Strategy:
 *   1. Walk every non-framework stack frame. If any frame matches a candidate
 *      EXACTLY on (url, line, col), return it. This is the precise path —
 *      Stage 2's introspection found the call site and the request initiator
 *      tracked it back to the same location.
 *   2. If no exact hit, gather all line-only candidates across all frames
 *      and rank them by stack-URL frequency: a candidate whose scriptUrl
 *      appears in MORE frames of the initiator stack is more likely to be
 *      the real trigger (component-locality heuristic). This is what makes
 *      the difference on minified bundles where many handlers share line 1
 *      and column data is unreliable.
 *   3. Stable tiebreak: lower nodeId wins. Eliminates the previous
 *      first-wins behavior that depended on Map insertion order.
 */
function pickHandler(
  stack: CallFrame[],
  exactIndex: Map<string, Candidate>,
  lineIndex: Map<string, Candidate[]>,
): Candidate | undefined {
  const usefulFrames = stack.filter((f) => f.url && !isFrameworkFrame(f.url));
  if (usefulFrames.length === 0) return undefined;

  // 1. Exact (line, col) match — highest precedence.
  for (const frame of usefulFrames) {
    const exactKey = `${frame.url}:${frame.lineNumber}:${frame.columnNumber}`;
    const hit = exactIndex.get(exactKey);
    if (hit) return hit;
  }

  // 2. Collect every line-only candidate referenced by any frame, deduped.
  const seen = new Set<string>();
  const candidates: Candidate[] = [];
  for (const frame of usefulFrames) {
    const lineKey = `${frame.url}:${frame.lineNumber}`;
    const list = lineIndex.get(lineKey);
    if (!list) continue;
    for (const c of list) {
      const id = `${c.nodeId}\0${c.eventType}`;
      if (seen.has(id)) continue;
      seen.add(id);
      candidates.push(c);
    }
  }
  if (candidates.length === 0) return undefined;
  if (candidates.length === 1) return candidates[0];

  // 3. Rank by stack-URL frequency, then by stable nodeId.
  const stackUrlCounts = new Map<string, number>();
  for (const frame of usefulFrames) {
    stackUrlCounts.set(frame.url, (stackUrlCounts.get(frame.url) ?? 0) + 1);
  }
  candidates.sort((a, b) => {
    const aScore = stackUrlCounts.get(a.scriptUrl) ?? 0;
    const bScore = stackUrlCounts.get(b.scriptUrl) ?? 0;
    if (aScore !== bScore) return bScore - aScore; // higher score first
    if (a.nodeId < b.nodeId) return -1;
    if (a.nodeId > b.nodeId) return 1;
    return 0;
  });
  return candidates[0];
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
