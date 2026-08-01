/**
 * What KIND of thing came back — the question the read path never asked.
 *
 * `performRead` used to feed every response body into an HTML pipeline; the
 * variable was even called `html`. That produced two defects at once. Raw
 * markdown, JSON, CSV and plain text parse to a document with a NULL
 * `documentElement`, and linkedom's `document.body` getter throws on that — so
 * `veil_read` on a `.md` URL crashed with `Cannot destructure property
 * 'firstElementChild'`. Worse, a text body containing any stray tag at all got a
 * non-null `documentElement` and an empty `<body>`, and came back `empty ·
 * almost no readable text (0 raw words)` — RFC 7231's 32,091 words reported as
 * zero, confidently.
 *
 * So: decide the lane before parsing anything. Two signals, and BOTH are needed
 * because neither is sufficient (measured):
 *   - the `content-type` header catches text bodies that carry stray tags, which
 *     no byte sniff can distinguish from HTML;
 *   - the body sniff catches an HTTP 200 labelled `text/html` whose body is
 *     empty or tagless, which no header can distinguish from a real page.
 *
 * Zero dependencies, no DOM parse — this runs before linkedom is ever reached.
 */

export type MediaLane = "html" | "text" | "binary";

export interface MediaVerdict {
  /** Which pipeline the body belongs in. */
  lane: MediaLane;
  /** Normalised media type (lowercased, parameters stripped), or null when the
   * server sent no usable `content-type`. Goes on the receipt. */
  mediaType: string | null;
}

/** Media types that can never be prose. `application/octet-stream` is
 * deliberately NOT here — it means "the server has no idea", which is not
 * evidence of binary, so it must reach the byte sniff instead. */
const BINARY_PREFIXES = ["image/", "audio/", "video/", "font/", "model/"];
const BINARY_TYPES = new Set([
  "application/pdf",
  "application/zip",
  "application/gzip",
  "application/x-gzip",
  "application/x-tar",
  "application/x-7z-compressed",
  "application/x-rar-compressed",
  "application/x-bzip2",
  "application/wasm",
  "application/java-archive",
  "application/vnd.ms-excel",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/msword",
  "application/epub+zip",
]);

const HTML_TYPES = new Set(["text/html", "application/xhtml+xml"]);

/** XML-ish types go down the HTML lane. They parse to a real document, and
 * Readability pulls the element text out of them; returning the raw source as
 * "prose" would hand an agent angle brackets and call it an answer. */
function isXmlMediaType(mediaType: string): boolean {
  return mediaType === "application/xml" || mediaType === "text/xml" || mediaType.endsWith("+xml");
}

/**
 * True when the media type POSITIVELY says "these bytes are prose, not markup".
 *
 * This is an allowlist, and that direction is load-bearing. The first cut of
 * this file defaulted anything not provably HTML to the text lane, which read
 * well and was wrong: the text lane returns before the escalation block in
 * `performRead`, so a JS shell served with no `content-type` stopped summoning
 * Chrome and came back `ok · text` with `<div id="root"></div><script…>` as the
 * answer. Measured, before and after. That is silent degradation of the ladder
 * — the exact fault this file was written to remove — so the default is HTML,
 * as it has always been, and only a type we recognise diverts.
 */
function isTextualMediaType(mediaType: string | null): boolean {
  if (!mediaType) return false; // no header is not evidence of anything
  if (HTML_TYPES.has(mediaType) || isXmlMediaType(mediaType)) return false;
  if (mediaType.startsWith("text/")) return true;
  if (mediaType === "application/json" || mediaType.endsWith("+json")) return true;
  if (mediaType === "application/x-ndjson") return true;
  return mediaType === "application/yaml" || mediaType === "application/x-yaml";
}

/** `content-type: TEXT/HTML; charset=UTF-8` → `text/html`. A real `Headers.get()`
 * hands back the whole field value including parameters, so stripping them and
 * folding case is not optional. */
export function parseMediaType(contentType: string | null | undefined): string | null {
  if (!contentType) return null;
  const mt = contentType.split(";")[0]!.trim().toLowerCase();
  return mt || null;
}

/**
 * True when the media type alone proves the body is not text. Used to skip the
 * decode entirely — there is no point turning 224 KB of PNG into a string.
 */
export function isBinaryMediaType(mediaType: string | null): boolean {
  if (!mediaType) return false;
  if (BINARY_TYPES.has(mediaType)) return true;
  return BINARY_PREFIXES.some((p) => mediaType.startsWith(p));
}

/** Does a decoded string look like it was never text? Control characters (bar
 * tab/newline/CR) and U+FFFD replacement chars are what binary looks like after
 * a UTF-8 decode. Only consulted when the media type told us nothing. */
function looksBinary(bodyStart: string): boolean {
  const sample = bodyStart.slice(0, 4096);
  if (!sample) return false;
  if (sample.includes("\u0000")) return true;
  let bad = 0;
  for (const ch of sample) {
    const c = ch.codePointAt(0)!;
    if (ch === "\ufffd" || (c < 0x20 && c !== 0x09 && c !== 0x0a && c !== 0x0d)) bad++;
  }
  return bad / sample.length > 0.02;
}

/** A body whose first non-whitespace bytes announce HTML, whatever the label
 * says. Deliberately narrow: a markdown file that merely mentions `<html>` in a
 * sentence must not match. */
function sniffsAsHtml(bodyStart: string): boolean {
  return /^\s*(<!doctype\s+html|<html[\s>])/i.test(bodyStart.slice(0, 512));
}

/**
 * Decide the lane. Order is load-bearing:
 *   1. a binary media type wins outright — otherwise an unusually-encoded HTML
 *      page could be sniffed into the binary lane, and that failure is silent;
 *   2. an HTML media type;
 *   3. an HTML-announcing body, which overrides a `text/*` label;
 *   4. the byte sniff, ONLY when the type was absent or octet-stream;
 *   5. a type that POSITIVELY announces prose — the allowlist, not a default;
 *   6. HTML, because that is where an unrecognised body has always gone and the
 *      whole ladder (Readability, js-shell detection, escalation to a render)
 *      lives down there.
 *
 * A known, bounded hole survives step 6: a body with NO `content-type` that is
 * prose but happens to contain a stray tag still parses to an empty `<body>`
 * and reports `empty · 0 raw words`. That is pre-existing, it is narrower than
 * what shipping the inverse default would cost, and `non-html.test.ts` names it.
 */
export function classifyMedia(
  contentType: string | null | undefined,
  bodyStart: string,
): MediaVerdict {
  const mediaType = parseMediaType(contentType);
  if (isBinaryMediaType(mediaType)) return { lane: "binary", mediaType };
  if (mediaType && HTML_TYPES.has(mediaType)) return { lane: "html", mediaType };
  if (sniffsAsHtml(bodyStart)) return { lane: "html", mediaType };
  if ((!mediaType || mediaType === "application/octet-stream") && looksBinary(bodyStart)) {
    return { lane: "binary", mediaType };
  }
  if (isTextualMediaType(mediaType)) return { lane: "text", mediaType };
  return { lane: "html", mediaType };
}
