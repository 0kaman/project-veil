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
  /** A dialog opened or closed. This is the receipt an agent actually reads
   * after veil_do, so it is where the modal has to be reported: measured, six
   * of six fare runs saw nodes vanish here and read it as a broken page. */
  dialog?: { opened?: string; closed?: string };
  /** The page crossed into (or out of) having child documents whose content is
   * not in the graph. Set only when that changed. Same reasoning as `dialog`:
   * an agent that navigates a link INTO a frameset sees "−16 actions" and needs
   * to be told why, at the surface it actually reads. */
  frames?: { before: number; after: number; unreadable: number };
}

function stateStr(s: Record<string, unknown>): string {
  const e = Object.entries(s);
  return e.length === 0 ? "-" : e.map(([k, v]) => (v === true ? k : `${k}:${v}`)).join(",");
}

export function diffGraphs(before: BehaviorGraph, after: BehaviorGraph): GraphDiff {
  const beforeDoers = new Set(before.doers);
  const afterDoers = new Set(after.doers);

  const dialogChange =
    before.meta.dialog !== after.meta.dialog
      ? {
          ...(after.meta.dialog !== undefined && { opened: after.meta.dialog }),
          ...(before.meta.dialog !== undefined && { closed: before.meta.dialog }),
        }
      : undefined;
  const framesBefore = before.meta.frames?.total ?? 0;
  const framesAfter = after.meta.frames?.total ?? 0;
  const fa = after.meta.frames;
  const frameChange =
    framesBefore !== framesAfter
      ? {
          before: framesBefore,
          after: framesAfter,
          unreadable: fa ? fa.readable.length - fa.perceived + fa.unreachable.length : 0,
        }
      : undefined;

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
    ...(dialogChange && { dialog: dialogChange }),
    ...(frameChange && { frames: frameChange }),
  };
}

/** True when the action produced no observable change at all.
 *
 * Deliberately blind to `frames`: a frame count that moved without a single
 * doer, link, dialog or URL changing is not an observable effect of the action,
 * and counting it would stop every act on a framed page reporting `noOp`. */
export function isNoOp(d: GraphDiff): boolean {
  return (
    !d.navigated &&
    d.added.length === 0 &&
    d.removed.length === 0 &&
    d.changed.length === 0 &&
    d.linksBefore === d.linksAfter
  );
}
