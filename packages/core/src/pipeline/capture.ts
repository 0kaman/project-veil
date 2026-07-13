/**
 * Request capture — the foundation of the direct-API fast path.
 *
 * Stage 3 already correlates each network request to the node that triggered it.
 * This turns those correlated, API-shaped requests into REPLAYABLE templates:
 * the full method / url / headers / body an interaction fired, keyed by node.
 * Later, instead of re-simulating a click, we can replay the captured request
 * directly (with edited fields) — machine-native, no DOM round-trip.
 *
 * Kept OUT of the serialized behavior graph (it's a replay cache, not
 * perception); the graph only gets a `replayable` flag on the matching edge.
 */
import type { BehaviorGraph, NetworkRequest, CapturedRequest } from "../graph/model.js";

const MUTATING = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/** An API-shaped request worth replaying: an XHR/Fetch, a mutating method, or
 * anything carrying a body. Static documents/resources are excluded upstream. */
function isReplayable(req: NetworkRequest): boolean {
  return (
    req.resourceType === "XHR" ||
    req.resourceType === "Fetch" ||
    MUTATING.has(req.method) ||
    !!req.requestBody
  );
}

/**
 * Build replayable templates from the requests Stage 3 just correlated. Matches
 * each request to its already-correlated edge (same method+url, non-empty node)
 * and flips that edge's `replayable` flag. Returns one CapturedRequest per
 * matched request.
 */
export function buildCapturedRequests(
  graph: BehaviorGraph,
  requests: NetworkRequest[],
): CapturedRequest[] {
  const out: CapturedRequest[] = [];
  for (const req of requests) {
    if (!isReplayable(req)) continue;
    const edge = graph.networkEdges.find(
      (e) =>
        e.triggerNodeId &&
        e.request.method === req.method &&
        e.request.url === req.url,
    );
    if (!edge) continue; // uncorrelated (ambient/background) — not node-replayable
    edge.replayable = true;
    out.push({
      method: req.method,
      url: req.url,
      headers: req.requestHeaders ?? {},
      body: req.requestBody,
      resourceType: req.resourceType,
      triggerNodeId: edge.triggerNodeId,
      triggerEvent: edge.triggerEvent,
      timestamp: req.timestamp,
    });
  }
  return out;
}

/** Index captured requests by their triggering node — the per-node replay cache. */
export function indexByNode(captured: CapturedRequest[]): Map<string, CapturedRequest[]> {
  const map = new Map<string, CapturedRequest[]>();
  for (const c of captured) {
    const list = map.get(c.triggerNodeId);
    if (list) list.push(c);
    else map.set(c.triggerNodeId, [c]);
  }
  return map;
}
