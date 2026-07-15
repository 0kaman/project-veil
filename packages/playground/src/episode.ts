/**
 * Episodic log — one durable record per session, appended to traces/episodes.jsonl.
 *
 * The per-run .trace.jsonl is the raw event stream: complete, but you have to
 * already know what you're looking for. An *episode* is the distilled memory of
 * a session — what was asked, what it cost, what went wrong — in a shape that
 * survives the session and can be compared against every other session.
 *
 * That comparison is the point. The 12s-quiescence-cap bug was not visible in
 * any single number; it showed up because google (14.9s) and wikipedia (15.2s)
 * clustered near a *constant*. Work varies with input; timeouts don't. So the
 * recorder flags constant-time clusters automatically rather than waiting for
 * someone to notice.
 *
 * This is just another Tracer subscriber — the UI is a view, this is a memory.
 */
import { appendFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import type { TraceEvent, Tracer, TurnOutcome } from "./trace.js";

export interface ToolStat {
  name: string;
  calls: number;
  errors: number;
  totalMs: number;
  p50Ms: number;
  p95Ms: number;
  maxMs: number;
  totalChars: number;
  /** Every duration, so cross-episode analysis can re-cluster them. */
  durations: number[];
}

export interface PageVisit {
  url: string;
  via: string;
  nodes: number;
  approxTokens: number;
  /** Latency of the tool call that produced this graph. */
  ms: number;
}

export interface TurnRecord {
  turn: number;
  text: string;
  ms: number;
  steps: number;
  outcome: TurnOutcome;
  toolCalls: number;
  promptTokens: number;
  completionTokens: number;
}

export interface Anomaly {
  code:
    | "SLOW_TOOL"
    | "CONSTANT_TIME_CLUSTER"
    | "REPEATED_CALL"
    | "TOOL_ERROR"
    | "CONTEXT_GROWTH"
    | "GRAPH_BLOAT"
    | "NO_PROGRESS"
    | "MODEL_ERROR";
  detail: string;
  /** Rough triage weight; analysis sorts on it. */
  severity: "low" | "med" | "high";
}

export interface Episode {
  id: string;
  startedAt: string;
  endedAt: string;
  ms: number;
  model: string;
  traceFile: string;
  reason: string;
  turns: TurnRecord[];
  totals: {
    turns: number;
    /** Time actually spent working. `ms` is session lifetime — for a REPL left
     * open, that's mostly idle and useless for optimisation. */
    activeMs: number;
    steps: number;
    toolCalls: number;
    toolErrors: number;
    warns: number;
    llmMs: number;
    toolMs: number;
    promptTokens: number;
    completionTokens: number;
    peakContextTokens: number;
  };
  tools: ToolStat[];
  pages: PageVisit[];
  anomalies: Anomaly[];
}

const SLOW_TOOL_MS = 5_000;
const BIG_CONTEXT_TOKENS = 50_000;
const BIG_GRAPH_TOKENS = 10_000;
/** Durations within this fraction of each other read as "the same number". */
const CLUSTER_TOLERANCE = 0.08;
/** Below this, a repeated constant is plausibly just fast, consistent work. */
const CLUSTER_FLOOR_MS = 3_000;

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const i = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[i];
}

/**
 * Find durations that repeat near-identically. Real work varies with input; a
 * timeout returns the same number every time. Two calls agreeing to within 8%
 * at 12s is a far stronger signal than either call being "slow".
 */
export function constantClusters(durations: number[]): { value: number; count: number }[] {
  const big = durations.filter((d) => d >= CLUSTER_FLOOR_MS).sort((a, b) => a - b);
  const out: { value: number; count: number }[] = [];
  let i = 0;
  while (i < big.length) {
    const base = big[i];
    let j = i;
    while (j < big.length && big[j] - base <= base * CLUSTER_TOLERANCE) j++;
    const count = j - i;
    if (count >= 2) {
      const mean = big.slice(i, j).reduce((a, b) => a + b, 0) / count;
      out.push({ value: Math.round(mean), count });
    }
    i = j;
  }
  return out;
}

export class EpisodeRecorder {
  private readonly t0 = Date.now();
  private readonly dir: string;
  private readonly file: string;
  private written = false;

  private model = "";
  private traceFile = "";
  private id = "";
  private turns: TurnRecord[] = [];
  private pages: PageVisit[] = [];
  private anomalies: Anomaly[] = [];
  private byTool = new Map<string, { durations: number[]; errors: number; chars: number }>();

  // Rolling per-turn accumulators.
  private curText = "";
  private curPrompt = 0;
  private curCompletion = 0;
  private curTools = 0;
  private steps = 0;
  private warns = 0;
  private llmMs = 0;
  private toolMs = 0;
  private promptTokens = 0;
  private completionTokens = 0;
  private peakContext = 0;
  private lastToolMs = 0;

  constructor(dir: string) {
    this.dir = resolve(dir);
    this.file = resolve(this.dir, "episodes.jsonl");
    // Safety net: a crash, a ctrl+c, or a non-interactive exit must still leave
    // the episode on disk. appendFileSync works inside an 'exit' handler where
    // async writes would silently never flush. finish() is idempotent.
    process.on("exit", () => this.finish("process-exit"));
  }

  attach(tracer: Tracer): () => void {
    return tracer.subscribe((e) => this.consume(e));
  }

