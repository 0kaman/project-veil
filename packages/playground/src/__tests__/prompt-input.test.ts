/**
 * The paste race, tested where it is actually visible.
 *
 * `ink-text-input` derived each new value from its `value` PROP, so when a large
 * paste arrived as several TTY chunks in one tick, the second chunk rebuilt from
 * the pre-paste value and the first was lost. A 3.5KB prompt reached the model
 * with whole contiguous blocks missing, which read as the model disobeying.
 * None of that is reachable from a test that must drive a real terminal — hence
 * a pure reducer.
 */
import { describe, it, expect } from "vitest";
import { applyKey, displayOf, EMPTY, type InputState } from "../ui/PromptInput.js";

/** Feed a sequence of [input, key] pairs, as Ink would. */
const feed = (
  events: Array<[string, Parameters<typeof applyKey>[2]]>,
  from: InputState = EMPTY,
): { state: InputState; submits: string[] } => {
  const submits: string[] = [];
  let state = from;
  for (const [input, key] of events) {
    const r = applyKey(state, input, key);
    state = r.state;
    if (r.submit !== undefined) submits.push(r.submit);
  }
  return { state, submits };
};

describe("applyKey — the paste path", () => {
  it("COMPOSES successive paste chunks instead of clobbering — the regression", () => {
    // Two chunks of one paste, back to back with no render between them.
    const { state } = feed([
      ["step 1 do a thing\nstep 2 do another\n", {}],
      ["step 3 finish\nstep 4 report", {}],
    ]);
    expect(state.value).toBe("step 1 do a thing\nstep 2 do another\nstep 3 finish\nstep 4 report");
    // every chunk survived
    expect(state.value.split("\n")).toHaveLength(4);
  });

  it("does NOT submit on a paste that merely contains newlines", () => {
    const { submits, state } = feed([["line one\nline two\nline three", {}]]);
    expect(submits).toEqual([]);
    expect(state.value).toContain("line three");
  });

  it("submits on a bare Return, and clears", () => {
    const { state, submits } = feed([
      ["hello", {}],
      ["\r", { return: true }],
    ]);
    expect(submits).toEqual(["hello"]);
    expect(state).toEqual(EMPTY);
  });

  it("keeps a pasted block's line structure, normalising CRLF", () => {
    const { state } = feed([["a\r\nb\rc", {}]]);
    expect(state.value).toBe("a\nb\nc");
  });

  it("survives a paste far larger than any terminal read", () => {
    const chunk = "x".repeat(4096);
    const { state } = feed([[chunk, {}], [chunk, {}], [chunk, {}]]);
    expect(state.value).toHaveLength(4096 * 3);
  });
});

describe("applyKey — ordinary editing still works", () => {
  it("inserts at the cursor, not just at the end", () => {
    const { state } = feed([
      ["abc", {}],
      ["", { leftArrow: true }],
      ["Z", {}],
    ]);
    expect(state.value).toBe("abZc");
  });

  it("backspaces at the cursor and stops at the start", () => {
    const { state } = feed([["ab", {}], ["", { backspace: true }], ["", { backspace: true }], ["", { backspace: true }]]);
    expect(state.value).toBe("");
    expect(state.cursor).toBe(0);
  });

  it("ctrl-u clears the line", () => {
    const { state } = feed([["some long thing", {}], ["u", { ctrl: true }]]);
    expect(state).toEqual(EMPTY);
  });

  it("clamps the cursor at both ends", () => {
    const { state } = feed([["ab", {}], ["", { rightArrow: true }], ["", { rightArrow: true }]]);
    expect(state.cursor).toBe(2);
  });
});

describe("displayOf — a multi-line value must not break the frame", () => {
  it("flattens newlines rather than rendering them", () => {
    expect(displayOf("a\nb")).not.toContain("\n");
  });

  it("tails a long value so the caret stays visible", () => {
    const out = displayOf("y".repeat(500), 40);
    expect(out.length).toBeLessThanOrEqual(40);
    expect(out.startsWith("…")).toBe(true);
  });
});
