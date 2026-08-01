/**
 * The read path, orchestrated: fetch → classify → extract → budget → receipt.
 *
 * The classifier is the load-bearing part. It decides, from what came back,
 * which of the five outcomes this is (see ReadStatus) — and every branch fills a
 * receipt so the caller is never left guessing why it got what it got.
 *
 * `fetchImpl` is injectable so the whole path is testable offline against HTML
 * fixtures, with no network. Config is read per-call (not bound at module load)
 * so a host that loads its .env late still gets the configured values.
 */
import {
  countWords,
  documentTitle,
  fallbackExtract,
  denseExtract,
  getOutline,
  hasScripts,
  frameSources,
  rawTextOrNull,
  readabilityExtract,
} from "./extract.js";
import { budgetParagraphs, type BudgetResult } from "./budget.js";
import { classifyMedia, isBinaryMediaType, parseMediaType } from "./media.js";
import type { HandleStore } from "./handles.js";
import type { Receipt, Via } from "./receipt.js";

export interface ReadResult {
  receipt: Receipt;
  title: string | null;
  text: string;
  outline: string[];
  /** Set only when the read was truncated — the key to pull the rest. */
  handle: string | null;
}

export interface ReadConfig {
  /** Extracted words at/above which a read is confidently clean. */
  cleanWords: number;
  /** Below this, a read is not "ok" — it's a shell or empty. */
  okFloor: number;
  /** Raw stripped words needed before the fallback extractor is worth trying. */
  fallbackRaw: number;
  /** Words returned inline before truncating to a handle. */
  budgetWords: number;
  /** Character ceiling on the inline return. Words are a meaningless unit on
   * minified content — 805 KB of JSON is ~10,836 whitespace-"words" — so the
   * budget needs a second, absolute limit. */
  budgetChars: number;
  timeoutMs: number;
  userAgent: string;
}

const CHROME_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36";

export function defaultConfig(): ReadConfig {
  const n = (v: string | undefined, d: number) => (v ? Number(v) : d);
  return {
    cleanWords: n(process.env.VEIL_READ_CLEAN_WORDS, 250),
    okFloor: n(process.env.VEIL_READ_OK_FLOOR, 60),
    fallbackRaw: n(process.env.VEIL_READ_FALLBACK_RAW, 600),
    budgetWords: n(process.env.VEIL_READ_BUDGET_WORDS, 4000),
    budgetChars: n(process.env.VEIL_READ_BUDGET_CHARS, 32_000),
    timeoutMs: n(process.env.VEIL_READ_TIMEOUT_MS, 10_000),
    userAgent: process.env.VEIL_READ_UA ?? CHROME_UA,
  };
}

export interface FetchResponse {
  status: number;
  url: string;
  /** Optional so injected test fetchers and `readHtml` still satisfy this; a
   * real `Response` satisfies it structurally. An absent header degrades to the
   * body sniff, which is stated on the receipt rather than assumed away. */
  headers?: { get(name: string): string | null };
  text(): Promise<string>;
}
export type FetchLike = (url: string, init?: unknown) => Promise<FetchResponse>;

/** Escalation hook: render a URL with a real browser (headless Chrome runs its
 * JS). Injected — @veil/read never imports @veil/core, so the cheap path stays
 * browserless. Shape matches @veil/core's RenderResult. */
export type RenderFn = (url: string) => Promise<{
  html: string;
  finalUrl: string;
  ok: boolean;
  error?: string;
  ms: number;
}>;

const DOORMAN_STATUS = new Set([401, 403, 429, 503]);
const CHALLENGE =
  /captcha|are you a robot|unusual traffic|cf-challenge|challenge-platform|please enable (java)?script|checking your browser|verify you are human/i;

/** Cut text to the budget on paragraph boundaries where possible — and where it
 * is NOT possible (one paragraph is the whole body), cut anyway and say so.
 * See budget.ts: a budget that declines to cut is not a budget. */
function truncateToBudget(text: string, config: ReadConfig) {
  return budgetParagraphs(text.split(/\n\n+/), config.budgetWords, config.budgetChars);
}