  private consume(e: TraceEvent): void {
    switch (e.kind) {
      case "episode.start":
        this.model = e.model;
        this.traceFile = e.traceFile;
        this.id = e.episodeId;
        break;

      case "turn.start":
        this.curText = e.text;
        this.curPrompt = 0;
        this.curCompletion = 0;
        this.curTools = 0;
        break;

      case "turn.end":
        this.turns.push({
          turn: e.turn,
          text: this.curText,
          ms: e.ms,
          steps: e.steps,
          outcome: e.outcome,
          toolCalls: this.curTools,
          promptTokens: this.curPrompt,
          completionTokens: this.curCompletion,
        });
        if (e.outcome === "max-steps") {
          this.anomalies.push({
            code: "NO_PROGRESS",
            severity: "high",
            detail: `turn ${e.turn} hit the step ceiling after ${e.steps} steps without answering`,
          });
        }
        break;

      case "llm.response":
        this.steps = Math.max(this.steps, e.step);
        this.llmMs += e.ms;
        this.promptTokens += e.promptTokens;
        this.completionTokens += e.completionTokens;
        this.curPrompt += e.promptTokens;
        this.curCompletion += e.completionTokens;
        this.peakContext = Math.max(this.peakContext, e.promptTokens);
        if (e.promptTokens > BIG_CONTEXT_TOKENS) {
          this.anomalies.push({
            code: "CONTEXT_GROWTH",
            severity: "med",
            detail: `context reached ${e.promptTokens} prompt tokens at step ${e.step}`,
          });
        }
        break;

      case "tool.result": {
        this.toolMs += e.ms;
        this.curTools++;
        this.lastToolMs = e.ms;
        const s = this.byTool.get(e.name) ?? { durations: [], errors: 0, chars: 0 };
        s.durations.push(e.ms);
        s.chars += e.chars;
        if (!e.ok) s.errors++;
        this.byTool.set(e.name, s);

        if (e.ms > SLOW_TOOL_MS) {
          this.anomalies.push({
            code: "SLOW_TOOL",
            severity: "med",
            detail: `${e.name} took ${e.ms}ms`,
          });
        }
        if (!e.ok) {
          this.anomalies.push({
            code: "TOOL_ERROR",
            severity: "high",
            detail: `${e.name}: ${e.text.slice(0, 160)}`,
          });
        }
        break;
      }

      case "graph.observed":
        if (e.url) {
          this.pages.push({
            url: e.url,
            via: e.via,
            nodes: e.nodes,
            approxTokens: e.approxTokens,
            ms: this.lastToolMs,
          });
        }
        if (e.approxTokens > BIG_GRAPH_TOKENS) {
          this.anomalies.push({
            code: "GRAPH_BLOAT",
            severity: "med",
            detail: `${e.url ?? "graph"} serialized to ~${e.approxTokens} tokens (${e.nodes} nodes)`,
          });
        }
        break;

      case "warn":
        this.warns++;
        if (e.code === "REPEATED_CALL") {
          this.anomalies.push({ code: "REPEATED_CALL", severity: "high", detail: e.message });
        }
        break;

      case "error":
        this.anomalies.push({ code: "MODEL_ERROR", severity: "high", detail: e.message });
        break;

      case "episode.end":
        this.finish(e.reason);
        break;

      default:
        break;
    }
  }

  private toolStats(): ToolStat[] {
    return [...this.byTool.entries()]
      .map(([name, s]) => {
        const sorted = [...s.durations].sort((a, b) => a - b);
        return {
          name,
          calls: s.durations.length,
          errors: s.errors,
          totalMs: s.durations.reduce((a, b) => a + b, 0),
          p50Ms: percentile(sorted, 50),
          p95Ms: percentile(sorted, 95),
          maxMs: sorted[sorted.length - 1] ?? 0,
          totalChars: s.chars,
          durations: s.durations,
        };
      })
      .sort((a, b) => b.totalMs - a.totalMs);
  }

  /** Write the episode. Safe to call twice; only the first wins. */
  finish(reason: string): void {
    if (this.written) return;
    this.written = true;

    const tools = this.toolStats();

    // The signal that cracked the quiescence cap: same number, every time.
    for (const t of tools) {
      for (const c of constantClusters(t.durations)) {
        this.anomalies.push({
          code: "CONSTANT_TIME_CLUSTER",
          severity: "high",
          detail:
            `${t.name} returned ~${c.value}ms on ${c.count} calls (±8%). ` +
            `Work varies with input; a constant is a timeout — check the settle cap.`,
        });
      }
    }

    const episode: Episode = {
      id: this.id || `ep-${this.t0}`,
      startedAt: new Date(this.t0).toISOString(),
      endedAt: new Date().toISOString(),
      ms: Date.now() - this.t0,
      model: this.model,
      traceFile: this.traceFile,
      reason,
      turns: this.turns,
      totals: {
        turns: this.turns.length,
        activeMs: this.turns.reduce((a, t) => a + t.ms, 0),
        steps: this.steps,
        toolCalls: tools.reduce((a, t) => a + t.calls, 0),
        toolErrors: tools.reduce((a, t) => a + t.errors, 0),
        warns: this.warns,
        llmMs: this.llmMs,
        toolMs: this.toolMs,
        promptTokens: this.promptTokens,
        completionTokens: this.completionTokens,
        peakContextTokens: this.peakContext,
      },
      tools,
      pages: this.pages,
      anomalies: this.anomalies,
    };

    // An episode with no turns is a launch-and-quit; recording it is noise.
    if (episode.turns.length === 0 && episode.totals.toolCalls === 0) return;

    try {
      mkdirSync(this.dir, { recursive: true });
      appendFileSync(this.file, JSON.stringify(episode) + "\n");
    } catch {
      /* the log is a convenience — never break a session over it */
    }
  }
}
