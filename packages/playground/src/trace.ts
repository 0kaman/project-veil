/**
 * The trace bus. Every observable moment — LLM request/response, MCP tool
 * call/result, the receipt each tool returned, Veil's stderr — becomes one typed
 * event with a sequence number and a wall-clock offset. Events fan out to the
 * Ink UI AND append to a JSONL file, so a session can be grepped or replayed
 * after the fact. The UI is a view; the JSONL is the record.
 *
 * Nothing here may throw into the agent loop: a broken tracer must never be why
 * a repro fails.
 */
import { createWriteStream, mkdirSync, type WriteStream } from "node:fs";
import { resolve } from "node:path";

export interface ToolCallRef {
  id: string;
  name: string;
  args: string;
}

/** Fields callers construct. Kept separate from the meta because `Omit<Union,k>`
 * collapses a discriminated union to its shared keys. */
export type TraceBody =
  | { kind: "run.start"; goal: string; model: string; traceFile: string }
  | { kind: "mcp.connect"; ms: number; tools: string[] }
  /** The user's turn, IN FULL. Recorded because a run that skipped two thirds of
   * a 16-step script could not be diagnosed without it: there was no way to tell
   * "the model ignored the instructions" from "the terminal mangled the paste".
   * `chars` is kept alongside so a truncation shows up at a glance. */
  | { kind: "user"; step: number; chars: number; text: string }
  | { kind: "mcp.stderr"; line: string }
  | { kind: "llm.request"; step: number; model: string; messages: number }
  | {
      kind: "llm.response";
      step: number;
      ms: number;
      finishReason: string;
      promptTokens: number;
      completionTokens: number;
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
      /** The `via: … · status` receipt line, if the result had one. */
      via: string | null;
      text: string;
    }
  | { kind: "warn"; step: number; code: string; message: string }
  /** Context saved by collapsing old tool bodies — never a silent behaviour. */
  | { kind: "prune"; step: number; savedTokens: number }
  | { kind: "error"; step: number; message: string; stack?: string }
  | { kind: "run.end"; ms: number; steps: number; reason: string };

export interface TraceMeta {
  seq: number;
  at: number;
  ts: string;
}
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
      this.sink.on("error", () => (this.sink = null));
    } catch {
      this.sink = null;
    }
  }

  emit(e: TraceBody): void {
    const now = Date.now();
    const full: TraceEvent = { ...e, seq: this.seq++, at: now - this.t0, ts: new Date(now).toISOString() };
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
