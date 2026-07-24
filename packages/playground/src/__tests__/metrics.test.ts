import { describe, it, expect } from "vitest";
import { classifyTasks } from "../metrics.js";
import type { Episode, ReadOutcomes } from "../episode.js";

function ep(reads: Partial<ReadOutcomes>, extra: Partial<Episode> = {}): Episode {
  const r: ReadOutcomes = { total: 0, ok: 0, doorman: 0, jsShell: 0, empty: 0, fetchFailed: 0, pulls: 0, ...reads };
  return {
    id: "x", startedAt: "", ms: 0, model: "m", goal: "g", reason: "done",
    searches: 1, reads: r, escalationRate: 0, llmCalls: 2, promptTokens: 0, completionTokens: 0,
    warnings: {}, errored: false, ...extra,
  };
}

describe("classifyTasks", () => {
  it("puts a task with a successful read in 'answered'", () => {
    const b = classifyTasks([ep({ total: 2, ok: 1, doorman: 1 })]);
    expect(b.answered).toHaveLength(1);
    expect(b.searchOnly).toHaveLength(0);
    expect(b.deadEnd).toHaveLength(0);
  });

  it("puts a search-that-read-nothing task in 'searchOnly' — the BLR→DEL fare case", () => {
    // A genuine search-only task makes 2+ LLM calls (search, then answer).
    const b = classifyTasks([ep({ total: 0 }, { llmCalls: 2 })]);
    expect(b.searchOnly).toHaveLength(1);
    expect(b.answered).toHaveLength(0);
    expect(b.deadEnd).toHaveLength(0);
    expect(b.errored).toHaveLength(0);
  });

  it("a session flagged errored is bucketed as errored, not a task outcome", () => {
    const b = classifyTasks([ep({ total: 0 }, { errored: true, llmCalls: 2 })]);
    expect(b.errored).toHaveLength(1);
    expect(b.searchOnly).toHaveLength(0);
  });

  it("a crash after search (llmCalls<2, no errored flag) is inferred as errored — the 503 case", () => {
    // Legacy data lacking the errored flag: searched, then the answer call never
    // ran. Must NOT count as a real search-only task.
    const b = classifyTasks([ep({ total: 0 }, { llmCalls: 1 })]);
    expect(b.errored).toHaveLength(1);
    expect(b.searchOnly).toHaveLength(0);
  });

  it("puts a task whose every read failed in 'deadEnd'", () => {
    const b = classifyTasks([ep({ total: 2, ok: 0, doorman: 1, jsShell: 1 })]);
    expect(b.deadEnd).toHaveLength(1);
    expect(b.answered).toHaveLength(0);
  });

  it("PARTITIONS every task across all four buckets — nothing vanishes", () => {
    const eps = [
      ep({ total: 2, ok: 1 }), // answered
      ep({ total: 0 }, { llmCalls: 2 }), // search-only (real)
      ep({ total: 3, ok: 0, doorman: 2, jsShell: 1 }), // dead-end
      ep({ total: 1, ok: 1 }), // answered
      ep({ total: 0 }, { llmCalls: 1 }), // errored (crashed after search)
      ep({ total: 0 }, { errored: true, llmCalls: 2 }), // errored (flagged)
    ];
    const b = classifyTasks(eps);
    const total = b.answered.length + b.searchOnly.length + b.deadEnd.length + b.errored.length;
    expect(total).toBe(eps.length);
    const seen = new Set([...b.answered, ...b.searchOnly, ...b.deadEnd, ...b.errored]);
    expect(seen.size).toBe(eps.length); // no double-count
  });
});
