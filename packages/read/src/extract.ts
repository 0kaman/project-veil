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

/**
 * All visible text with boilerplate removed — the "is there content at all?"
 * signal. High rawWords + low extracted words ⇒ the extractor missed it.
 *
 * Returns NULL when the input did not parse as a document at all. That is not a
 * detail: linkedom's `document.body` is a getter that reaches through
 * `documentElement`, so on a body with zero elements it THROWS rather than
 * returning null — `document.body?.textContent` is dead code, the `?.` guards a
 * null result and not a throwing getter. This was the single crash site behind
 * "veil_read on a raw .md URL → Cannot destructure property
 * 'firstElementChild'"; measured to be the only accessor in this file that
 * throws on a tagless document (querySelectorAll, querySelector and textContent
 * all return safely, and Readability's own throw is already caught below).
 *
 * The caller must treat null as "this is not HTML, read it as text" — NOT as
 * "empty". Returning empty here is what made RFC 7231's 32,091 words report as
 * zero, and it is the failure mode this signal exists to prevent.
 */
export function rawTextOrNull(html: string): string | null {
  const { document } = parseHTML(html);
  if (!document.documentElement) return null;
  document.querySelectorAll(BOILERPLATE).forEach((el) => el.remove());
  return tidy((document.body?.textContent ?? "").replace(/\s+/g, " "));
}

/** Back-compat wrapper: raw text, with "did not parse" flattened to empty.
 * Prefer `rawTextOrNull` anywhere the difference matters. */
export function rawText(html: string): string {
  return rawTextOrNull(html) ?? "";
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

/**
 * Extraction for a page an agent has DRIVEN, where the answer is usually a list
 * of records rather than an article.
 *
 * Readability and `fallbackExtract` both pick ONE best container and flatten it.
 * Measured on a live Cleartrip results page: the container holding the flight
 * rows scored 3,519 and lost to a 4,070 promo block, so the read returned column
 * headers and bare prices — "₹8,771" three times with no airline or time
 * attached — while the rows sat in the DOM fully formed. Single-best is the
 * wrong shape for a results grid; the page says several things at once.
 *
 * So: keep every candidate that clears the bar, drop any that merely contains
 * another (or the text arrives two and three times over), and join them in
 * document order. Scoped to session reads deliberately — on a fetched article
 * this would drag in the comment section, and the fetch path is tuned against a
 * 60-page corpus that must not move.
 */
export function denseExtract(html: string): { text: string } {
  const { document } = parseHTML(html);
  document.querySelectorAll(BOILERPLATE).forEach((el) => el.remove());

  type Cand = { el: Element; text: string; score: number };
  const cands: Cand[] = [];
  for (const el of document.querySelectorAll("main,article,[role=main],section,div,ul,ol,table")) {
    const text = tidy((el.textContent ?? "").replace(/\s+/g, " "));
    if (text.length < 200) continue;
    let linkChars = 0;
    for (const a of Array.from(el.querySelectorAll("a")) as Array<{ textContent: string | null }>) {
      linkChars += (a.textContent ?? "").length;
    }
    const density = text.length ? linkChars / text.length : 1;
    cands.push({ el: el as unknown as Element, text, score: text.length * (1 - Math.min(density, 1)) });
  }
  if (cands.length === 0) return { text: blockText(document) };

  cands.sort((a, b) => b.score - a.score);
  // Ancestors and descendants of an already-kept block would repeat its text.
  const kept: Cand[] = [];
  for (const c of cands) {
    if (kept.some((k) => k.el.contains(c.el) || c.el.contains(k.el))) continue;
    kept.push(c);
    if (kept.length >= 8) break;
  }
  // Document order, so the page reads the way it looks.
  kept.sort((a, b) =>
    a.el.compareDocumentPosition(b.el) & 4 /* FOLLOWING */ ? -1 : 1,
  );
  const joined = kept.map((k) => blockish(k.el)).join("\n\n");
  return { text: tidy(joined).length > 0 ? joined : blockText(document) };
}

/** Flatten with separators at block boundaries — `textContent` runs words
 * together ("Trip typeDeparture"), which then counts as a fraction of the words
 * actually present and reads as gibberish. */
function blockish(el: Element): string {
  const BLOCK = new Set(["DIV","P","LI","TR","SECTION","ARTICLE","H1","H2","H3","H4","UL","OL","TABLE","BR"]);
  const walk = (n: Element): string => {
    let out = "";
    for (const child of Array.from(n.childNodes) as Array<{ nodeType: number; textContent: string | null; tagName?: string }>) {
      if (child.nodeType === 3) out += child.textContent ?? "";
      else if (child.nodeType === 1) {
        const brk = BLOCK.has((child.tagName ?? "").toUpperCase());
        out += (brk ? "\n" : " ") + walk(child as unknown as Element) + (brk ? "\n" : " ");
      }
    }
    return out;
  };
  return walk(el)
    .replace(/[ \t]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{2,}/g, "\n")
    .trim();
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

/**
 * The `src` of every `<frame>`/`<iframe>` in the markup, in document order.
 *
 * A frameset's own bytes carry no prose — the content is one document down —
 * and the read tier had no way to say so. Measured on the arena fixture:
 * `veil_read <frameset url>` returned `empty · almost no readable text (0 raw
 * words)` naming no recovery, while the very bytes it held said
 * `<frame src="/frame-menu">`. Two of five arena runs acted on that receipt and
 * concluded the page was "served with a content type that isn't text".
 *
 * Regex rather than a parse because this runs on the thin-result path, where a
 * DOM has not necessarily been built and the answer is needed to pick a status.
 * `about:blank` and `javascript:` are dropped — they are not recoveries.
 */
export function frameSources(html: string): string[] {
  const out: string[] = [];
  const re = /<(?:i?frame)\b[^>]*?\ssrc\s*=\s*("([^"]*)"|'([^']*)'|([^\s">]+))/gi;
  for (const m of html.matchAll(re)) {
    const src = (m[2] ?? m[3] ?? m[4] ?? "").trim();
    if (!src || /^(about:|javascript:|data:)/i.test(src)) continue;
    if (!out.includes(src)) out.push(src);
  }
  return out;
}
