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

  // A zero-match query on a framed page is the second trap, not a dead end.
  // Measured on the arena's frameset run: the agent queried "for frames or
  // iframes", got "(nothing matched — try a broader filter)", and went straight
  // back to guessing frame names. The graph already knows the real ones.
  let note: string | undefined;
  if (all.length > returned.length) {
    note = `returned ${returned.length} of ${all.length} matches — narrow the filter for more`;
  } else if (all.length === 0) {
    const f = graph.meta.frames;
    const missing = f ? f.readable.length - f.perceived : 0;
    const bits: string[] = [];
    if (f && missing > 0) {
      bits.push(
        `${missing} of its ${f.total} child document(s) are NOT in this graph. The ` +
          `readable ones are: ` +
          f.readable
            .slice(0, 8)
            .map((x) => `${x.name || "(unnamed)"} → ${x.url}`)
            .join(", ") +
          `. veil_open one of those URLs, then veil_read the session id it returns.`,
      );
    }
    if (f && f.unreachable.length > 0) {
      bits.push(
        `${f.unreachable.length} child document(s) are cross-site (${f.unreachable
          .slice(0, 4)
          .join(", ")}) and cannot be reached at all — there is no recovery for those.`,
      );
    }
    if (bits.length > 0) note = `nothing matched here. ${bits.join(" ")}`;
  }

  return { matched: all.length, returned, ...(note !== undefined && { note }) };
}
