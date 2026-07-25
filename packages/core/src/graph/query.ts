/**
 * Querying the host-side graph — how an agent gets the detail the lean view
 * withheld, at zero browser cost. The graph is already in memory; this is a
 * filter, not a round trip.
 */
import type { BehaviorGraph, BehaviorNode } from "./model.js";

export interface NodeFilter {
  role?: string;
  /** Case-insensitive substring of the accessible name. */
  name?: string;
  /** Only nodes that fire something (i.e. have a known effect). */
  fires?: boolean;
  /** Only nodes handling this event type. */
  hasEvent?: string;
  limit?: number;
}

export interface QueryResult {
  matched: number;
  returned: BehaviorNode[];
  /** Set when the limit truncated the result — never silent. */
  note?: string;
}

export function queryNodes(graph: BehaviorGraph, filter: NodeFilter): QueryResult {
  const needle = filter.name?.toLowerCase();
  const all = [...graph.nodes.values()].filter((n) => {
    if (filter.role && n.role !== filter.role) return false;
    if (needle && !n.name.toLowerCase().includes(needle)) return false;
    if (filter.fires && !n.fires) return false;
    if (filter.hasEvent && !n.events.some((e) => e.type === filter.hasEvent)) return false;
    return true;
  });

  const limit = filter.limit ?? 50;
  const returned = all.slice(0, limit);
  return {
    matched: all.length,
    returned,
    ...(all.length > returned.length && {
      note: `returned ${returned.length} of ${all.length} matches — narrow the filter for more`,
    }),
  };
}
