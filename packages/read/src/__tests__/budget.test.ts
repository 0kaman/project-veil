/**
 * The word budget must always CUT. (Defect found during the non-HTML
 * investigation; it is independent of it and reproduces on pure HTML today.)
 *
 * `truncateToParagraphs` breaks on `\n\n` and refuses to cut when nothing has
 * been kept yet (`&& kept.length > 0`); `HandleStore.pull` has the identical
 * hole (`&& out.length > 0`). So a body that is ONE paragraph is returned whole,
 * under a receipt that says `truncated: true` with `words === totalWords` — a
 * receipt contradicting itself, and 805 KB of text going inline into a model's
 * context. Measured on the session path at 7,500 / 7,500 words.
 */
import { describe, it, expect } from "vitest";
import { Reader, HandleStore } from "../index.js";

const page = (body: string) =>
  `<!doctype html><html><head><title>T</title></head><body>${body}</body></html>`;

describe("the budget always cuts — one paragraph is not an exemption", () => {
  it("a single 6,000-word block is actually truncated, not just labelled truncated", () => {
    // Today: {words: 7500, totalWords: 7500, truncated: true} — the receipt
    // says it cut and it did not. Pure HTML, session path, no media types.
    const reader = new Reader({ config: { budgetWords: 500 } });
    const r = reader.readHtml(page(`<div>${"filler ".repeat(6000)}</div>`), "https://f.test/s");

    expect(r.receipt.truncated).toBe(true);
    expect(r.receipt.totalWords).toBeGreaterThan(5000);
    // The two assertions the current code cannot satisfy:
    expect(r.receipt.words).toBeLessThan(r.receipt.totalWords);
    expect(r.receipt.words).toBeLessThanOrEqual(600);
  });

  it("the returned text is honestly measured — words matches what came back", () => {
    const reader = new Reader({ config: { budgetWords: 500 } });
    const r = reader.readHtml(page(`<div>${"filler ".repeat(6000)}</div>`), "https://f.test/s");
    const actual = r.text.trim().split(/\s+/).length;
    expect(Math.abs(actual - r.receipt.words)).toBeLessThanOrEqual(2);
  });

  it("says plainly when it had to cut mid-paragraph", () => {
    const reader = new Reader({ config: { budgetWords: 500 } });
    const r = reader.readHtml(page(`<div>${"filler ".repeat(6000)}</div>`), "https://f.test/s");
    expect(r.receipt.note ?? "").toMatch(/mid-paragraph|hard cut/i);
  });

  it("names the limit that actually bound, not a plausible-sounding one", () => {
    // Caught live on rfc7231.txt: the receipt read "this body has no paragraph
    // breaks to cut on" about a document made almost entirely of paragraph
    // breaks. It was the CHARACTER ceiling that bound. A receipt that misnames
    // its own reason is the same defect class as one that misreports its status.
    const paras = Array.from({ length: 200 }, (_, i) => `Paragraph ${i}. ${"word ".repeat(40)}`).join("\n\n");
    const reader = new Reader({ config: { budgetWords: 100_000, budgetChars: 4000 } });
    const r = reader.readHtml(page(paras.split("\n\n").map((p) => `<p>${p}</p>`).join("")), "https://f.test/s");

    expect(r.receipt.truncated).toBe(true);
    expect(r.text.length).toBeLessThanOrEqual(4000);
    expect(r.receipt.note ?? "").toMatch(/character ceiling/);
    expect(r.receipt.note ?? "").not.toMatch(/no paragraph breaks/);
  });

  it("a character ceiling holds even when the WORD count looks small", () => {
    // Minified JSON is ~10k whitespace-"words" for 805 KB. Word counting is
    // meaningless there, so chars need their own ceiling.
    const monster = Array.from({ length: 20 }, () => "x".repeat(20_000)).join(" ");
    const reader = new Reader({ config: { budgetWords: 4000, budgetChars: 8000 } });
    const r = reader.readHtml(page(`<div>${monster}</div>`), "https://f.test/s");
    expect(r.text.length).toBeLessThanOrEqual(8000);
    expect(r.receipt.truncated).toBe(true);
  });
});

describe("HandleStore.pull — the second, independent site of the same hole", () => {
  const store = () => {
    const s = new HandleStore();
    const id = s.put({
      url: "https://f.test/s",
      title: "T",
      fullText: `${"filler ".repeat(5000)}`.trim(),
      outline: [],
    });
    return { s, id };
  };

  it("respects the budget on a single-paragraph stored read", () => {
    const { s, id } = store();
    const pull = s.pull(id, undefined, 200)!;
    expect(pull.totalWords).toBe(5000);
    expect(pull.words).toBeLessThanOrEqual(250);
    expect(pull.text.length).toBeLessThan(s.get(id)!.fullText.length);
  });

  it("says it cut rather than returning a silently partial paragraph", () => {
    const { s, id } = store();
    const pull = s.pull(id, undefined, 200)!;
    expect(pull.note ?? "").toMatch(/mid-paragraph|hard cut|of \d+/i);
  });

  it("a query hit that is itself over budget is cut, not returned whole", () => {
    const s = new HandleStore();
    const id = s.put({
      url: "https://f.test/s",
      title: "T",
      fullText: `short intro\n\nTLS ${"filler ".repeat(5000)}`,
      outline: [],
    });
    const pull = s.pull(id, "TLS", 200)!;
    expect(pull.matched).toBe(1);
    expect(pull.words).toBeLessThanOrEqual(250);
  });
});
