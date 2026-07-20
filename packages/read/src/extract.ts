/**
 * Turning HTML into readable text.
 *
 * Two extractors, because one is not enough. The 2026-07-19 probe measured
 * Readability discarding content that was plainly in the HTML (geeksforgeeks:
 * 1,334 raw words → 0 kept) — 10% of real pages. So Readability is the primary,
 * and a density-based fallback rescues the pages it wrongly abandons.
 *
 * Text is returned as paragraphs joined by blank lines, not flattened to one
 * line: truncation cuts on paragraph boundaries and query-pull returns whole
 * paragraphs, both of which need the structure preserved.
 *
 * Each function parses its own document. Readability MUTATES the DOM it's given,
 * so it cannot share one with the other passes. Parsing is ~48ms; correctness is
 * worth the millisecond.
 */
import { parseHTML } from "linkedom";
import { Readability } from "@mozilla/readability";

const BOILERPLATE = "script,style,noscript,template,svg,iframe,nav,header,footer,aside,form";
const BLOCKS = "p,li,h1,h2,h3,h4,blockquote,pre,td";

export function countWords(s: string): number {
  const t = s.trim();
  return t ? t.split(/\s+/).length : 0;
}

/** Whitespace within a line → single space. Newlines are the caller's concern. */
function tidy(s: string): string {
  return s.replace(/[ \t\r\f\v]+/g, " ").trim();
}

/** Pull block-level text from a parsed document as paragraphs. Preserves the
 * article's shape without its markup. */
function blockText(doc: { querySelectorAll: (s: string) => ArrayLike<unknown> }): string {
  const blocks = Array.from(doc.querySelectorAll(BLOCKS)) as Array<{ textContent: string | null }>;
  const lines = blocks.map((b) => tidy(b.textContent ?? "")).filter(Boolean);
  return lines.join("\n\n");
}

/** All visible text with boilerplate removed — the "is there content at all?"
 * signal. High rawWords + low extracted words ⇒ the extractor missed it. */
export function rawText(html: string): string {
  const { document } = parseHTML(html);
  document.querySelectorAll(BOILERPLATE).forEach((el) => el.remove());
  return tidy((document.body?.textContent ?? "").replace(/\s+/g, " "));
}

/** Primary extractor. Empty text when Readability declines the page. */
export function readabilityExtract(html: string): { title: string | null; text: string } {
  const { document } = parseHTML(html);
  let art: { title?: string; content?: string; textContent?: string } | null = null;
  try {
    art = new Readability(document).parse();
  } catch {
    // Readability throws on some malformed docs — that's a decline, not a crash.
    return { title: null, text: "" };
  }
  if (!art) return { title: null, text: "" };

  // art.content is sanitized HTML — re-parse it for clean paragraph structure.
  let text = "";
  if (art.content) {
    const { document: cdoc } = parseHTML(art.content);
    text = blockText(cdoc);
  }
  if (!text) text = tidy((art.textContent ?? "").replace(/\n{3,}/g, "\n\n"));
  return { title: art.title?.trim() || null, text };
}

/**
 * Density fallback. When Readability abandons a page whose content is present,
 * pick the block container with the most real text (discounting link-heavy
 * navigation), and return its paragraph text.
 */
export function fallbackExtract(html: string): { text: string } {
  const { document } = parseHTML(html);
  document.querySelectorAll(BOILERPLATE).forEach((el) => el.remove());

  const candidates = [
    ...document.querySelectorAll("main,article,[role=main],section,div"),
  ] as Array<{
    textContent: string | null;
    querySelectorAll: (s: string) => ArrayLike<unknown>;
  }>;

  let best: (typeof candidates)[number] | null = null;
  let bestScore = 0;
  for (const el of candidates) {
    const text = tidy((el.textContent ?? "").replace(/\s+/g, " "));
    if (text.length < 200) continue;
    // Link density: a container that's mostly anchor text is navigation, not
    // article. Score = text length discounted by how link-heavy it is.
    let linkChars = 0;
    for (const a of Array.from(el.querySelectorAll("a")) as Array<{ textContent: string | null }>) {
      linkChars += (a.textContent ?? "").length;
    }
    const linkDensity = text.length ? linkChars / text.length : 1;
    const score = text.length * (1 - Math.min(linkDensity, 1));
    if (score > bestScore) {
      bestScore = score;
      best = el;
    }
  }

  if (best) {
    const structured = blockText(best);
    const flat = tidy((best.textContent ?? "").replace(/\s+/g, " "));
    // Use the structured (paragraph) form ONLY if it captured most of the
    // container's text. When content sits in non-semantic <div>s (the
    // geeksforgeeks case), blockText finds only a stray heading and misses the
    // body — so fall through to the container's full text rather than lose it.
    if (countWords(structured) >= countWords(flat) * 0.5) return { text: structured };
    return { text: flat };
  }
  // Nothing scored — whole-body block text as the last resort.
  return { text: blockText(document) };
}

/** Section headings (h1–h3) in document order — the map an agent uses to pull a
 * specific part of a truncated read. Cheap (~80 tokens) and high-value. */
export function getOutline(html: string): string[] {
  const { document } = parseHTML(html);
  const out: string[] = [];
  for (const h of Array.from(document.querySelectorAll("h1,h2,h3")) as Array<{
    textContent: string | null;
  }>) {
    const t = tidy(h.textContent ?? "");
    if (t && t.length <= 120 && !out.includes(t)) out.push(t);
  }
  return out.slice(0, 40);
}

/** Best-effort document title, for when Readability didn't supply one. */
export function documentTitle(html: string): string | null {
  const { document } = parseHTML(html);
  const t = tidy(document.querySelector("title")?.textContent ?? "");
  if (t) return t;
  const h1 = tidy(document.querySelector("h1")?.textContent ?? "");
  return h1 || null;
}

/** True when the page has script tags — used to tell a JS shell (empty + scripts)
 * from a genuinely empty document (empty + no scripts). */
export function hasScripts(html: string): boolean {
  return /<script[\s>]/i.test(html);
}
