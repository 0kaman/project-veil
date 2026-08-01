#!/usr/bin/env node
/**
 * Escalation analysis — `pnpm play:analyse`.
 *
 * Reads every episode and answers the one question that can falsify the reboot:
 * across real tasks, how often does a read succeed vs. have to escalate to a
 * browser that doesn't exist yet? If escalation is low, "a browser is a
 * fallback" holds. If it's high, the ladder is wrong and we reorder.
 *
 * Reported per-goal as well as in aggregate, because the aggregate lies: the
 * 2026-07-19 probe found research ~25% escalation vs commercial ~60%. A single
 * number would hide exactly the finding that matters.
 */
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { loadEnv, repoRoot } from "./config.js";
import type { Episode, ReadOutcomes } from "./episode.js";
import { classifyTasks } from "./metrics.js";

const B = (s: string) => `\x1b[1m${s}\x1b[0m`;
const DIM = (s: string) => `\x1b[2m${s}\x1b[0m`;
const RED = (s: string) => `\x1b[31m${s}\x1b[0m`;
const YEL = (s: string) => `\x1b[33m${s}\x1b[0m`;
const GRN = (s: string) => `\x1b[32m${s}\x1b[0m`;

const pct = (n: number, d: number) => (d > 0 ? Math.round((n / d) * 100) : 0);
const pad = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + "…" : s.padEnd(n));

function load(file: string): Episode[] {
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8")
    .split("\n")
    .filter((l) => l.trim())
    .flatMap((l) => {
      try {
        return [JSON.parse(l) as Episode];
      } catch {
        return []; // a torn final line must not break analysis
      }
    });
}

function sumReads(a: ReadOutcomes, b: ReadOutcomes): ReadOutcomes {
  return {
    total: a.total + b.total,
    ok: a.ok + b.ok,
    doorman: a.doorman + b.doorman,
    jsShell: a.jsShell + b.jsShell,
    // `?? 0` because episodes.jsonl is APPEND-ONLY and rows written before
    // `frames` existed have no such field. Summing `undefined` would turn the
    // whole column into NaN and quietly poison every other number beside it.
    frames: (a.frames ?? 0) + (b.frames ?? 0),
    empty: a.empty + b.empty,
    fetchFailed: a.fetchFailed + b.fetchFailed,
    pulls: a.pulls + b.pulls,
  };
}

const EMPTY: ReadOutcomes = { total: 0, ok: 0, doorman: 0, jsShell: 0, frames: 0, empty: 0, fetchFailed: 0, pulls: 0 };

