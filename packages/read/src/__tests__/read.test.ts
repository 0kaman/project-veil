import { describe, it, expect } from "vitest";
import { Reader } from "../index.js";
import { fixture, mockFetch, failingFetch } from "./helpers.js";

const read = (name: string, fetchOpts?: { status?: number; url?: string }) =>
  new Reader({ fetchImpl: mockFetch(fixture(name), fetchOpts) }).read(`https://x.test/${name}`);

describe("read — classification", () => {
  it("clean article → ok, readability, not truncated", async () => {
    const r = await read("clean-article");
    expect(r.receipt.status).toBe("ok");
    expect(r.receipt.extractor).toBe("readability");
    expect(r.receipt.truncated).toBe(false);
    expect(r.handle).toBeNull();
    expect(r.title).toMatch(/Understanding HTTP/);
    expect(r.text).toMatch(/stateless/i);
  });

  it("real geeksforgeeks page → ok via the FALLBACK extractor (regression: 2026-07-19 miss)", async () => {
    const r = await read("real-extract-miss");
    expect(r.receipt.status).toBe("ok");
    expect(r.receipt.extractor).toBe("fallback");
    expect(r.receipt.words).toBeGreaterThan(400);
    expect(r.text).toMatch(/retrieval|augmented|generation/i);
  });

  it("JS shell → js-shell, points at the engine, no phantom text", async () => {
    const r = await read("js-shell");
    expect(r.receipt.status).toBe("js-shell");
    expect(r.text).toBe("");
    expect(r.receipt.note).toMatch(/javascript|engine/i);
  });

  it("empty page (no scripts, no content) → empty, distinct from js-shell", async () => {
    const r = await read("empty");
    expect(r.receipt.status).toBe("empty");
  });

  it("short but real page → ok, flagged short — not dropped", async () => {
    const r = await read("short-real");
    expect(r.receipt.status).toBe("ok");
    expect(r.receipt.note).toMatch(/short/i);
    expect(r.receipt.words).toBeGreaterThan(60);
  });
});

describe("read — the doorman", () => {
  it("HTTP 403 → doorman, no text, honest note", async () => {
    const r = await read("clean-article", { status: 403 });
    expect(r.receipt.status).toBe("doorman");
    expect(r.receipt.httpStatus).toBe(403);
    expect(r.text).toBe("");
    expect(r.receipt.note).toMatch(/refused|engine/i);
  });

  it("a bot challenge in the body → doorman even on HTTP 200", async () => {
    const html = "<!doctype html><title>Just a moment…</title><body>Checking your browser before you continue.</body>";
    const r = await new Reader({ fetchImpl: mockFetch(html) }).read("https://cf.test/x");
    expect(r.receipt.status).toBe("doorman");
  });

  it("a real article that merely CONTAINS a challenge phrase is not a doorman", async () => {
    // Regression: Wikipedia carries "Please enable JavaScript" in a noscript tag.
    // Content must win over stray phrases — extracted article beats the marker.
    const article = fixture("clean-article").replace(
      "</body>",
      "<noscript>Please enable JavaScript to use all features.</noscript></body>",
    );
    const r = await new Reader({ fetchImpl: mockFetch(article) }).read("https://wiki.test/x");
    expect(r.receipt.status).toBe("ok");
  });
});

describe("read — fetch failure", () => {
  it("a thrown fetch → fetch-failed, never an exception", async () => {
    const r = await new Reader({ fetchImpl: failingFetch() }).read("https://dead.test/x");
    expect(r.receipt.status).toBe("fetch-failed");
    expect(r.receipt.httpStatus).toBeNull();
  });

  it("a timeout is reported as such", async () => {
    const r = await new Reader({ fetchImpl: failingFetch("TimeoutError") }).read("https://slow.test/x");
    expect(r.receipt.status).toBe("fetch-failed");
    expect(r.receipt.note).toMatch(/timed out/i);
  });
});

