/**
 * The trace bus — the reason this playground exists.
 *
 * Every observable moment (LLM request/response, MCP tool call/result, graph
 * mutation, Veil's stderr, warnings) becomes one typed event with a sequence
 * number, a wall-clock timestamp, and a duration where meaningful. Events fan
 * out to the Ink UI AND append to a JSONL file, so a session can be replayed or
 * grepped after the fact — the UI is a view, the JSONL is the record.
 *
 * Nothing here is allowed to throw into the agent loop: a broken tracer must
 * never be the reason a repro fails.
 */
import { createWriteStream, mkdirSync, type WriteStream } from "node:fs";
import { resolve } from "node:path";

export interface ToolCallRef {
  id: string;
  name: string;
  args: string;
}

export type TurnOutcome = "answered" | "max-steps" | "interrupted" | "error";

export interface TraceMeta {
  seq: number;
  /** ms since run start — the axis you actually read when hunting latency. */
  at: number;
  ts: string;
}

/** The payload callers construct. Kept separate from TraceMeta because
 * `Omit<Union, k>` collapses a discriminated union to its shared keys. */
export type TraceBody =
  | { kind: "episode.start"; model: string; traceFile: string; episodeId: string }
  | { kind: "turn.start"; turn: number; text: string }
  | { kind: "turn.end"; turn: number; ms: number; steps: number; outcome: TurnOutcome }
  | { kind: "mcp.connect"; ms: number; tools: string[] }
  | { kind: "mcp.stderr"; line: string }
  | {
      kind: "llm.request";
      step: number;
      model: string;
      messages: number;
      toolsOffered: number;
      approxPromptTokens: number;
    }
  | {
      kind: "llm.response";
      step: number;
      ms: number;
      finishReason: string;
      promptTokens: number;
      completionTokens: number;
      cachedTokens: number;
      content: string | null;
      toolCalls: ToolCallRef[];
    }
  | { kind: "tool.call"; step: number; id: string; name: string; args: unknown }
  | {
      kind: "tool.result";
      step: number;
      id: string;
      name: string;
      ms: number;
      ok: boolean;
      chars: number;
      approxTokens: number;
      text: string;
    }
  | {
      kind: "graph.observed";
      step: number;
      via: string;
      /** The page the graph describes — lets analysis group latency per URL. */
      url: string | null;
      nodes: number;
      chars: number;
      approxTokens: number;
      networkEdges: number;
      apis: number;
      components: number;
      added: string[];
      removed: string[];
    }
  | { kind: "warn"; step: number; code: string; message: string }
  | { kind: "error"; step: number; message: string; stack?: string }
  | { kind: "episode.end"; ms: number; turns: number; reason: string };

export type TraceEvent = TraceBody & TraceMeta;

export type TraceListener = (e: TraceEvent) => void;

export class Tracer {
  private seq = 0;
  private readonly t0 = Date.now();
  private listeners = new Set<TraceListener>();
  private sink: WriteStream | null = null;
  readonly file: string;

  constructor(dir: string) {
    const stamp = new Date(this.t0).toISOString().replace(/[:.]/g, "-");
    this.file = resolve(dir, `${stamp}.trace.jsonl`);
    try {
      mkdirSync(dir, { recursive: true });
      this.sink = createWriteStream(this.file, { flags: "a" });
      // A broken pipe must not kill the run.
      this.sink.on("error", () => {
        this.sink = null;
      });
    } catch {
      this.sink = null;
    }
  }

  emit(e: TraceBody): void {
    const now = Date.now();
    const full: TraceEvent = {
      ...e,
      seq: this.seq++,
      at: now - this.t0,
      ts: new Date(now).toISOString(),
    };

    try {
      this.sink?.write(JSON.stringify(full) + "\n");
    } catch {
      /* tracing must never break the run */
    }
    for (const l of this.listeners) {
      try {
        l(full);
      } catch {
        /* a broken view must never break the run */
      }
    }
  }

  subscribe(l: TraceListener): () => void {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }

  elapsed(): number {
    return Date.now() - this.t0;
  }

  close(): void {
    try {
      this.sink?.end();
    } catch {
      /* ignore */
    }
  }
}
