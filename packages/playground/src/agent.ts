/**
 * The agent session: a persistent conversation that drives Veil.
 *
 * Message history lives here across turns, so the browser session, the graph
 * the model has seen, and its reasoning all carry forward — you can say "now
 * click sign in" and it knows what you mean. Each send() runs the tool loop
 * until the model answers in plain text.
 *
 * The UI is a sink, not a caller: this emits what happened and lets the view
 * decide how to draw it. Everything also goes to the Tracer, so a session can
 * be dissected after the fact.
 */
import type { Tracer, TurnOutcome } from "./trace.js";
import type { VeilMcp } from "./mcp.js";
import { Mistral, type ChatMessage } from "./mistral.js";
import { diffGraphs, parseGraph, type GraphStats } from "./graph-stats.js";

const SYSTEM_PROMPT = `You are driving a web browser through Veil, which exposes each page as a BEHAVIOR GRAPH instead of raw DOM.

Reading the graph:
- Each node line is: <display-id> [<role>] "<accessible name>"
- Indentation is containment. "on:<event> → <category>" is what a node DOES.
- "semantic: <category>:<action>" is Veil's guess at intent, with a confidence.
- Always act on a node's display id exactly as printed (e.g. button-sign-in).

Workflow:
1. veil_open a URL — returns a session id and the graph.
2. Pass that session id to every later call.
3. Use veil_query to locate nodes instead of re-reading the whole graph.
4. veil_do to click/type/select. It returns the UPDATED graph.
5. veil_replay fires a node's captured API request directly (fast), but only
   after veil_do has performed it once. It returns the API response, NOT a graph.

Rules:
- Never invent a node id. If an id is not in the graph, use veil_query to find the real one.
- If a tool returns an error, read it and adapt — do not retry the identical call.
- Keep replies short. The human sees every tool call, so do not narrate them.
- When the goal is met, reply with a brief plain-text answer and no tool call.`;

export type GateDecision = "go" | "always" | "abort";
export type StepGate = (pending: { name: string; args: unknown }) => Promise<GateDecision>;

export interface ToolStart {
  id: string;
  name: string;
  args: unknown;
}

export interface ToolEnd {
  id: string;
  ok: boolean;
  ms: number;
  text: string;
  /** Node count when the result was a behavior graph. */
  nodes: number | null;
}

/** How the session talks to the view. */
export interface UiSink {
  textDelta: (delta: string) => void;
  assistantDone: (text: string) => void;
  toolStart: (t: ToolStart) => void;
  toolEnd: (t: ToolEnd) => void;
  note: (text: string) => void;
  error: (text: string) => void;
}

export interface SessionDeps {
  tracer: Tracer;
  mcp: VeilMcp;
  llm: Mistral;
  gate: StepGate;
  ui: UiSink;
  maxSteps: number;
}

export class AgentSession {
  private messages: ChatMessage[] = [{ role: "system", content: SYSTEM_PROMPT }];
  private callCounts = new Map<string, number>();
  private lastGraph: GraphStats | null = null;
  private step = 0;
  private turn = 0;
  private aborted = false;

  constructor(private readonly deps: SessionDeps) {}

  /** Drop history but keep the MCP connection (and thus the browser). */
  reset(): void {
    this.messages = [{ role: "system", content: SYSTEM_PROMPT }];
    this.callCounts.clear();
    this.lastGraph = null;
  }

  interrupt(): void {
    this.aborted = true;
  }