describe("read — handle & pull (handle-not-payload)", () => {
  it("truncates over budget, returns a handle, and pulls the rest by query", async () => {
    // Force truncation: budget below the article's word count.
    const reader = new Reader({
      fetchImpl: mockFetch(fixture("clean-article")),
      config: { budgetWords: 80 },
    });
    const r = await reader.read("https://x.test/clean-article");
    expect(r.receipt.truncated).toBe(true);
    expect(r.receipt.words).toBeLessThanOrEqual(r.receipt.totalWords);
    expect(r.handle).not.toBeNull();

    // pull by query → only the paragraph(s) mentioning it
    const enc = reader.more(r.handle!, "TLS");
    expect(enc).not.toBeNull();
    expect(enc!.text).toMatch(/TLS/);
    expect(enc!.text).not.toMatch(/stateless/i);

    // a miss is reported, not silently empty
    const miss = reader.more(r.handle!, "zebra");
    expect(miss!.matched).toBe(0);
    expect(miss!.note).toMatch(/no paragraph/i);
  });

  it("an unknown handle returns null, not a lie", async () => {
    const reader = new Reader({ fetchImpl: mockFetch(fixture("clean-article")) });
    expect(reader.more("r999", "anything")).toBeNull();
  });
});

describe("read — escalation to a renderer", () => {
  // A renderer that returns the clean article regardless of URL, standing in for
  // headless Chrome running a page's JS.
  const renderer = async (url: string) => ({
    html: fixture("clean-article"),
    finalUrl: url,
    ok: true,
    ms: 1200,
  });

  it("js-shell fetch escalates to render → ok via render", async () => {
    const reader = new Reader({ fetchImpl: mockFetch(fixture("js-shell")), renderer });
    const r = await reader.read("https://spa.test/x");
    expect(r.receipt.status).toBe("ok");
    expect(r.receipt.via).toBe("render");
    expect(r.text).toMatch(/stateless/i);
  });

  it("doorman (403) escalates to render → ok via render", async () => {
    const reader = new Reader({ fetchImpl: mockFetch("nope", { status: 403 }), renderer });
    const r = await reader.read("https://blocked.test/x");
    expect(r.receipt.status).toBe("ok");
    expect(r.receipt.via).toBe("render");
  });

  it("a clean fetch never escalates — render is untouched", async () => {
    let called = false;
    const spy = async (url: string) => {
      called = true;
      return { html: "", finalUrl: url, ok: true, ms: 0 };
    };
    const r = await new Reader({ fetchImpl: mockFetch(fixture("clean-article")), renderer: spy }).read("https://x.test/a");
    expect(r.receipt.via).toBe("fetch");
    expect(called).toBe(false);
  });

  it("no renderer configured → honest js-shell verdict, no escalation", async () => {
    const r = await new Reader({ fetchImpl: mockFetch(fixture("js-shell")) }).read("https://spa.test/x");
    expect(r.receipt.status).toBe("js-shell");
    expect(r.receipt.via).toBe("fetch");
  });

  it("render also fails → blocked both ways, said plainly", async () => {
    const deadRenderer = async (url: string) => ({ html: "", finalUrl: url, ok: false, error: "fingerprinted", ms: 500 });
    const r = await new Reader({ fetchImpl: mockFetch("nope", { status: 403 }), renderer: deadRenderer }).read("https://cf.test/x");
    expect(r.receipt.status).toBe("doorman");
    expect(r.receipt.note).toMatch(/render also failed/i);
  });

  it("render returns another shell → blocked both ways", async () => {
    const shellRenderer = async (url: string) => ({ html: fixture("js-shell"), finalUrl: url, ok: true, ms: 800 });
    const r = await new Reader({ fetchImpl: mockFetch(fixture("js-shell")), renderer: shellRenderer }).read("https://spa.test/x");
    expect(r.receipt.via).toBe("render");
    expect(r.receipt.note).toMatch(/blocked both ways/i);
  });
});