/** Name the limit that ACTUALLY bound. "no paragraph breaks to cut on" is false
 * of RFC 7231, which has them in abundance and is cut by the character ceiling
 * — and a receipt that misnames its own reason is the defect class, in small. */
function cutNote(cause: BudgetResult["cause"], config: ReadConfig): string | undefined {
  if (cause === "chars") {
    return `cut mid-paragraph at the ${config.budgetChars}-character ceiling — pull the rest with the handle`;
  }
  if (cause === "oversize-unit") {
    return `cut mid-paragraph — this body has no paragraph breaks to cut on; pull the rest with the handle`;
  }
  return undefined;
}

/** Statuses worth escalating to a render — the browser can plausibly help. */
function shouldEscalate(status: Receipt["status"]): boolean {
  return status === "js-shell" || status === "doorman" || status === "frames";
}

interface ClassifyCtx {
  url: string;
  finalUrl: string;
  httpStatus: number;
  via: Via;
  ms: number;
  html: string;
  store: HandleStore;
  config: ReadConfig;
  /** Normalised content-type, when the server gave one. Carried onto the
   * receipt; also the reason this body is in the HTML lane at all. */
  mediaType?: string | null;
}

/**
 * Given HTML (from a fetch OR a render), classify it and produce a ReadResult.
 * Reused for BOTH tiers so the fetched shell and the rendered page go through
 * the exact same extractor and thresholds — the only difference is `via`.
 */