function main(): void {
  loadEnv();
  const file = resolve(repoRoot(), "traces", "episodes.jsonl");
  const eps = load(file);

  if (eps.length === 0) {
    console.log(`\nNo episodes yet at ${file}\nRun \`pnpm play\` first.\n`);
    return;
  }

  const reads = eps.map((e) => e.reads).reduce(sumReads, EMPTY);
  const searches = eps.reduce((a, e) => a + e.searches, 0);
  const prompt = eps.reduce((a, e) => a + e.promptTokens, 0);
  const completion = eps.reduce((a, e) => a + e.completionTokens, 0);

  console.log(`\n${B("VEIL ESCALATION ANALYSIS")}  ${DIM(file)}`);
  console.log(`${eps.length} sessions · ${searches} searches · ${reads.total} reads\n`);

  // ── Task outcomes — EVERY task, nothing hidden ───────────────────────────
  // The thesis is about whether TASKS need a browser. Three outcomes partition
  // every recorded task:
  //   - answered:    ≥1 read succeeded → cheap path won by reading.
  //   - search-only: searched, read NOTHING. Ambiguous — either the snippet
  //                  answered it, OR the agent gave up because it needed the
  //                  engine (the BLR→DEL fare: form-gated, no readable source).
  //   - dead-end:    had reads, ALL failed → definitely needed the engine.
  // Earlier this metric filtered to tasks-with-reads, so search-only tasks —
  // including genuine capability gaps — VANISHED. Now they're a first-class row.
  const { answered, searchOnly, deadEnd, errored } = classifyTasks(eps);
  // Percentages are over VALID tasks — a crashed session is not a task outcome.
  const n = answered.length + searchOnly.length + deadEnd.length;

  console.log(`${B("Task outcomes")} ${DIM(`— ${n} valid tasks (crashed sessions excluded)`)}`);
  const trow = (label: string, count: number, note: string, color: (s: string) => string) =>
    console.log(`  ${color(pad(label, 14))} ${String(count).padStart(3)}  ${color((pct(count, n) + "%").padStart(4))}  ${DIM(note)}`);
  trow("answered", answered.length, "read succeeded — cheap path won", GRN);
  trow("search-only", searchOnly.length, "read nothing — snippet-answered OR gave up (review)", YEL);
  trow("dead-end", deadEnd.length, "all reads failed — needed the engine (not built)", RED);
  if (errored.length > 0) {
    console.log(`  ${DIM(pad("errored", 14))} ${DIM(String(errored.length).padStart(3))}  ${DIM("    ")}  ${DIM("session crashed (e.g. LLM 5xx) — not a task outcome, excluded")}`);
  }

  // Firm engine-need is the dead-end rate — the lower bound. search-only hides an
  // unknown number of real gaps, so it's flagged, not counted either way.
  const firm = pct(deadEnd.length, n);
  const MIN_TASKS = 10;
  let verdict: string;
  if (n < MIN_TASKS) {
    verdict = DIM(`${firm}% firm engine-need so far, but only ${n} tasks — provisional; need ≥${MIN_TASKS}.`);
  } else if (firm < 20) {
    verdict = GRN(`✓ ${firm}% of tasks definitely needed the engine — a genuine fallback. Thesis holds.`);
  } else if (firm < 40) {
    verdict = YEL(`~ ${firm}% definitely needed the engine — watch this.`);
  } else {
    verdict = RED(`✗ ${firm}% definitely needed the engine — the fallback thesis is under pressure.`);
  }
  console.log(`\n  ${B("verdict:")} ${verdict}`);
  if (searchOnly.length > 0) {
    console.log(DIM(`  caveat: ${searchOnly.length} search-only task(s) not counted — some are real gaps (form-gated`));
    console.log(DIM("  fares, live data) the engine would need to fill. Review them under Per goal.\n"));
  } else {
    console.log();
  }

  // ── Read hit rate: a SEPARATE concern — agent URL-picking quality ────────
  console.log(B("Read hit rate") + DIM("  — of the URLs the agent chose, how many were readable?"));
  const row = (label: string, n: number, color = (s: string) => s) =>
    console.log(`  ${color(pad(label, 14))} ${String(n).padStart(4)}  ${color(String(pct(n, reads.total) + "%").padStart(4))}  ${color("█".repeat(Math.round(pct(n, reads.total) / 3)))}`);
  row("ok", reads.ok, GRN);
  row("doorman", reads.doorman, RED);
  row("js-shell", reads.jsShell, RED);
  row("frames", reads.frames, RED);
  row("empty", reads.empty, DIM);
  row("fetch-failed", reads.fetchFailed, DIM);
  if (reads.pulls > 0) console.log(DIM(`  (${reads.pulls} handle pulls — search-within-page, not counted)`));
  console.log(
    DIM(
      `\n  ${pct(reads.doorman + reads.jsShell, reads.total)}% of chosen URLs needed a browser — but that's agent\n` +
        "  URL choice, NOT task escalation. A skeptical agent routes around them.\n",
    ),
  );

  // ── Per-goal — every task, tagged by outcome ─────────────────────────────
  console.log(B("Per goal") + DIM("  — outcome per task; crashes and gaps shown, not hidden"));
  const erroredSet = new Set(errored);
  const rank = (e: (typeof eps)[number]) =>
    erroredSet.has(e) ? 0 : e.reads.total === 0 ? 2 : e.reads.ok === 0 ? 3 : 1;
  for (const e of [...eps].sort((a, b) => rank(b) - rank(a))) {
    let tag: string;
    if (erroredSet.has(e)) tag = DIM("errored  ");
    else if (e.reads.total === 0) tag = YEL("srch-only");
    else if (e.reads.ok === 0) tag = RED("dead-end ");
    else tag = GRN(`${e.reads.ok}/${e.reads.total} ok  `);
    console.log(`  ${tag}  ${pad(e.goal === "(interactive)" ? "(interactive session)" : e.goal, 58)}`);
  }
  console.log(DIM("\n  (per-task, not per-class — tag goals to split research vs commercial)"));

  // ── Cost ─────────────────────────────────────────────────────────────────
  console.log(`\n${B("Cost")}  tokens ↑${prompt.toLocaleString()} ↓${completion.toLocaleString()} · ${searches + reads.total} tool calls over ${eps.length} sessions`);
  const warns = eps.flatMap((e) => Object.entries(e.warnings));
  if (warns.length) {
    const byCode = new Map<string, number>();
    for (const [k, v] of warns) byCode.set(k, (byCode.get(k) ?? 0) + v);
    console.log(`${B("Warnings")}  ${[...byCode].map(([k, v]) => `${k}×${v}`).join(" · ")}`);
  }
  console.log();
}

main();
