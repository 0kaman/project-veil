/**
 * Task classification for the escalation metric — kept pure and separate from
 * analyse.ts (which has console side effects and runs on import) so it can be
 * tested directly.
 *
 * The three buckets MUST partition every task. The blind-spot bug (2026-07-24)
 * was that search-only tasks — the BLR→DEL fare, which searched and read nothing
 * because the answer was form-gated — fell through the filter and vanished from
 * the metric entirely. The test asserts the partition is total.
 */
import type { Episode } from "./episode.js";

export interface TaskBuckets {
  /** ≥1 read succeeded — the cheap path won by reading. */
  answered: Episode[];
  /** Searched, read NOTHING — snippet-answered OR gave up (ambiguous). */
  searchOnly: Episode[];
  /** Had reads, ALL failed — definitely needed the engine. */
  deadEnd: Episode[];
}

export function classifyTasks(eps: Episode[]): TaskBuckets {
  return {
    answered: eps.filter((e) => e.reads.ok > 0),
    searchOnly: eps.filter((e) => e.reads.total === 0),
    deadEnd: eps.filter((e) => e.reads.total > 0 && e.reads.ok === 0),
  };
}
