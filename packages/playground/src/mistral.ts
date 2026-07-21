/**
 * Mistral chat-completions client (plain fetch, streaming). Assistant text lands
 * token-by-token; tool-call deltas arrive fragmented and index-keyed, so they're
 * reassembled here and handed up whole — the agent loop never sees a partial
 * call. Real token usage from the API is traced, so the cost display is truth,
 * not an estimate.
 */
import type { Tracer } from "./trace.js";
import type { ToolSchema } from "./mcp.js";

const ENDPOINT = "https://api.mistral.ai/v1/chat/completions";

/**
 * A content delta is usually a string — but when the model cites its sources,
 * Mistral streams content-chunk arrays with reference OBJECTS mixed in. Doing
 * `content += obj` yields the literal "[object Object]" in the answer (observed
 * on a protest-news query, 8 times). So: pass strings through, pull text out of
 * chunk arrays, and drop reference/citation objects — they aren't display text.
 */
export function deltaText(raw: unknown): string {
  if (typeof raw === "string") return raw;
  if (Array.isArray(raw)) {
    return raw
      .map((c) => {
        if (typeof c === "string") return c;
        if (c && typeof c === "object" && (c as { type?: string }).type === "text") {
          return String((c as { text?: unknown }).text ?? "");
        }
        return ""; // reference / image_url / other non-text chunk
      })
      .join("");
  }
  return ""; // a bare reference object
}

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

export interface ChatResult {
  content: string | null;
  toolCalls: AssistantToolCall[];
  finishReason: string;
  promptTokens: number;
  completionTokens: number;
  ms: number;
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
    onTextDelta?: (d: string) => void,
  ): Promise<ChatResult> {
    this.tracer.emit({ kind: "llm.request", step, model: this.model, messages: messages.length });
    const t0 = Date.now();

    const res = await fetch(ENDPOINT, {
      method: "POST",
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
      throw new Error(`Mistral ${res.status} ${res.statusText}: ${body.slice(0, 300)}`);
    }

    let content = "";
    let finishReason = "stop";
    let promptTokens = 0;
    let completionTokens = 0;
    const acc = new Map<number, { id: string; name: string; args: string }>();

    const decoder = new TextDecoder();
    let buffer = "";
    for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
      buffer += decoder.decode(chunk, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const raw of lines) {
        const line = raw.trim();
        if (!line.startsWith("data:")) continue;
        const payload = line.slice(5).trim();
        if (payload === "[DONE]") continue;
        let evt: {
          // content is typed unknown on purpose: usually a string, but the API
          // also sends content-chunk arrays and reference objects. See deltaText.
          choices?: { delta?: { content?: unknown; tool_calls?: unknown[] }; finish_reason?: string | null }[];
          usage?: { prompt_tokens?: number; completion_tokens?: number };
        };
        try {
          evt = JSON.parse(payload);
        } catch {
          continue;
        }
        if (evt.usage) {
          promptTokens = evt.usage.prompt_tokens ?? promptTokens;
          completionTokens = evt.usage.completion_tokens ?? completionTokens;
        }
        const choice = evt.choices?.[0];
        if (!choice) continue;
        if (choice.finish_reason) finishReason = choice.finish_reason;
        const t = deltaText(choice.delta?.content);
        if (t) {
          content += t;
          onTextDelta?.(t);
        }
        for (const rawCall of choice.delta?.tool_calls ?? []) {
          const cc = rawCall as { index?: number; id?: string; function?: { name?: string; arguments?: string } };
          const idx = cc.index ?? 0;
          const cur = acc.get(idx) ?? { id: "", name: "", args: "" };
          if (cc.id) cur.id = cc.id;
          if (cc.function?.name) cur.name = cc.function.name;
          if (cc.function?.arguments) cur.args += cc.function.arguments;
          acc.set(idx, cur);
        }
      }
    }

    const ms = Date.now() - t0;
    const toolCalls: AssistantToolCall[] = [...acc.entries()]
      .sort(([a], [b]) => a - b)
      .map(([, c]) => ({ id: c.id, type: "function" as const, function: { name: c.name, arguments: c.args } }))
      .filter((c) => c.function.name);

    this.tracer.emit({
      kind: "llm.response",
      step,
      ms,
      finishReason,
      promptTokens,
      completionTokens,
      content: content || null,
      toolCalls: toolCalls.map((c) => ({ id: c.id, name: c.function.name, args: c.function.arguments })),
    });

    return { content: content || null, toolCalls, finishReason, promptTokens, completionTokens, ms };
  }
}
