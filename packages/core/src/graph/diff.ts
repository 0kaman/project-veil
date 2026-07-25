/**
 * The feedback an action returns: a DIFF, not a re-dump.
 *
 * After veil_do the graph is rebuilt from scratch (measured at 2–12% of a
 * veil_do; incremental would save ~1% and reintroduce v1's staleness bugs). But
 * the AGENT doesn't need the whole new graph — it needs to know what its action
 * changed. So the rebuild is internal and the diff is what crosses the wire.
 */
import type { BehaviorGraph } from "./model.js";

export interface GraphDiff {
  navigated?: { from: string; to: string };
  /** Doer ids that appeared. */
  added: string[];
  /** Doer ids that vanished. */
  removed: string[];
  /** Doers whose actionability state changed, with a human-readable delta. */
  changed: Array<{ id: string; was: string; now: string }>;
  linksBefore: number;
  linksAfter: number;
}

function stateStr(s: Record<string, unknown>): string {
  const e = Object.entries(s);
  return e.length === 0 ? "-" : e.map(([k, v]) => (v === true ? k : `${k}:${v}`)).join(",");
}

export function diffGraphs(before: BehaviorGraph, after: BehaviorGraph): GraphDiff {
  const beforeDoers = new Set(before.doers);
  const afterDoers = new Set(after.doers);

  const added = after.doers.filter((id) => !beforeDoers.has(id));
  const removed = before.doers.filter((id) => !afterDoers.has(id));

  const changed: GraphDiff["changed"] = [];
  for (const id of after.doers) {
    if (!beforeDoers.has(id)) continue;
    const a = before.nodes.get(id);
    const b = after.nodes.get(id);
    if (!a || !b) continue;
    const was = stateStr(a.state as Record<string, unknown>);
    const now = stateStr(b.state as Record<string, unknown>);
    if (was !== now) changed.push({ id, was, now });
  }

  return {
    ...(before.meta.url !== after.meta.url && {
      navigated: { from: before.meta.route, to: after.meta.route },
    }),
    added,
    removed,
    changed,
    linksBefore: before.links.length,
    linksAfter: after.links.length,
  };
}

/** True when the action produced no observable change at all. */
export function isNoOp(d: GraphDiff): boolean {
  return (
    !d.navigated &&
    d.added.length === 0 &&
    d.removed.length === 0 &&
    d.changed.length === 0 &&
    d.linksBefore === d.linksAfter
  );
}
