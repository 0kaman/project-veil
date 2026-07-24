import { describe, it, expect } from "vitest";
import { classifyTasks } from "../metrics.js";
import type { Episode, ReadOutcomes } from "../episode.js";

function ep(reads: Partial<ReadOutcomes>, searches = 1): Episode {
  const r: ReadOutcomes = { total: 0, ok: 0, doorman: 0, jsShell: 0, empty: 0, fetchFailed: 0, pulls: 0, ...reads };
  return {
    id: "x", startedAt: "", ms: 0, model: "m", goal: "g", reason: "done",
    searches, reads: r, escalationRate: 0, llmCalls: 1, promptTokens: 0, completionTokens: 0, warnings: {},
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
    // Regression: this used to vanish from the metric entirely.
    const b = classifyTasks([ep({ total: 0 })]);
    expect(b.searchOnly).toHaveLength(1);
    expect(b.answered).toHaveLength(0);
    expect(b.deadEnd).toHaveLength(0);
  });

  it("puts a task whose every read failed in 'deadEnd'", () => {
    const b = classifyTasks([ep({ total: 2, ok: 0, doorman: 1, jsShell: 1 })]);
    expect(b.deadEnd).toHaveLength(1);
    expect(b.answered).toHaveLength(0);
  });

  it("PARTITIONS every task — nothing vanishes (the blind-spot invariant)", () => {
    const eps = [
      ep({ total: 2, ok: 1 }), // answered
      ep({ total: 0 }), // search-only
      ep({ total: 3, ok: 0, doorman: 2, jsShell: 1 }), // dead-end
      ep({ total: 1, ok: 1 }), // answered
      ep({ total: 0 }, 2), // search-only (2 searches, 0 reads)
    ];
    const b = classifyTasks(eps);
    expect(b.answered.length + b.searchOnly.length + b.deadEnd.length).toBe(eps.length);
    // and no double-counting
    const ids = new Set([...b.answered, ...b.searchOnly, ...b.deadEnd]);
    expect(ids.size).toBe(eps.length);
  });
});
