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
  const escalated = reads.doorman + reads.jsShell;

  console.log(`\n${B("VEIL ESCALATION ANALYSIS")}  ${DIM(file)}`);
  console.log(`${eps.length} sessions · ${searches} searches · ${reads.total} reads\n`);

  // ── The metric ───────────────────────────────────────────────────────────
  console.log(B("Read outcomes") + DIM("  — did the cheap path suffice?"));
  const row = (label: string, n: number, color = (s: string) => s) =>
    console.log(`  ${color(pad(label, 14))} ${String(n).padStart(4)}  ${color(String(pct(n, reads.total) + "%").padStart(4))}  ${color("█".repeat(Math.round(pct(n, reads.total) / 3)))}`);
  row("ok (read won)", reads.ok, GRN);
  row("doorman", reads.doorman, RED);
  row("js-shell", reads.jsShell, RED);
  row("empty", reads.empty, DIM);
  row("fetch-failed", reads.fetchFailed, DIM);
  if (reads.pulls > 0) console.log(DIM(`  (${reads.pulls} handle pulls — search-within-page, not counted)`));

  // A verdict needs a sample. Declaring the thesis dead on 10 reads would be
  // exactly the over-claiming this whole project exists to avoid.
  const MIN = 20;
  const eRate = pct(escalated, reads.total);
  let verdict: string;
  if (reads.total < MIN) {
    verdict = DIM(`${eRate}% so far, but only ${reads.total} reads — provisional; need ≥${MIN} for a real verdict.`);
  } else if (eRate < 30) {
    verdict = GRN(`✓ ${eRate}% escalation — the engine remains a genuine fallback. Thesis holds.`);
  } else if (eRate < 50) {
    verdict = YEL(`~ ${eRate}% escalation — watch this. The engine is pulling toward the main path.`);
  } else {
    verdict = RED(`✗ ${eRate}% escalation — the "browser is a fallback" thesis is under real pressure.`);
  }
  console.log(`\n  ${B("escalation rate:")} ${verdict}`);
  console.log(
    DIM(
      "  note: this is escalation as the AGENT experienced it — its URL choices and any\n" +
        "  over-reading inflate it above the web's base rate. That gap is the point.\n",
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
