import { describe, it, expect } from "vitest";
import { deltaText } from "../mistral.js";

/**
 * Regression for the "[object Object]" bug (2026-07-21): when the model cites its
 * sources, Mistral streams reference OBJECTS in the content, and `content += obj`
 * rendered the literal "[object Object]" into the answer 8 times. The invariant:
 * deltaText extracts display text and NEVER emits an object stringification.
 */
describe("deltaText", () => {
  it("passes a plain string through", () => {
    expect(deltaText("hello")).toBe("hello");
  });

  it("extracts text from a content-chunk array", () => {
    expect(deltaText([{ type: "text", text: "a" }, { type: "text", text: "b" }])).toBe("ab");
  });

  it("drops a reference object mixed into a chunk array — keeps only the text", () => {
    const raw = [{ type: "text", text: "see Delhi" }, { type: "reference", reference_ids: [1] }];
    expect(deltaText(raw)).toBe("see Delhi");
  });

  it("drops a bare reference object entirely", () => {
    expect(deltaText({ type: "reference", reference_ids: [2, 3] })).toBe("");
  });

  it("null / undefined → empty string", () => {
    expect(deltaText(null)).toBe("");
    expect(deltaText(undefined)).toBe("");
  });

  it("NEVER produces [object Object] for any object-ish input", () => {
    for (const raw of [{ x: 1 }, [{ foo: "bar" }], [{}], { type: "image_url" }]) {
      expect(deltaText(raw)).not.toContain("[object Object]");
    }
  });
});
