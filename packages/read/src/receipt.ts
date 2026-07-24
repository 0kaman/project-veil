/**
 * The receipt — the spine of the whole design.
 *
 * Every read declares what it did, what it cost, and what it does NOT have.
 * v1's every failure was silence, not slowness: a component knew it had failed
 * and said nothing, so the model reasoned on junk. The receipt makes that
 * structurally impossible — a caller (human or LLM) can always tell "this page
 * is short" from "I failed", and "no content here" from "my extractor missed
 * content that's present".
 *
 * See docs/DECISIONS.md 2026-07-15 (the receipt) and 2026-07-19 (fallback).
 */

/** How the bytes were obtained. `fetch` is the cheap path; `render` is the
 * escalation — headless Chrome ran the page's JS (via an injected renderer). */
export type Via = "fetch" | "render";

/**
 * The outcome of a read. This is the single most important field: it routes
 * everything downstream.
 * - `ok`         — real content extracted, trust it.
 * - `js-shell`   — HTML has no content; it's behind JavaScript. Escalate to the engine.
 * - `doorman`    — the server refused a non-browser (403/429/challenge). Blocked at this rung.
 * - `empty`      — fetched fine, but there is genuinely almost nothing here.
 * - `fetch-failed` — never got bytes (DNS, timeout, connection).
 */
export type ReadStatus = "ok" | "js-shell" | "doorman" | "empty" | "fetch-failed";

/** Which extractor produced the text — Readability, or the density fallback that
 * rescues pages Readability wrongly discards. `none` when nothing was extracted. */
export type Extractor = "readability" | "fallback" | "none";

export interface Receipt {
  via: Via;
  url: string;
  /** After redirects — may differ from `url`. */
  finalUrl: string;
  httpStatus: number | null;
  ms: number;
  status: ReadStatus;
  extractor: Extractor;
  /** Words in the text actually returned (after the budget cut). */
  words: number;
  /** Words available before the budget cut — so `truncated` is legible. */
  totalWords: number;
  /** Raw stripped-HTML word count. Lets a reader tell "extractor missed present
   * content" (rawWords high, words low) from "genuinely empty" (both low). */
  rawWords: number;
  truncated: boolean;
  /** A short human-facing hint on a non-`ok` status. Never decorative. */
  note?: string;
}

/** A one-line rendering of a receipt for logs and the playground. */
export function formatReceipt(r: Receipt): string {
  const bits = [`via: ${r.via}`, `${r.ms}ms`];
  if (r.status === "ok") {
    bits.push(`${r.words} words`);
    if (r.truncated) bits.push(`of ${r.totalWords}`);
    if (r.extractor === "fallback") bits.push("(fallback extractor)");
  } else {
    bits.push(r.status.toUpperCase());
    if (r.note) bits.push(`— ${r.note}`);
  }
  return bits.join(" · ");
}
