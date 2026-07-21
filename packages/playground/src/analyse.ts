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
    empty: a.empty + b.empty,
    fetchFailed: a.fetchFailed + b.fetchFailed,
    pulls: a.pulls + b.pulls,
  };
}

const EMPTY: ReadOutcomes = { total: 0, ok: 0, doorman: 0, jsShell: 0, empty: 0, fetchFailed: 0, pulls: 0 };

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

  // ── The thesis metric: TASK-level, not read-level ────────────────────────
  // The thesis is about whether TASKS need a browser, not whether individual
  // reads fail. A doorman the agent reads PAST is not an escalation — the task
  // still succeeds on the cheap path. So a task escalated only if it got NO
  // successful read at all. (Discovered by reading the trace: tasks that hit
  // doormen still answered from the next result — read-level 50%, task-level 0%.)
  const tasksWithReads = eps.filter((e) => e.reads.total > 0);
  const escalatedTasks = tasksWithReads.filter((e) => e.reads.ok === 0);
  const taskEsc = pct(escalatedTasks.length, tasksWithReads.length);

  const MIN_TASKS = 10;
  let verdict: string;
  if (tasksWithReads.length < MIN_TASKS) {
    verdict = DIM(`${taskEsc}% so far, but only ${tasksWithReads.length} tasks — provisional; need ≥${MIN_TASKS}.`);
  } else if (taskEsc < 20) {
    verdict = GRN(`✓ ${taskEsc}% of tasks needed the engine — it's a genuine fallback. Thesis holds.`);
  } else if (taskEsc < 40) {
    verdict = YEL(`~ ${taskEsc}% of tasks needed the engine — watch this.`);
  } else {
    verdict = RED(`✗ ${taskEsc}% of tasks needed the engine — the fallback thesis is under pressure.`);
  }
  console.log(`${B("Task escalation")} ${DIM("— tasks where NO read succeeded (the thesis metric)")}`);
  console.log(`  ${verdict}\n`);

  // ── Read hit rate: a SEPARATE concern — agent URL-picking quality ────────
  console.log(B("Read hit rate") + DIM("  — of the URLs the agent chose, how many were readable?"));
  const row = (label: string, n: number, color = (s: string) => s) =>
    console.log(`  ${color(pad(label, 14))} ${String(n).padStart(4)}  ${color(String(pct(n, reads.total) + "%").padStart(4))}  ${color("█".repeat(Math.round(pct(n, reads.total) / 3)))}`);
  row("ok", reads.ok, GRN);
  row("doorman", reads.doorman, RED);
  row("js-shell", reads.jsShell, RED);
  row("empty", reads.empty, DIM);
  row("fetch-failed", reads.fetchFailed, DIM);
  if (reads.pulls > 0) console.log(DIM(`  (${reads.pulls} handle pulls — search-within-page, not counted)`));
  console.log(
    DIM(
      `\n  ${pct(reads.doorman + reads.jsShell, reads.total)}% of chosen URLs needed a browser — but that's agent\n` +
        "  URL choice, NOT task escalation. A skeptical agent routes around them.\n",
    ),
  );

  // ── Per-goal — the aggregate lies, so show the split ─────────────────────
  console.log(B("Per goal") + DIM("  — escalation varies by task type; the aggregate hides it"));
  for (const e of eps.filter((x) => x.reads.total > 0).sort((a, b) => b.escalationRate - a.escalationRate)) {
    const er = Math.round(e.escalationRate * 100);
    const c = er < 30 ? GRN : er < 50 ? YEL : RED;
    console.log(
      `  ${c(String(er + "%").padStart(4))} ${DIM(`(${e.reads.ok}/${e.reads.total} ok)`)}  ${pad(e.goal, 60)}`,
    );
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
