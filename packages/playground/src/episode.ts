/**
 * Episodic log — one distilled record per session, appended to
 * traces/episodes.jsonl. Where the .trace.jsonl is the raw event stream, an
 * episode is the session's memory: what was asked, what it cost, and — the point
 * — how often a read had to escalate.
 *
 * ESCALATION RATE is the metric that can falsify the whole reboot. The
 * architecture bets most reads succeed and the engine stays a rare fallback. If
 * doorman + js-shell dominate, that bet is wrong, and we want to know from real
 * traffic, not a one-off probe. So every read's receipt status is tallied here.
 *
 * Just another Tracer subscriber — the UI is a view, this is a memory. Flushed
 * on run.end AND a process-exit hook, so a crash still records.
 */
import { appendFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import type { TraceEvent, Tracer } from "./trace.js";

export interface ReadOutcomes {
  total: number;
  ok: number;
  doorman: number;
  jsShell: number;
  empty: number;
  fetchFailed: number;
  pulls: number;
}

export interface Episode {
  id: string;
  startedAt: string;
  ms: number;
  model: string;
  goal: string;
  reason: string;
  searches: number;
  reads: ReadOutcomes;
  /** (doorman + jsShell) / fresh reads — the fraction that needed the engine. */
  escalationRate: number;
  llmCalls: number;
  promptTokens: number;
  completionTokens: number;
  warnings: Record<string, number>;
}

/** Read the receipt status from a tool-result's `via` line. */
function readStatus(via: string | null): keyof ReadOutcomes | "pull" | null {
  if (!via) return null;
  if (via.startsWith("via: handle")) return "pull"; // search-within-page, not a read
  const m = via.match(/·\s*(ok|doorman|js-shell|empty|fetch-failed)\b/i);
  if (!m) return null;
  switch (m[1].toLowerCase()) {
    case "ok":
      return "ok";
    case "doorman":
      return "doorman";
    case "js-shell":
      return "jsShell";
    case "empty":
      return "empty";
    case "fetch-failed":
      return "fetchFailed";
    default:
      return null;
  }
}

export class EpisodeRecorder {
  private readonly t0 = Date.now();
  private readonly dir: string;
  private readonly file: string;
  private written = false;

  private model = "";
  private goal = "";
  private id = "";
  private searches = 0;
  private reads: ReadOutcomes = { total: 0, ok: 0, doorman: 0, jsShell: 0, empty: 0, fetchFailed: 0, pulls: 0 };
  private llmCalls = 0;
  private promptTokens = 0;
  private completionTokens = 0;
  private warnings: Record<string, number> = {};

  constructor(dir: string) {
    this.dir = resolve(dir);
    this.file = resolve(this.dir, "episodes.jsonl");
    // Durability. `exit` covers normal completion and process.exit() (so ctrl-c,
    // which Ink turns into a clean exit, is caught). But `exit` does NOT fire on
    // signal death — closing the terminal sends SIGHUP, and the episode was
    // being lost. Handle those explicitly: flush, then exit. finish() is
    // idempotent, so overlapping paths are safe. SIGINT is left to Ink, whose
    // clean unmount restores the terminal; intercepting it here would leave raw
    // mode on. (Bug found 2026-07-21: an 18-read interactive session vanished.)
    process.on("exit", () => this.finish("process-exit"));
    for (const sig of ["SIGHUP", "SIGTERM"] as const) {
      process.on(sig, () => {
        this.finish(sig.toLowerCase());
        process.exit(0);
      });
    }
  }

  attach(tracer: Tracer): () => void {
    return tracer.subscribe((e) => this.consume(e));
  }

  private consume(e: TraceEvent): void {
    switch (e.kind) {
      case "run.start":
        this.model = e.model;
        this.goal = e.goal;
        this.id = e.traceFile.split("/").slice(-1)[0].replace(".trace.jsonl", "");
        break;
      case "llm.response":
        this.llmCalls++;
        this.promptTokens += e.promptTokens;
        this.completionTokens += e.completionTokens;
        break;
      case "tool.result": {
        if (e.name === "veil_search") {
          this.searches++;
        } else if (e.name === "veil_read") {
          const s = readStatus(e.via);
          if (s === "pull") this.reads.pulls++;
          else if (s) {
            this.reads.total++;
            this.reads[s]++;
          }
        }
        break;
      }
      case "warn":
        this.warnings[e.code] = (this.warnings[e.code] ?? 0) + 1;
        break;
      case "run.end":
        this.finish(e.reason);
        break;
      default:
        break;
    }
  }

  finish(reason: string): void {
    if (this.written) return;
    this.written = true;

    // A launch-and-quit with no activity is noise.
    if (this.reads.total === 0 && this.searches === 0) return;

    const escalated = this.reads.doorman + this.reads.jsShell;
    const episode: Episode = {
      id: this.id || `ep-${this.t0}`,
      startedAt: new Date(this.t0).toISOString(),
      ms: Date.now() - this.t0,
      model: this.model,
      goal: this.goal,
      reason,
      searches: this.searches,
      reads: this.reads,
      escalationRate: this.reads.total > 0 ? escalated / this.reads.total : 0,
      llmCalls: this.llmCalls,
      promptTokens: this.promptTokens,
      completionTokens: this.completionTokens,
      warnings: this.warnings,
    };

    try {
      mkdirSync(this.dir, { recursive: true });
      appendFileSync(this.file, JSON.stringify(episode) + "\n");
    } catch {
      /* the log is a convenience — never break a session over it */
    }
  }
}
