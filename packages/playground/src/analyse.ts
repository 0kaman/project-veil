#!/usr/bin/env node
/**
 * Episode analysis — `pnpm play:analyse`.
 *
 * Reads every episode ever recorded and looks for what a single session can't
 * show you.
 *
 * Timeout detection needs TWO conditions, not one:
 *   (a) the duration is a constant for a given page — work varies, caps don't;
 *   (b) it lands at or above the configured settle cap.
 *
 * (a) alone is not evidence: google reliably takes ~4.5s and that is simply
 * google's load time. Two earlier heuristics were tried and rejected against
 * real data — "any constant ≥3s" flagged ordinary load times, and "the same
 * constant across different pages" (which sounds compelling) turned out to be
 * birthday-paradox noise: on a diverse corpus it flagged 5 innocent clusters
 * and MISSED the real bug, which only ever hit google. A settle that times out
 * costs cap + page load, so proximity to the cap is the actual fingerprint.
 *
 * Prints, worst-first:
 *   1. timeout signatures (constant AND ≈ the settle cap)
 *   2. per-URL latency (which pages are pathological)
 *   3. per-tool latency (where wall-clock actually goes)
 *   4. recurring anomalies
 *   5. token pressure
 */
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { loadEnv, repoRoot } from "./config.js";
import { constantClusters, type Anomaly, type Episode } from "./episode.js";


const B = (s: string) => `\x1b[1m${s}\x1b[0m`;
const DIM = (s: string) => `\x1b[2m${s}\x1b[0m`;
const RED = (s: string) => `\x1b[31m${s}\x1b[0m`;
const YEL = (s: string) => `\x1b[33m${s}\x1b[0m`;
const GRN = (s: string) => `\x1b[32m${s}\x1b[0m`;
const CYA = (s: string) => `\x1b[36m${s}\x1b[0m`;

const ms = (n: number) => (n < 1000 ? `${Math.round(n)}ms` : `${(n / 1000).toFixed(1)}s`);
const pad = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + "…" : s.padEnd(n));