function classifyHtml(ctx: ClassifyCtx): ReadResult {
  const { html, config, store, url, finalUrl, httpStatus, via, ms } = ctx;
  const base = (over: Partial<Receipt>): Receipt => ({
    via,
    url,
    finalUrl,
    httpStatus,
    ms,
    status: "fetch-failed",
    extractor: "none",
    words: 0,
    totalWords: 0,
    rawWords: 0,
    truncated: false,
    mediaType: ctx.mediaType ?? null,
    ...over,
  });

  // A refusal status — no page to extract. (Skipped on a render, which is 200.)
  if (DOORMAN_STATUS.has(httpStatus)) {
    return {
      receipt: base({ status: "doorman", note: `HTTP ${httpStatus} — server refused` }),
      title: null,
      text: "",
      outline: [],
      handle: null,
    };
  }

  // Nothing in this body parsed as an element, so it is not HTML however it was
  // labelled — an empty 200, or a server that stamps `text/html` on a plain-text
  // page. Route it to the TEXT lane rather than calling it empty: an empty
  // verdict here is exactly the lie that made RFC 7231's 32,091 words read as
  // zero, and it is what a "catch the TypeError and return empty" fix would
  // silently reintroduce. content-type cannot catch this case and this cannot
  // catch content-type's; both signals are needed.
  const rawOrNull = rawTextOrNull(html);
  if (rawOrNull === null) return classifyText({ ...ctx, body: html });

  // Extract: Readability, then the fallback if it declined content that's present.
  const rawWords = countWords(rawOrNull);
  const primary = readabilityExtract(html);
  let text = primary.text;
  let extractor: Receipt["extractor"] = "readability";
  let words = countWords(text);
  // A driven page is usually a LIST of records, not an article, and the
  // article-shaped extractors pick one best container and flatten it — on a
  // real results page that meant column headers and bare prices while the rows
  // sat in the DOM. No `fallbackRaw` gate here: this tier has no rung above it,
  // so there is nothing to escalate to and nothing to protect.
  if (via === "session") {
    const dense = denseExtract(html);
    const dWords = countWords(dense.text);
    if (dWords > words) {
      text = dense.text;
      words = dWords;
      extractor = "fallback";
    }
  } else if (words < config.cleanWords && rawWords >= config.fallbackRaw) {
    const fb = fallbackExtract(html);
    const fbWords = countWords(fb.text);
    if (fbWords > words) {
      text = fb.text;
      words = fbWords;
      extractor = "fallback";
    }
  }
  const title = primary.title ?? documentTitle(html);

  // Thin result — doorman (challenge), JS shell, or genuinely empty. The
  // stray-phrase check is deferred to here: a real article would have cleared
  // okFloor above, so "enable javascript" in a noscript can't false-flag it.
  // A SESSION read has no rung above it. These statuses exist to route an
  // escalation — "js-shell" means "go render it" — and a driven page has
  // already been rendered and acted on. So a thin session page keeps its text
  // and is flagged thin; only a genuinely blank one is empty. Discarding a terse
  // results table because it did not clear a prose threshold would throw away
  // the very answer the agent drove the form to get.
  let thin: string | undefined;
  if (words < config.okFloor) {
    const challenged = CHALLENGE.test(html.slice(0, 6000));
    if (via === "session" && !challenged && words > 0) {
      thin = `thin page (${words} words) — this is the live tab, there is nothing further to escalate to`;
    } else {
      let status: Receipt["status"];
      let note: string;
      const frames = via === "session" ? [] : frameSources(html);
      if (challenged) {
        status = "doorman";
        note = "bot challenge — server refused";
      } else if (frames.length > 0) {
        // BEFORE js-shell, because a frameset page routinely carries a script
        // too and "it's behind JavaScript" would send the agent after the wrong
        // thing. Name the documents: the recovery is the engine, which composes
        // them, and the URLs are right here in the bytes we already hold.
        status = "frames";
        const shown = frames.slice(0, 6).join(", ");
        note =
          `no prose here — this page's content is in ${frames.length} child ` +
          `document(s) it only references (${shown}${frames.length > 6 ? ", …" : ""}). ` +
          `veil_open this URL and read the session; the engine composes child ` +
          `documents, a plain fetch cannot.`;
      } else if (via !== "session" && rawWords < 200 && hasScripts(html)) {
        status = "js-shell";
        note = "no content in the HTML — it's behind JavaScript";
      } else {
        status = "empty";
        note = `almost no readable text (${rawWords} raw words)`;
      }
      return {
        receipt: base({ rawWords, status, extractor: "none", note }),
        title,
        text: "",
        outline: [],
        handle: null,
      };
    }
  }

  // A real read. Apply the budget; store a handle only if we truncated.
  const outline = getOutline(html);
  const totalWords = words;
  let outText = text;
  let truncated = false;
  let handle: string | null = null;
  let cutReason: BudgetResult["cause"] = "fit";
  if (words > config.budgetWords || text.length > config.budgetChars) {
    const cut = truncateToBudget(text, config);
    outText = cut.text;
    words = cut.words;
    cutReason = cut.cause;
    truncated = true;
    handle = store.put({ url: finalUrl, title, fullText: text, outline });
  }
  const note =
    thin ??
    cutNote(cutReason, config) ??
    (totalWords < config.cleanWords ? `short page (${totalWords} words) — may be a stub` : undefined);

  return {
    receipt: base({ status: "ok", extractor, words, totalWords, rawWords, truncated, note }),
    title,
    text: outText,
    outline,
    handle,
  };
}

/**
 * A body that was never HTML: markdown, JSON, CSV, plain text.
 *
 * There is no extraction to do — the bytes ARE the content — so there is no DOM
 * parse here at all, which is also why nothing can throw. And there is no
 * escalation: a render cannot add information to a file that is already exactly
 * its own text, so the text lane never summons Chrome (substantively the
 * 2026-07-26 "no rung above it" argument).
 *
 * Short text keeps its text and is flagged short, exactly as the session tier
 * does. Discarding a 30-word README because it failed a prose threshold would
 * throw away the whole answer.
 */
