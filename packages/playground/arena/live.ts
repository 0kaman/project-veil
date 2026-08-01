/**
 * The live view — what the arena is doing RIGHT NOW.
 *
 * A full suite is ~30-60 minutes of wall clock. The previous runner printed one
 * line per completed cell, so for a minute at a time it looked indistinguishable
 * from hung, and the only way to know whether a contender was thrashing was to
 * wait for the end and read the totals. Two of the three defects this benchmark
 * found were noticed by watching a run go wrong, not by reading its summary.
 *
 * So state is written to `traces/arena/live.json` after every event, and the
 * renderer here is SHARED between the runner (which prints it inline) and
 * `arena:watch` (which redraws it in another terminal). One implementation, so
 * the two can never disagree about what is happening.
 *
 * The file is written atomically — rename(2) over a temp file — because a
 * watcher polling at 1Hz will otherwise eventually read a half-written JSON and
 * die, which is a stupid way to lose a benchmark's only progress signal.
 */
import { writeFileSync, renameSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

export interface CellResult {
  contender: string;
  task: string;
  run: number;
  ok: boolean;
  ms: number;
  promptTokens: number;
  toolCalls: number;
  error?: string;
}

export interface Current {
  contender: string;
  task: string;
  run: number;
  startedAt: number;
  steps: number;
  lastTool: string;
  lastNote: string;
  promptTokens: number;
}

export interface LiveState {
  startedAt: number;
  updatedAt: number;
  totalCells: number;
  runs: number;
  tasks: string[];
  contenders: string[];
  budget: number;
  spent: number;
  done: CellResult[];
  current: Current | null;
  events: string[];
  finished: boolean;
}

const BAR = 28;

const hhmmss = (ms: number): string => {
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return (h > 0 ? `${h}h` : "") + `${String(m).padStart(h > 0 ? 2 : 1, "0")}m${String(s % 60).padStart(2, "0")}s`;
};

const median = (xs: number[]): number =>
  xs.length ? [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]! : 0;

/** Progress bar that degrades to something readable when a terminal eats it. */
function bar(frac: number): string {
  const n = Math.max(0, Math.min(BAR, Math.round(frac * BAR)));
  return "█".repeat(n) + "·".repeat(BAR - n);
}

export class Live {
  private state: LiveState;
  private readonly path: string;
  private readonly tmp: string;

  constructor(dir: string, init: Omit<LiveState, "updatedAt" | "done" | "current" | "events" | "finished" | "spent">) {
    this.path = resolve(dir, "live.json");
    this.tmp = resolve(dir, ".live.json.tmp");
    this.state = { ...init, updatedAt: Date.now(), spent: 0, done: [], current: null, events: [], finished: false };
    this.flush();
  }

  private flush(): void {
    this.state.updatedAt = Date.now();
    try {
      writeFileSync(this.tmp, JSON.stringify(this.state));
      renameSync(this.tmp, this.path); // atomic for the watcher
    } catch {
      // A progress file that cannot be written must never take the run with it.
    }
  }

  private event(s: string): void {
    this.state.events.push(`${new Date().toISOString().slice(11, 19)}  ${s}`);
    if (this.state.events.length > 40) this.state.events.shift();
  }

  begin(contender: string, task: string, run: number): void {
    this.state.current = {
      contender, task, run,
      startedAt: Date.now(),
      steps: 0, lastTool: "connecting…", lastNote: "", promptTokens: 0,
    };
    this.event(`▶ ${contender} · ${task} · run ${run}`);
    this.flush();
  }

  tool(name: string): void {
    if (!this.state.current) return;
    this.state.current.steps++;
    this.state.current.lastTool = name;
    this.flush();
  }

  tokens(n: number): void {
    if (!this.state.current) return;
    this.state.current.promptTokens = n;
    this.flush();
  }

  note(s: string): void {
    if (!this.state.current) return;
    this.state.current.lastNote = s;
    this.event(`  · ${s}`);
    this.flush();
  }

  end(r: CellResult): void {
    this.state.done.push(r);
    this.state.spent += r.promptTokens;
    this.state.current = null;
    this.event(
      `${r.ok ? "✓ PASS" : "✗ fail"} ${r.contender} · ${r.task} · run ${r.run}  ` +
        `${hhmmss(r.ms)} · ${r.promptTokens.toLocaleString()} tok · ${r.toolCalls} calls` +
        (r.error ? `  [${r.error.slice(0, 40)}]` : ""),
    );
    this.flush();
  }

  finish(): void {
    this.state.finished = true;
    this.event("— finished —");
    this.flush();
  }

  get snapshot(): LiveState {
    return this.state;
  }

  /** One compact line, for the runner's own stdout / a tailed log. */
  line(): string {
    const s = this.state;
    const c = s.current;
    const pct = s.totalCells ? s.done.length / s.totalCells : 0;
    return (
      `  [${bar(pct)}] ${s.done.length}/${s.totalCells}  ` +
      `${s.done.filter((d) => d.ok).length} pass  ${(s.spent / 1000).toFixed(0)}k tok  ` +
      (c ? `│ ${c.contender}·${c.task}·r${c.run} ${hhmmss(Date.now() - c.startedAt)} step ${c.steps} ${c.lastTool}` : "│ —")
    );
  }
}

export function readLive(dir: string): LiveState | null {
  try {
    return JSON.parse(readFileSync(resolve(dir, "live.json"), "utf8")) as LiveState;
  } catch {
    return null;
  }
}

/** The full dashboard. Shared by the runner and the watcher, deliberately. */
export function render(s: LiveState): string {
  const now = s.finished ? s.updatedAt : Date.now();
  const elapsed = now - s.startedAt;
  const pct = s.totalCells ? s.done.length / s.totalCells : 0;

  // ETA from cells actually completed. No estimate before there is evidence —
  // a made-up ETA on run 1 is exactly the kind of confident-and-wrong number
  // this project keeps deleting.
  const per = s.done.length ? s.done.reduce((n, d) => n + d.ms, 0) / s.done.length : 0;
  const left = s.totalCells - s.done.length;
  const eta = s.done.length >= 2 && !s.finished ? `  ETA ~${hhmmss(per * left)}` : "";

  const out: string[] = [];
  out.push("");
  out.push(`  ARENA — veil vs pinchtab${s.finished ? "   ·   FINISHED" : ""}`);
  out.push(`  ${bar(pct)}  ${s.done.length}/${s.totalCells} cells   ${hhmmss(elapsed)} elapsed${eta}`);
  out.push(
    `  tokens ${s.spent.toLocaleString()} / ${s.budget.toLocaleString()} budget` +
      `   (${((s.spent / Math.max(1, s.budget)) * 100).toFixed(1)}%)`,
  );
  out.push("");

  // ── what is happening this second ────────────────────────────────────────
  const c = s.current;
  if (c) {
    out.push(`  NOW   ${c.contender.toUpperCase().padEnd(9)} ${c.task.padEnd(9)} run ${c.run}`);
    out.push(
      `        ${hhmmss(Date.now() - c.startedAt)} in · step ${c.steps} · ${c.lastTool}` +
        (c.lastNote ? `\n        note: ${c.lastNote}` : ""),
    );
  } else if (!s.finished) {
    out.push("  NOW   (between runs)");
  }
  out.push("");

  // ── scoreboard ───────────────────────────────────────────────────────────
  out.push("  task       veil                    pinchtab");
  for (const t of s.tasks) {
    const cell = (name: string): string => {
      const rs = s.done.filter((d) => d.task === t && d.contender === name);
      if (!rs.length) return "—".padEnd(23);
      const pass = rs.filter((r) => r.ok).length;
      const marks = rs.map((r) => (r.ok ? "✓" : "✗")).join("");
      return `${pass}/${rs.length} ${marks.padEnd(6)} ${median(rs.map((r) => r.promptTokens)).toLocaleString().padStart(8)}tok`.padEnd(23);
    };
    out.push(`  ${t.padEnd(10)} ${cell("veil")} ${cell("pinchtab")}`);
  }
  out.push("");

  // ── totals ───────────────────────────────────────────────────────────────
  for (const name of s.contenders) {
    const rs = s.done.filter((d) => d.contender === name);
    if (!rs.length) continue;
    const toks = rs.map((r) => r.promptTokens);
    out.push(
      `  ${name.padEnd(9)} ${rs.filter((r) => r.ok).length}/${rs.length} pass · ` +
        `median ${median(toks).toLocaleString()} tok · median ${hhmmss(median(rs.map((r) => r.ms)))} · ` +
        `total ${rs.reduce((n, r) => n + r.promptTokens, 0).toLocaleString()} tok`,
    );
  }

  out.push("");
  out.push("  recent");
  for (const e of s.events.slice(-10)) out.push(`    ${e}`);
  out.push("");
  return out.join("\n");
}