function median(xs: number[]): number {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

function spread(xs: number[]): number {
  if (xs.length < 2) return 0;
  const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
  if (mean === 0) return 0;
  const sd = Math.sqrt(xs.reduce((a, b) => a + (b - mean) ** 2, 0) / xs.length);
  return sd / mean; // coefficient of variation
}

function load(file: string): Episode[] {
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8")
    .split("\n")
    .filter((l) => l.trim())
    .flatMap((l) => {
      try {
        return [JSON.parse(l) as Episode];
      } catch {
        return []; // a torn final line (killed mid-write) must not break analysis
      }
    });
}

function main(): void {
  loadEnv();
  const file = resolve(repoRoot(), "traces", "episodes.jsonl");
  const eps = load(file);

  if (eps.length === 0) {
    console.log(`\nNo episodes yet at ${file}\nRun \`pnpm play\` first.\n`);
    return;
  }

  const totalTurns = eps.reduce((a, e) => a + e.totals.turns, 0);
  const totalCalls = eps.reduce((a, e) => a + e.totals.toolCalls, 0);
  // Active time, NOT session lifetime: a REPL left open overnight is ~17h of
  // idle, which would swamp every other number here.
  const active = eps.reduce((a, e) => a + (e.totals.activeMs ?? 0), 0);
  const toolMs = eps.reduce((a, e) => a + e.totals.toolMs, 0);
  const llmMs = eps.reduce((a, e) => a + e.totals.llmMs, 0);

  console.log(`\n${B("VEIL EPISODE ANALYSIS")}  ${DIM(file)}`);
  console.log(
    `${eps.length} episodes · ${totalTurns} turns · ${totalCalls} tool calls · ${ms(active)} working\n`,
  );

  // ── 1. Timeout signatures ────────────────────────────────────────────────
  //
  // Two things must BOTH hold before calling something a timeout:
  //   (a) it's a constant for a given page (work varies; a cap doesn't), and
  //   (b) it lands at or above the configured settle cap.
  //
  // (b) is what makes this precise. Consistency alone is not evidence — google
  // reliably takes ~4.5s and that is simply google's load time. And a constant
  // shared across pages is NOT the signal either: that reads as compelling but
  // is birthday-paradox noise on a diverse corpus (it flagged 5 innocent
  // clusters here and missed the real one, which only ever hit google).
  // A settle that times out costs cap + page load, so ~cap is the fingerprint.
  const cap = Number(process.env.VEIL_QUIESCE_CAP_MS) || 12_000;
  const NEAR = 0.9;

  const perTarget = new Map<string, { url: string; via: string; ds: number[] }>();
  for (const e of eps) {
    for (const p of e.pages) {
      if (p.ms <= 0) continue;
      const key = `${p.via} @ ${p.url}`;
      const cur = perTarget.get(key) ?? { url: p.url, via: p.via, ds: [] };
      cur.ds.push(p.ms);
      perTarget.set(key, cur);
    }
  }

  const constants = [...perTarget.entries()].flatMap(([key, t]) =>
    constantClusters(t.ds).map((c) => ({ key, url: t.url, ...c })),
  );
  const capHits = constants.filter((c) => c.value >= cap * NEAR);
  const benign = constants.filter((c) => c.value < cap * NEAR);
  const cappedUrls = new Set(capHits.map((c) => c.url));

  console.log(B("1. Timeout signatures"));
  console.log(
    DIM(`   Constant for a page AND ≥ the ${ms(cap)} settle cap ⇒ settle is timing out.\n`),
  );
  if (capHits.length === 0) {
    console.log(`   ${GRN("none")} — no call sits at the settle cap\n`);
  } else {
    for (const c of capHits.sort((a, b) => b.value - a.value)) {
      console.log(
        `   ${RED("●")} ${B(pad(c.key, 50))} ~${B(ms(c.value))} ×${c.count} ${RED(`⇒ ≈ the ${ms(cap)} cap`)}`,
      );
    }
    console.log();
  }
  if (benign.length > 0) {
    console.log(DIM("   consistent but below the cap (just that page's load time):"));
    for (const c of benign.sort((a, b) => b.value - a.value).slice(0, 6)) {
      console.log(DIM(`     ~${ms(c.value)} ×${c.count}  ${c.key.slice(0, 56)}`));
    }
    console.log();
  }

  // Per-tool pooling is still right for "where does wall-clock go" (§3).
  const perTool = new Map<string, number[]>();
  for (const e of eps) {
    for (const t of e.tools) {
      perTool.set(t.name, [...(perTool.get(t.name) ?? []), ...(t.durations ?? [])]);
    }
  }

  // ── 2. Per-URL latency ───────────────────────────────────────────────────
  const perUrl = new Map<string, number[]>();
  for (const e of eps) {
    for (const p of e.pages) {
      if (p.ms > 0) perUrl.set(p.url, [...(perUrl.get(p.url) ?? []), p.ms]);
    }
  }

  if (perUrl.size > 0) {
    console.log(B("2. Per-page latency") + DIM("  (spread = how much it varies; ~0 ⇒ a constant)"));
    const rows = [...perUrl.entries()]
      .map(([url, ds]) => ({ url, n: ds.length, med: median(ds), cv: spread(ds) }))
      .sort((a, b) => b.med - a.med);
    for (const r of rows) {
      // Only flag pages whose constant actually sits at the settle cap.
      const flag = cappedUrls.has(r.url) ? RED(" ← sitting at the settle cap") : "";
      console.log(
        `   ${pad(r.url, 46)} ${B(ms(r.med).padStart(7))} ${DIM(`×${r.n}`)}  spread ${(r.cv * 100).toFixed(0)}%${flag}`,
      );
    }
    console.log();
  }

  // ── 3. Where wall-clock goes ─────────────────────────────────────────────
  console.log(B("3. Where the time goes"));
  const rows = [...perTool.entries()]
    .map(([name, ds]) => ({ name, n: ds.length, med: median(ds), tot: ds.reduce((a, b) => a + b, 0) }))
    .sort((a, b) => b.tot - a.tot);
  for (const r of rows) {
    const share = toolMs > 0 ? Math.round((r.tot / toolMs) * 100) : 0;
    const bar = "█".repeat(Math.max(0, Math.round(share / 4)));
    console.log(
      `   ${pad(r.name, 14)} ${B(ms(r.med).padStart(7))} med ${DIM(`×${String(r.n).padStart(3)}`)}  ${CYA(bar)} ${share}%`,
    );
  }
  console.log(
    DIM(`   tools ${ms(toolMs)} · llm ${ms(llmMs)} · ratio ${(toolMs / Math.max(llmMs, 1)).toFixed(1)}:1 tool:llm\n`),
  );

  // ── 4. Recurring anomalies ───────────────────────────────────────────────
  const byCode = new Map<string, { n: number; sev: Anomaly["severity"]; sample: string }>();
  for (const e of eps) {
    for (const a of e.anomalies) {
      const cur = byCode.get(a.code);
      byCode.set(a.code, { n: (cur?.n ?? 0) + 1, sev: a.severity, sample: cur?.sample ?? a.detail });
    }
  }
  console.log(B("4. Recurring anomalies"));
  if (byCode.size === 0) {
    console.log(`   ${GRN("none")}\n`);
  } else {
    const order = { high: 0, med: 1, low: 2 } as const;
    for (const [code, v] of [...byCode.entries()].sort(
      (a, b) => order[a[1].sev] - order[b[1].sev] || b[1].n - a[1].n,
    )) {
      const paint = v.sev === "high" ? RED : v.sev === "med" ? YEL : DIM;
      console.log(`   ${paint("●")} ${B(pad(code, 24))} ×${String(v.n).padStart(3)}  ${DIM(v.sample.slice(0, 70))}`);
    }
    console.log();
  }

  // ── 5. Token pressure ────────────────────────────────────────────────────
  const peak = Math.max(...eps.map((e) => e.totals.peakContextTokens), 0);
  const up = eps.reduce((a, e) => a + e.totals.promptTokens, 0);
  const down = eps.reduce((a, e) => a + e.totals.completionTokens, 0);
  const biggest = eps.flatMap((e) => e.pages).sort((a, b) => b.approxTokens - a.approxTokens)[0];
  console.log(B("5. Token pressure"));
  console.log(`   prompt ${up.toLocaleString()} · completion ${down.toLocaleString()} · peak context ${B(peak.toLocaleString())}`);
  if (biggest) {
    console.log(
      `   largest graph: ${biggest.url} → ${B(`~${biggest.approxTokens.toLocaleString()} tok`)} (${biggest.nodes} nodes)`,
    );
  }
  console.log();
}

main();