function classifyText(ctx: ClassifyCtx & { body: string }): ReadResult {
  const { body, config, store, url, finalUrl, httpStatus, via, ms } = ctx;
  const mediaType = ctx.mediaType ?? null;
  const base = (over: Partial<Receipt>): Receipt => ({
    via, url, finalUrl, httpStatus, ms,
    status: "fetch-failed", extractor: "none",
    words: 0, totalWords: 0, rawWords: 0, truncated: false, mediaType,
    ...over,
  });

  if (DOORMAN_STATUS.has(httpStatus)) {
    return {
      receipt: base({ status: "doorman", note: `HTTP ${httpStatus} — server refused` }),
      title: null, text: "", outline: [], handle: null,
    };
  }

  // Normalise line endings only — paragraph structure is what the budget and the
  // handle-pull cut on, so it must survive.
  const text = body.replace(/\r\n?/g, "\n").replace(/[ \t]+\n/g, "\n").trim();
  const totalWords = countWords(text);

  if (totalWords === 0) {
    return {
      receipt: base({
        status: "empty",
        note: `no text in the body (${mediaType ?? "no content-type"}, ${body.length} bytes)`,
      }),
      title: null, text: "", outline: [], handle: null,
    };
  }

  let outText = text;
  let words = totalWords;
  let truncated = false;
  let cutReason: BudgetResult["cause"] = "fit";
  let handle: string | null = null;
  if (words > config.budgetWords || text.length > config.budgetChars) {
    const cut = budgetParagraphs(text.split(/\n\n+/), config.budgetWords, config.budgetChars);
    outText = cut.text;
    words = cut.words;
    cutReason = cut.cause;
    truncated = true;
    handle = store.put({ url: finalUrl, title: null, fullText: text, outline: [] });
  }

  const note =
    cutNote(cutReason, config) ??
    (totalWords < config.okFloor
      ? `short text (${totalWords} words) — that is the whole body, not a truncation`
      : undefined);

  return {
    receipt: base({
      status: "ok", extractor: "text", words, totalWords, rawWords: totalWords, truncated, note,
    }),
    title: null,
    text: outText,
    outline: [],
    handle,
  };
}

/**
 * A body that is not text at all. Veil reads prose; there is nothing here to
 * read, and the receipt says WHICH kind of thing it was and how big — today this
 * came back as "almost no readable text (0 raw words)", which is a lie about a
 * 224 KB PNG.
 */
function binaryResult(
  ctx: { url: string; finalUrl: string; httpStatus: number; ms: number; mediaType: string | null; bytes: number | null },
): ReadResult {
  const size = ctx.bytes != null ? `, ${ctx.bytes} bytes` : "";
  return {
    receipt: {
      via: "fetch", url: ctx.url, finalUrl: ctx.finalUrl, httpStatus: ctx.httpStatus, ms: ctx.ms,
      status: "empty", extractor: "none", words: 0, totalWords: 0, rawWords: 0,
      truncated: false, mediaType: ctx.mediaType,
      note:
        `${ctx.mediaType ?? "binary"}${size} — not text, so there is nothing to read here. ` +
        `Veil has no rung that reads this format; try an HTML version of the document, or veil_search for one.`,
    },
    title: null, text: "", outline: [], handle: null,
  };
}

/**
 * Extract prose from HTML we already hold — no fetch, no render.
 *
 * The path that made this necessary: an agent drove a booking form to a results
 * page, then called veil_read with the SESSION id, and got FETCH-FAILED. It had
 * the answer on screen and no way to read it. Re-fetching the URL is not a
 * substitute: the results exist only because of the form state in that tab.
 */
export function readHtml(
  html: string,
  url: string,
  deps: { store: HandleStore; config: ReadConfig; ms: number },
): ReadResult {
  return classifyHtml({
    url, finalUrl: url, httpStatus: 200, via: "session",
    ms: deps.ms, html, store: deps.store, config: deps.config,
  });
}