  /** Run one user turn to completion: model → tools → … → plain-text answer. */
  async send(userText: string): Promise<void> {
    const { tracer, mcp, llm, gate, ui, maxSteps } = this.deps;
    this.messages.push({ role: "user", content: userText });
    this.aborted = false;

    this.turn++;
    const turnStart = Date.now();
    const stepsAtStart = this.step;
    let outcome: TurnOutcome = "answered";
    tracer.emit({ kind: "turn.start", turn: this.turn, text: userText });

    try {
      for (let i = 0; i < maxSteps; i++) {
        this.step++;

        let streamed = "";
        const res = await llm.chat(this.step, this.messages, mcp.toolSchemas(), (d) => {
          streamed += d;
          ui.textDelta(d);
        });

        if (res.content) ui.assistantDone(streamed || res.content);

        this.messages.push({
          role: "assistant",
          content: res.content,
          ...(res.toolCalls.length > 0 && { tool_calls: res.toolCalls }),
        });

        if (res.toolCalls.length === 0) {
          outcome = "answered";
          return;
        }

        for (const call of res.toolCalls) {
          if (this.aborted) {
            this.messages.push({
              role: "tool",
              name: call.function.name,
              tool_call_id: call.id,
              content: "[INTERRUPTED] The human stopped this call.",
            });
            ui.note("interrupted");
            outcome = "interrupted";
            return;
          }

          let args: unknown;
          try {
            args = JSON.parse(call.function.arguments || "{}");
          } catch {
            tracer.emit({
              kind: "warn",
              step: this.step,
              code: "BAD_TOOL_ARGS",
              message: `${call.function.name}: arguments were not valid JSON: ${call.function.arguments}`,
            });
            ui.note(`${call.function.name}: model sent invalid JSON arguments`);
            this.messages.push({
              role: "tool",
              name: call.function.name,
              tool_call_id: call.id,
              content: "[BAD_ARGS] Your arguments were not valid JSON. Re-send valid JSON.",
            });
            continue;
          }

          // Loop detection — identical call, identical args.
          const sig = `${call.function.name}:${JSON.stringify(args)}`;
          const seen = (this.callCounts.get(sig) ?? 0) + 1;
          this.callCounts.set(sig, seen);
          if (seen > 1) {
            tracer.emit({
              kind: "warn",
              step: this.step,
              code: "REPEATED_CALL",
              message: `${call.function.name} called with identical args ${seen}× — possible loop.`,
            });
            ui.note(`repeated call ×${seen} — ${call.function.name} may be looping`);
          }

          const decision = await gate({ name: call.function.name, args });
          if (decision === "abort") {
            this.messages.push({
              role: "tool",
              name: call.function.name,
              tool_call_id: call.id,
              content: "[DENIED] The human declined this call. Ask them what to do instead.",
            });
            ui.note("call declined");
            continue;
          }

          ui.toolStart({ id: call.id, name: call.function.name, args });
          const out = await mcp.call(this.step, call.id, call.function.name, args);

          if (!out.ok) {
            const code = out.text.match(/^\[([A-Z_]+)\]/)?.[1] ?? "TOOL_ERROR";
            tracer.emit({
              kind: "warn",
              step: this.step,
              code,
              message: `${call.function.name} failed: ${out.text.slice(0, 200)}`,
            });
          }

          const g = parseGraph(out.text);
          if (g.isGraph) {
            const delta = diffGraphs(this.lastGraph, g);
            tracer.emit({
              kind: "graph.observed",
              step: this.step,
              via: call.function.name,
              url: g.url,
              nodes: g.nodes,
              chars: g.chars,
              approxTokens: g.approxTokens,
              networkEdges: g.networkEdges,
              apis: g.apis,
              components: g.components,
              added: delta.added,
              removed: delta.removed,
            });
            this.lastGraph = g;
          }

          ui.toolEnd({
            id: call.id,
            ok: out.ok,
            ms: out.ms,
            text: out.text,
            nodes: g.isGraph ? g.nodes : null,
          });

          this.messages.push({
            role: "tool",
            name: call.function.name,
            tool_call_id: call.id,
            content: out.text,
          });
        }
      }

      outcome = "max-steps";
      ui.note(`hit max steps (${maxSteps})`);
    } catch (err) {
      outcome = "error";
      const message = err instanceof Error ? err.message : String(err);
      tracer.emit({
        kind: "error",
        step: this.step,
        message,
        stack: err instanceof Error ? err.stack : undefined,
      });
      ui.error(message);
    } finally {
      // Every exit path closes the turn — an unterminated turn would silently
      // drop the whole episode's accounting for it.
      tracer.emit({
        kind: "turn.end",
        turn: this.turn,
        ms: Date.now() - turnStart,
        steps: this.step - stepsAtStart,
        outcome,
      });
    }
  }
}
