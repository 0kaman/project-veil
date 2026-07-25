/**
 * The agent session: goal → Mistral → veil_* tool calls → results → repeat, over
 * the real MCP server. A persistent conversation so you can follow up ("now read
 * the second one"). The UI is a sink — this emits what happens and lets the view
 * draw it; everything also hits the Tracer.
 *
 * The system prompt teaches the ladder, because the ladder is the product: search
 * first, read before booting anything, and STOP when a receipt says the page
 * needs a browser (which doesn't exist yet).
 */
import type { Tracer } from "./trace.js";
import type { VeilMcp } from "./mcp.js";
import { Mistral, type ChatMessage } from "./mistral.js";

const SYSTEM_PROMPT = `You are a research agent. You answer by finding and reading real web pages, never from memory alone.

Your tools, in the order you should reach for them:
1. veil_search(query) — search the web. USE THIS FIRST. The snippets alone often answer a question.
2. veil_read(url) — read a page's actual text. Use it on a search result when a snippet isn't enough.
   - A long page is truncated and returns a handle like "r1". Call veil_read("r1", query: "topic") to pull a specific part.
   - If a read comes back JS-SHELL or DOORMAN, that page needs a browser, which is NOT available yet. Do not retry it — pick another source.

Every tool result begins with a receipt line ("via: … · status · …"). Read it: it tells you what you got and what you didn't. Trust it.

Rules:
- Ground every claim in something a tool actually returned. If the tools couldn't get it, say so plainly — never fill the gap from memory.
- Keep replies short; the human sees every tool call, so don't narrate them.
- When you have the answer, reply in plain text with no tool call.`;

export type GateDecision = "go" | "always" | "abort";
export type StepGate = (pending: { name: string; args: unknown }) => Promise<GateDecision>;

export interface ToolEnd {
  id: string;
  ok: boolean;
  ms: number;
  text: string;
  via: string | null;
}

export interface UiSink {
  textDelta: (d: string) => void;
  assistantDone: (text: string) => void;
  toolStart: (t: { id: string; name: string; args: unknown }) => void;
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

/** Phrasings that mean "I am about to act", not "I am done". Kept narrow: a
 * false positive costs one extra LLM call, a false negative abandons the task. */
export const ANNOUNCES_A_STEP = /\b(next|now)\b\s*[:,-]|\bi(?:'ll| will| am going to| need to)\b|\blet me\b|\bproceeding to\b/i;
const MAX_NUDGES = 2;

export class AgentSession {
  private messages: ChatMessage[] = [{ role: "system", content: SYSTEM_PROMPT }];
  private callCounts = new Map<string, number>();
  private step = 0;
  private aborted = false;
  private nudges = 0;

  constructor(private readonly deps: SessionDeps) {}

  reset(): void {
    this.messages = [{ role: "system", content: SYSTEM_PROMPT }];
    this.callCounts.clear();
  }

  interrupt(): void {
    this.aborted = true;
  }

  async send(userText: string): Promise<void> {
    const { tracer, mcp, llm, gate, ui, maxSteps } = this.deps;
    // Trace the turn VERBATIM before anything can transform it — this is the
    // record that makes "did it get the whole prompt?" answerable.
    tracer.emit({ kind: "user", step: this.step + 1, chars: userText.length, text: userText });
    this.messages.push({ role: "user", content: userText });
    this.aborted = false;
    this.nudges = 0; // per turn, not per session

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
          // The model sometimes ANNOUNCES its next call instead of making it.
          // Measured: a run ended at step 24 of 60 on "Next: query session s2
          // for all buttons" — no tool call, so the turn was treated as over and
          // the task was abandoned mid-way with no report. Nudge once or twice;
          // if it still will not call, it really is finished.
          if (this.nudges < MAX_NUDGES && ANNOUNCES_A_STEP.test(res.content ?? streamed)) {
            this.nudges++;
            tracer.emit({
              kind: "warn",
              step: this.step,
              code: "ANNOUNCED_NO_CALL",
              message: (res.content ?? streamed).slice(0, 160),
            });
            this.messages.push({
              role: "user",
              content:
                "You described a next step but did not call the tool. If the task is " +
                "genuinely finished, give your final answer now. Otherwise make that call.",
            });
            ui.note(`nudged — said what it would do without doing it (${this.nudges}/${MAX_NUDGES})`);
            continue;
          }
          return;
        }

        for (const call of res.toolCalls) {
          if (this.aborted) {
            this.messages.push({ role: "tool", name: call.function.name, tool_call_id: call.id, content: "[INTERRUPTED]" });
            ui.note("interrupted");
            return;
          }

          let args: unknown;
          try {
            args = JSON.parse(call.function.arguments || "{}");
          } catch {
            tracer.emit({ kind: "warn", step: this.step, code: "BAD_TOOL_ARGS", message: `${call.function.name}: ${call.function.arguments}` });
            ui.note(`${call.function.name}: invalid JSON arguments`);
            this.messages.push({ role: "tool", name: call.function.name, tool_call_id: call.id, content: "[BAD_ARGS] Re-send valid JSON." });
            continue;
          }

          // Loop detection — identical call, identical args.
          const sig = `${call.function.name}:${JSON.stringify(args)}`;
          const seen = (this.callCounts.get(sig) ?? 0) + 1;
          this.callCounts.set(sig, seen);
          if (seen > 1) {
            tracer.emit({ kind: "warn", step: this.step, code: "REPEATED_CALL", message: `${call.function.name} ×${seen}` });
            ui.note(`repeated call ×${seen} — ${call.function.name} may be looping`);
          }

          const decision = await gate({ name: call.function.name, args });
          if (decision === "abort") {
            this.messages.push({ role: "tool", name: call.function.name, tool_call_id: call.id, content: "[DENIED] The human declined this. Ask what to do instead." });
            ui.note("call declined");
            continue;
          }

          ui.toolStart({ id: call.id, name: call.function.name, args });
          const out = await mcp.call(this.step, call.id, call.function.name, args);
          if (!out.ok) {
            const code = out.text.match(/^\[([A-Z_]+)\]/)?.[1] ?? "TOOL_ERROR";
            tracer.emit({ kind: "warn", step: this.step, code, message: out.text.slice(0, 160) });
          }
          ui.toolEnd({ id: call.id, ok: out.ok, ms: out.ms, text: out.text, via: out.via });
          this.messages.push({ role: "tool", name: call.function.name, tool_call_id: call.id, content: out.text });
        }
      }
      ui.note(`hit max steps (${maxSteps})`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      tracer.emit({ kind: "error", step: this.step, message, stack: err instanceof Error ? err.stack : undefined });
      ui.error(message);
    }
  }
}