export async function performRead(
  url: string,
  deps: { fetchImpl: FetchLike; store: HandleStore; config: ReadConfig; renderer?: RenderFn },
): Promise<ReadResult> {
  const { fetchImpl, store, config, renderer } = deps;
  const t0 = Date.now();

  // 1. Fetch — the cheap path.
  let res: FetchResponse;
  let body: string;
  let contentType: string | null = null;
  let earlyOut: ReadResult | null = null;
  try {
    res = await fetchImpl(url, {
      headers: { "user-agent": config.userAgent, accept: "text/html,application/xhtml+xml" },
      redirect: "follow",
      signal: AbortSignal.timeout(config.timeoutMs),
    });
    contentType = res.headers?.get("content-type") ?? null;
    // Decide BEFORE decoding: there is no point turning 224 KB of PNG into a
    // string. A refusal status still outranks the media type, so a 403 on a PDF
    // is reported as the doorman it is.
    const declared = parseMediaType(contentType);
    if (isBinaryMediaType(declared) && !DOORMAN_STATUS.has(res.status)) {
      const len = Number(res.headers?.get("content-length") ?? NaN);
      earlyOut = binaryResult({
        url, finalUrl: res.url || url, httpStatus: res.status, ms: Date.now() - t0,
        mediaType: declared, bytes: Number.isFinite(len) ? len : null,
      });
      body = "";
    } else {
      body = await res.text();
    }
  } catch (err) {
    const name = err instanceof Error ? err.name : "Error";
    const detail = name === "TimeoutError" ? `timed out after ${config.timeoutMs}ms` : name;
    return {
      receipt: {
        via: "fetch", url, finalUrl: url, httpStatus: null, ms: Date.now() - t0,
        status: "fetch-failed", extractor: "none", words: 0, totalWords: 0, rawWords: 0,
        truncated: false, mediaType: parseMediaType(contentType), note: detail,
      },
      title: null, text: "", outline: [], handle: null,
    };
  }
  if (earlyOut) return earlyOut;

  const httpStatus = res.status;
  const finalUrl = res.url || url;

  // Which lane? The header is authoritative where it exists; the body sniff
  // catches the cases it cannot speak to (see media.ts). Only the HTML lane can
  // escalate to a browser.
  const verdict = classifyMedia(contentType, body.slice(0, 4096));
  const ctx = { url, finalUrl, httpStatus, via: "fetch" as Via, ms: Date.now() - t0, store, config, mediaType: verdict.mediaType };

  // A refusal outranks the media type: there is no body worth classifying, and a
  // doorman must stay escalatable (headless Chrome's real fingerprint sometimes
  // gets past a server that refuses a bare fetch). classifyHtml returns on that
  // branch before parsing anything, so any body shape is safe here.
  let result: ReadResult;
  if (DOORMAN_STATUS.has(httpStatus)) {
    result = classifyHtml({ ...ctx, html: body });
  } else if (verdict.lane === "binary") {
    return binaryResult({ url, finalUrl, httpStatus, ms: ctx.ms, mediaType: verdict.mediaType, bytes: body.length });
  } else if (verdict.lane === "text") {
    // No rung above this one: the bytes already ARE the content, so a render
    // cannot add information. Return without consulting the renderer.
    return classifyText({ ...ctx, html: body, body });
  } else {
    result = classifyHtml({ ...ctx, html: body });
  }

  // 2. Escalate to a render when the cheap path hit a wall AND a renderer exists.
  //    js-shell (content behind JS) or doorman (headless Chrome's real fingerprint
  //    may get past a fetch-blocking server). No renderer → return the honest
  //    fetch verdict, which already says "needs the engine".
  if (!renderer || !shouldEscalate(result.receipt.status)) return result;

  const rendered = await renderer(url);
  if (!rendered.ok || !rendered.html) {
    // Render itself failed — keep the fetch verdict, note the failed attempt.
    result.receipt.note = `${result.receipt.status} on fetch; render also failed (${rendered.error ?? "unknown"})`;
    return result;
  }

  const escalated = classifyHtml({
    url, finalUrl: rendered.finalUrl, httpStatus: 200, via: "render",
    ms: Date.now() - t0, html: rendered.html, store, config,
    // What Chrome hands back is a serialised DOM whatever the origin server
    // labelled it, so the rendered tier reports text/html rather than carrying
    // the fetch's content-type forward.
    mediaType: "text/html",
  });
  if (escalated.receipt.status === "ok") return escalated;

  // Blocked both ways — say so plainly rather than pretending either tier worked.
  escalated.receipt.note = `blocked both ways — fetch: ${result.receipt.status}, render: ${escalated.receipt.status}`;
  return escalated;
}
