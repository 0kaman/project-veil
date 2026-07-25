/**
 * The loop must not mistake "I'm about to" for "I'm done".
 *
 * Measured: a 16-step task ended at step 24 of a 60-step budget on the words
 * "Next: query session s2 for all buttons" — prose, no tool call, so the turn
 * was treated as complete and the task was abandoned with no report. Six
 * minutes of a real run wasted on a harness detail.
 */
import { describe, it, expect } from "vitest";
import { AgentSession, ANNOUNCES_A_STEP, type SessionDeps } from "../agent.js";

type Turn = { content: string; toolCalls: Array<{ id: string; function: { name: string; arguments: string } }> };

/** Drives the loop with a scripted sequence of model turns. */
function harness(turns: Turn[]) {
  const notes: string[] = [];
  const sent: string[] = [];
  let i = 0;
  const deps = {
    tracer: { emit: () => {} },
    mcp: { toolSchemas: () => [], call: async () => ({ ok: true, text: "did it" }) },
    llm: {
      chat: async (_s: number, messages: Array<{ role: string; content?: string }>) => {
        sent.push(messages[messages.length - 1]?.content ?? "");
        return turns[i++] ?? { content: "done.", toolCalls: [] };
      },
    },
    gate: async () => "go",
    ui: { textDelta: () => {}, assistantDone: () => {}, toolStart: () => {}, toolEnd: () => {}, note: (t: string) => notes.push(t), error: () => {} },
    maxSteps: 20,
  } as unknown as SessionDeps;
  return { session: new AgentSession(deps), notes, sent, calls: () => i };
}

const say = (content: string): Turn => ({ content, toolCalls: [] });
const act = (name: string): Turn => ({
  content: "",
  toolCalls: [{ id: "c1", function: { name, arguments: "{}" } }],
});

describe("ANNOUNCES_A_STEP", () => {
  it("matches the phrasings that actually stalled a run", () => {
    for (const s of [
      "Next: query session s2 for all buttons.",
      "Proceeding to step 7: replay the submission.",
      "I'll query for combobox elements to find the control.",
      "Let me check the remaining sessions.",
      "Now, I need to open the results page.",
    ]) {
      expect(ANNOUNCES_A_STEP.test(s), s).toBe(true);
    }
  });

  it("does NOT match a finished answer", () => {
    for (const s of [
      "The cheapest nonstop is IndiGo 6E-2043 at 4,812 rupees.",
      "Summary: every step worked as expected.",
      "I could not get a fare for that date; the site blocked the browser.",
    ]) {
      expect(ANNOUNCES_A_STEP.test(s), s).toBe(false);
    }
  });
});

describe("the loop", () => {
  it("NUDGES a model that announced a call without making it", async () => {
    const h = harness([say("Next: query session s2 for all buttons."), act("veil_query"), say("Done — 3 matches.")]);
    await h.session.send("do the thing");
    expect(h.notes.some((n) => /nudged/i.test(n))).toBe(true);
    // it went on to make the call, rather than stopping at step 1
    expect(h.calls()).toBe(3);
    expect(h.sent.some((m) => /did not call the tool/i.test(m))).toBe(true);
  });

  it("stops immediately on a real answer — no wasted call", async () => {
    const h = harness([say("The cheapest nonstop is IndiGo 6E-2043 at 4,812 rupees.")]);
    await h.session.send("find the fare");
    expect(h.notes.some((n) => /nudged/i.test(n))).toBe(false);
    expect(h.calls()).toBe(1);
  });

  it("gives up after MAX_NUDGES rather than looping forever", async () => {
    const h = harness([say("Next: I'll look."), say("Next: I'll look."), say("Next: I'll look."), say("Next: I'll look.")]);
    await h.session.send("go");
    expect(h.notes.filter((n) => /nudged/i.test(n))).toHaveLength(2);
    expect(h.calls()).toBe(3); // two nudges, then it is taken at its word
  });
});
