/**
 * Mistral chat-completions client (plain fetch — no SDK).
 *
 * Matches @veil/core's zero-dependency ethos, and the wire format is small
 * enough that owning it is cheaper than owning a dependency.
 *
 * Streams via SSE so assistant text lands token-by-token — without that the UI
 * reads as a series of freezes rather than a conversation. Tool-call deltas
 * arrive fragmented and index-keyed, so they're reassembled here and handed up
 * whole; the agent loop never sees a partial call.
 */
import type { Tracer } from "./trace.js";
import type { ToolSchema } from "./mcp.js";
import { approxTokens } from "./graph-stats.js";

const ENDPOINT = "https://api.mistral.ai/v1/chat/completions";

export interface AssistantToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export type ChatMessage =
  | { role: "system"; content: string }
  | { role: "user"; content: string }
  | { role: "assistant"; content: string | null; tool_calls?: AssistantToolCall[] }
  | { role: "tool"; name: string; tool_call_id: string; content: string };

export interface Usage {
  promptTokens: number;
  completionTokens: number;
  cachedTokens: number;
}

export interface ChatResult {
  content: string | null;
  toolCalls: AssistantToolCall[];
  finishReason: string;
  usage: Usage;
  ms: number;
}

interface ToolCallAccumulator {
  id: string;
  name: string;
  args: string;
}

export class Mistral {
  constructor(
    private readonly apiKey: string,
    private readonly model: string,
    private readonly tracer: Tracer,
  ) {}

  async chat(
    step: number,
    messages: ChatMessage[],
    tools: ToolSchema[],
    onTextDelta?: (delta: string) => void,
    signal?: AbortSignal,
  ): Promise<ChatResult> {
    this.tracer.emit({
      kind: "llm.request",
      step,
      model: this.model,
      messages: messages.length,
      toolsOffered: tools.length,
      approxPromptTokens: approxTokens(
        messages.map((m) => ("content" in m ? (m.content ?? "") : "")).join(""),
      ),
    });

    const t0 = Date.now();
    const res = await fetch(ENDPOINT, {
      method: "POST",
      signal,
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
        Accept: "text/event-stream",
      },
      body: JSON.stringify({
        model: this.model,
        messages,
        tools: tools.map((t) => ({
          type: "function",
          function: { name: t.name, description: t.description, parameters: t.parameters },
        })),
        tool_choice: "auto",
        temperature: 0,
        stream: true,
      }),
    });

    if (!res.ok || !res.body) {
      const body = await res.text().catch(() => "");
      throw new Error(`Mistral ${res.status} ${res.statusText}: ${body.slice(0, 400)}`);
    }

    let content = "";
    let finishReason = "stop";
    const usage: Usage = { promptTokens: 0, completionTokens: 0, cachedTokens: 0 };
    // Keyed by the delta's `index` — fragments of one call arrive across chunks.
    const acc = new Map<number, ToolCallAccumulator>();

    const decoder = new TextDecoder();
    let buffer = "";

    for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
      buffer += decoder.decode(chunk, { stream: true });

      // SSE frames are newline-delimited; the tail may be a partial line.
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";

      for (const raw of lines) {
        const line = raw.trim();
        if (!line.startsWith("data:")) continue;
        const payload = line.slice(5).trim();
        if (payload === "[DONE]") continue;

        let evt: {
          choices?: {
            delta?: { content?: string | null; tool_calls?: unknown[] };
            finish_reason?: string | null;
          }[];
          usage?: {
            prompt_tokens?: number;
            completion_tokens?: number;
            prompt_tokens_details?: { cached_tokens?: number };
          };
        };
        try {
          evt = JSON.parse(payload);
        } catch {
          continue; // a malformed frame must not kill the turn
        }

        if (evt.usage) {
          usage.promptTokens = evt.usage.prompt_tokens ?? usage.promptTokens;
          usage.completionTokens = evt.usage.completion_tokens ?? usage.completionTokens;
          usage.cachedTokens =
            evt.usage.prompt_tokens_details?.cached_tokens ?? usage.cachedTokens;
        }

        const choice = evt.choices?.[0];
        if (!choice) continue;
        if (choice.finish_reason) finishReason = choice.finish_reason;

        const text = choice.delta?.content;
        if (text) {
          content += text;
          onTextDelta?.(text);
        }

        for (const rawCall of choice.delta?.tool_calls ?? []) {
          const c = rawCall as {
            index?: number;
            id?: string;
            function?: { name?: string; arguments?: string };
          };
          const idx = c.index ?? 0;
          const cur = acc.get(idx) ?? { id: "", name: "", args: "" };
          if (c.id) cur.id = c.id;
          if (c.function?.name) cur.name = c.function.name;
          if (c.function?.arguments) cur.args += c.function.arguments;
          acc.set(idx, cur);
        }
      }
    }

    const ms = Date.now() - t0;
    const toolCalls: AssistantToolCall[] = [...acc.entries()]
      .sort(([a], [b]) => a - b)
      .map(([, c]) => ({
        id: c.id,
        type: "function" as const,
        function: { name: c.name, arguments: c.args },
      }))
      .filter((c) => c.function.name);

    this.tracer.emit({
      kind: "llm.response",
      step,
      ms,
      finishReason,
      promptTokens: usage.promptTokens,
      completionTokens: usage.completionTokens,
      cachedTokens: usage.cachedTokens,
      content: content || null,
      toolCalls: toolCalls.map((c) => ({
        id: c.id,
        name: c.function.name,
        args: c.function.arguments,
      })),
    });

    return { content: content || null, toolCalls, finishReason, usage, ms };
  }
}
