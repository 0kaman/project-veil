/**
 * History pruning — stop paying for the same page on every turn.
 *
 * Measured on the run that answered the fare task: context grew 2,240 → 41,361
 * tokens over 52 calls, and the turn-by-turn resend billed **1,561,545** prompt
 * tokens. Held flat it would have been ~116,000. So ~1.44M — 93% of the spend —
 * was history, and `veil_read` bodies were 70% of the tool output feeding it:
 *
 *     veil_read    90,377 chars      veil_do      4,658
 *     veil_search  18,521            veil_open    3,846
 *     veil_query   13,565            veil_close       9
 *
 * The fix is already in the architecture. A truncated read returns a HANDLE
 * precisely so its text can be re-pulled, so a read body sitting in turn 7's
 * history is redundant by turn 40 — the agent can call veil_read("r1", query)
 * and get it back. Old bodies collapse to their receipt plus a pointer.
 *
 * Two rules keep this safe:
 *   - the RECEIPT always survives. It carries via/status/words/handle, which is
 *     what the agent reasons about; dropping it would hide a degradation, which
 *     is the one thing this project refuses to do.
 *   - a tool message is never REMOVED, only rewritten. Every tool_call_id in an
 *     assistant turn must still have a matching tool response or the request is
 *     malformed.
 */
import type { ChatMessage } from "./mistral.js";

export interface PruneOptions {
  /** Most recent tool results to leave untouched — the agent is still reasoning
   * about what it just saw. */
  keepRecent?: number;
  /** Only prune a body longer than this; below it the receipt costs as much. */
  minChars?: number;
}

const DEFAULTS = { keepRecent: 3, minChars: 400 };

/** `via: fetch · 743ms · ok · 3949 of 7418 words · handle r1` → the handle. */
function handleOf(text: string): string | null {
  return /·\s*handle\s+(r\d+)/.exec(text)?.[1] ?? null;
}

/** The receipt is the first line: path, cost, status, and what's missing. */
function receiptOf(text: string): string {
  const nl = text.indexOf("\n");
  return nl === -1 ? text : text.slice(0, nl);
}

function collapse(text: string): string {
  const receipt = receiptOf(text);
  const handle = handleOf(text);
  const dropped = text.length - receipt.length;
  return handle
    ? `${receipt}\n[body dropped from history to save context — re-read it with ` +
        `veil_read("${handle}", query: "…") if you still need it]`
    : `${receipt}\n[body dropped from history to save context (${dropped} chars) — ` +
        `call this tool again if you still need it]`;
}

/**
 * Collapse old, large tool results to their receipts. Pure — same input, same
 * output — so the saving can be measured against a recorded conversation
 * instead of guessed at from a live run.
 */
export function pruneHistory(messages: ChatMessage[], opts: PruneOptions = {}): ChatMessage[] {
  const keepRecent = opts.keepRecent ?? DEFAULTS.keepRecent;
  const minChars = opts.minChars ?? DEFAULTS.minChars;

  // Which tool messages are recent enough to keep whole?
  const toolIdx: number[] = [];
  for (let i = 0; i < messages.length; i++) if (messages[i]!.role === "tool") toolIdx.push(i);
  const spared = new Set(toolIdx.slice(-keepRecent));

  return messages.map((m, i) => {
    if (m.role !== "tool" || spared.has(i)) return m;
    if (m.content.length <= minChars) return m;
    const collapsed = collapse(m.content);
    // Never grow a message by "saving" it.
    return collapsed.length >= m.content.length ? m : { ...m, content: collapsed };
  });
}

/** Rough token count — 4 chars/token, good enough to compare two histories. */
export function approxTokens(messages: ChatMessage[]): number {
  let chars = 0;
  for (const m of messages) {
    chars += (m.content ?? "").length;
    if (m.role === "assistant" && m.tool_calls) {
      for (const c of m.tool_calls) chars += c.function.name.length + c.function.arguments.length;
    }
  }
  return Math.ceil(chars / 4);
}
