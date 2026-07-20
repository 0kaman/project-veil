import { describe, it, expect } from "vitest";
import {
  countWords,
  fallbackExtract,
  getOutline,
  readabilityExtract,
} from "../extract.js";
import { fixture } from "./helpers.js";

describe("readabilityExtract", () => {
  it("extracts a clean article with its title and paragraphs", () => {
    const { title, text } = readabilityExtract(fixture("clean-article"));
    expect(title).toMatch(/Understanding HTTP/);
    expect(countWords(text)).toBeGreaterThan(250);
    // boilerplate must not survive
    expect(text).not.toMatch(/All rights reserved/);
    expect(text).not.toMatch(/analytics/);
    // paragraph structure preserved
    expect(text).toContain("\n\n");
  });

  it("keeps almost nothing on the REAL geeksforgeeks page (the 2026-07-19 miss)", () => {
    // A real page captured from the probe. Readability returned 0 words on it
    // against 1,334 raw. This is a golden regression file, not a synthetic — if
    // Readability ever starts handling it, the fallback test below stops
    // exercising a real gap and we should know.
    const { text } = readabilityExtract(fixture("real-extract-miss"));
    expect(countWords(text)).toBeLessThan(150);
  });
});

describe("fallbackExtract", () => {
  it("rescues the real page Readability dropped (the geeksforgeeks case)", () => {
    const { text } = fallbackExtract(fixture("real-extract-miss"));
    expect(countWords(text)).toBeGreaterThan(400);
    expect(text).toMatch(/retrieval|augmented|generation/i);
  });
});

describe("getOutline", () => {
  it("returns section headings in order", () => {
    const outline = getOutline(fixture("clean-article"));
    expect(outline).toContain("Requests and responses");
    expect(outline).toContain("Statelessness");
    expect(outline).toContain("Encryption");
  });
});
