/**
 * Pruning must save context without lying about what happened.
 *
 * The saving is real — 93% of the fare run's 1.56M prompt tokens was re-sent
 * history — but a pruner that drops a receipt, or drops a tool message outright,
 * breaks something worse than it fixes.
 */
import { describe, it, expect } from "vitest";
import { pruneHistory, approxTokens } from "../prune.js";
import type { ChatMessage } from "../mistral.js";

const body = (n: number) => "word ".repeat(n).trim();

const read = (handle: string | null, words = 400): ChatMessage => ({
  role: "tool",
  name: "veil_read",
  tool_call_id: `c-${handle ?? "none"}`,
  content:
    `via: fetch · 743ms · ok · 3949 of 7418 words${handle ? ` · handle ${handle}` : ""}\n` +
    `title: Something\n\n${body(words)}`,
});

const asst = (id: string): ChatMessage => ({
  role: "assistant",
  content: null,
  tool_calls: [{ id, type: "function", function: { name: "veil_read", arguments: "{}" } }],
} as ChatMessage);

/** A conversation with `n` reads, oldest first. */
const convo = (n: number): ChatMessage[] => {
  const out: ChatMessage[] = [
    { role: "system", content: "sys" },
    { role: "user", content: "find the fare" },
  ];
  for (let i = 0; i < n; i++) {
    out.push(asst(`c-r${i}`));
    out.push({ ...read(`r${i}`), tool_call_id: `c-r${i}` } as ChatMessage);
  }
  return out;
};

describe("pruneHistory — what it must never break", () => {
  it("keeps every tool message — a missing tool_call_id is a malformed request", () => {
    const before = convo(8);
    const after = pruneHistory(before);
    expect(after).toHaveLength(before.length);
    const ids = (ms: ChatMessage[]) => ms.filter((m) => m.role === "tool").map((m) => m.tool_call_id);
    expect(ids(after)).toEqual(ids(before));
  });

  it("KEEPS the receipt — dropping it would hide a degradation", () => {
    const after = pruneHistory(convo(8));
    for (const m of after) {
      if (m.role !== "tool") continue;
      expect(m.content).toContain("via: fetch");
      expect(m.content).toMatch(/3949 of 7418 words/);
    }
  });

  it("points at the handle, so the body is genuinely recoverable", () => {
    const after = pruneHistory(convo(8));
    const oldest = after.find((m) => m.role === "tool")!;
    expect(oldest.content).toMatch(/veil_read\("r0"/);
    expect(oldest.content).not.toContain("word word word");
  });

  it("leaves the most RECENT results whole — that is what is being reasoned about", () => {
    const after = pruneHistory(convo(8), { keepRecent: 3 });
    const tools = after.filter((m) => m.role === "tool");
    for (const m of tools.slice(-3)) expect(m.content).toContain("word word");
    for (const m of tools.slice(0, -3)) expect(m.content).not.toContain("word word");
  });

  it("never grows a message it claims to be saving", () => {
    const small: ChatMessage[] = [
      { role: "system", content: "s" },
      { role: "tool", name: "veil_close", tool_call_id: "c1", content: "closed s1" },
      { role: "tool", name: "veil_query", tool_call_id: "c2", content: "via: engine · 0 matches" },
      { role: "tool", name: "veil_do", tool_call_id: "c3", content: "via: engine · ok" },
      { role: "tool", name: "veil_do", tool_call_id: "c4", content: "via: engine · ok" },
    ];
    const after = pruneHistory(small, { keepRecent: 0 });
    for (let i = 0; i < small.length; i++) {
      expect(after[i]!.content!.length).toBeLessThanOrEqual(small[i]!.content!.length);
    }
  });

  it("says how to recover a body that had no handle", () => {
    const ms: ChatMessage[] = [
      { role: "system", content: "s" },
      { role: "tool", name: "veil_query", tool_call_id: "c1", content: `via: engine · 380 matches\n${body(400)}` },
      { role: "tool", name: "veil_do", tool_call_id: "c2", content: "ok" },
    ];
    const after = pruneHistory(ms, { keepRecent: 1 });
    expect(after[1]!.content).toContain("380 matches");
    expect(after[1]!.content).toMatch(/call this tool again/);
  });

  it("does not touch user or assistant turns — the plan has to survive", () => {
    const before = convo(6);
    const after = pruneHistory(before);
    for (let i = 0; i < before.length; i++) {
      if (before[i]!.role === "tool") continue;
      expect(after[i]).toEqual(before[i]);
    }
  });

  it("is pure — the input array is not mutated", () => {
    const before = convo(6);
    const snapshot = JSON.stringify(before);
    pruneHistory(before);
    expect(JSON.stringify(before)).toBe(snapshot);
  });
});

describe("pruneHistory — the saving", () => {
  it("cuts a read-heavy history substantially", () => {
    const before = convo(20);
    const saved = 1 - approxTokens(pruneHistory(before)) / approxTokens(before);
    expect(saved).toBeGreaterThan(0.5);
  });

  it("saves nothing on a history with no big bodies, and does no harm", () => {
    const ms: ChatMessage[] = [
      { role: "system", content: "s" },
      { role: "user", content: "hi" },
      { role: "tool", name: "veil_do", tool_call_id: "c1", content: "via: engine · ok" },
    ];
    expect(pruneHistory(ms)).toEqual(ms);
  });
});
