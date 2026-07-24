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
  /** Session crashed (e.g. an LLM 5xx) — NOT a valid task outcome. Kept apart so
   * a crash after search isn't miscounted as "search-only". */
  errored: Episode[];
}

/**
 * A session that ended in an error is not a task outcome. The `errored` flag is
 * the primary signal; the fallback catches episodes recorded BEFORE that flag
 * existed — a search with no follow-up LLM call (llmCalls < 2) means the answer
 * call never ran, i.e. it crashed after searching. A genuine search-only task
 * (snippet-answered) always makes a second call to write the answer.
 */
function isErrored(e: Episode): boolean {
  if (e.errored) return true;
  return e.searches > 0 && e.reads.total === 0 && e.llmCalls < 2;
}

export function classifyTasks(eps: Episode[]): TaskBuckets {
  const errored = eps.filter(isErrored);
  const valid = eps.filter((e) => !isErrored(e));
  return {
    errored,
    answered: valid.filter((e) => e.reads.ok > 0),
    searchOnly: valid.filter((e) => e.reads.total === 0),
    deadEnd: valid.filter((e) => e.reads.total > 0 && e.reads.ok === 0),
  };
}
