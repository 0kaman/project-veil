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
  getOutline,
  hasScripts,
  rawText,
  readabilityExtract,
} from "./extract.js";
import type { HandleStore } from "./handles.js";
import type { Receipt } from "./receipt.js";

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
    timeoutMs: n(process.env.VEIL_READ_TIMEOUT_MS, 10_000),
    userAgent: process.env.VEIL_READ_UA ?? CHROME_UA,
  };
}

export interface FetchResponse {
  status: number;
  url: string;
  text(): Promise<string>;
}
export type FetchLike = (url: string, init?: unknown) => Promise<FetchResponse>;

const DOORMAN_STATUS = new Set([401, 403, 429, 503]);
const CHALLENGE =
  /captcha|are you a robot|unusual traffic|cf-challenge|challenge-platform|please enable (java)?script|checking your browser|verify you are human/i;

/** Cut text to a word budget on paragraph boundaries — never mid-paragraph. */
function truncateToParagraphs(text: string, budgetWords: number): { text: string; words: number } {
  const paras = text.split(/\n\n+/);
  const kept: string[] = [];
  let words = 0;
  for (const p of paras) {
    const w = countWords(p);
    if (words + w > budgetWords && kept.length > 0) break;
    kept.push(p);
    words += w;
  }
  return { text: kept.join("\n\n"), words };
}

export async function performRead(
  url: string,
  deps: { fetchImpl: FetchLike; store: HandleStore; config: ReadConfig },
): Promise<ReadResult> {
  const { fetchImpl, store, config } = deps;
  const t0 = Date.now();

  const base = (over: Partial<Receipt>): Receipt => ({
    via: "fetch",
    url,
    finalUrl: url,
    httpStatus: null,
    ms: Date.now() - t0,
    status: "fetch-failed",
    extractor: "none",
    words: 0,
    totalWords: 0,
    rawWords: 0,
    truncated: false,
    ...over,
  });

  // 1. Fetch.
  let res: FetchResponse;
  let html: string;
  try {
    res = await fetchImpl(url, {
      headers: { "user-agent": config.userAgent, accept: "text/html,application/xhtml+xml" },
      redirect: "follow",
      signal: AbortSignal.timeout(config.timeoutMs),
    });
    html = await res.text();
  } catch (err) {
    const name = err instanceof Error ? err.name : "Error";
    const detail = name === "TimeoutError" ? `timed out after ${config.timeoutMs}ms` : name;
    return {
      receipt: base({ status: "fetch-failed", note: detail }),
      title: null,
      text: "",
      outline: [],
      handle: null,
    };
  }

  const httpStatus = res.status;
  const finalUrl = res.url || url;

  // 2. Hard doorman — a refusal status. No point extracting; there's no page.
  if (DOORMAN_STATUS.has(httpStatus)) {
    return {
      receipt: base({
        finalUrl,
        httpStatus,
        status: "doorman",
        note: `HTTP ${httpStatus} — server refused; needs the engine (may also be blocked there)`,
      }),
      title: null,
      text: "",
      outline: [],
      handle: null,
    };
  }

  // 3. Extract: Readability, then the fallback if it declined content that's present.
  //    Challenge-marker detection is DEFERRED to classification: a real article
  //    (Wikipedia) can contain "enable javascript" in a noscript tag without
  //    being a challenge page. Trust extracted content over stray phrases; only
  //    a page that is ALSO thin is a genuine doorman.
  const rawWords = countWords(rawText(html));
  const primary = readabilityExtract(html);
  let text = primary.text;
  let extractor: Receipt["extractor"] = "readability";
  let words = countWords(text);

  if (words < config.cleanWords && rawWords >= config.fallbackRaw) {
    const fb = fallbackExtract(html);
    const fbWords = countWords(fb.text);
    if (fbWords > words) {
      text = fb.text;
      words = fbWords;
      extractor = "fallback";
    }
  }

  const title = primary.title ?? documentTitle(html);

  // 4. Classify a thin result: doorman (challenge), JS shell, or genuinely empty.
  //    Content was too thin to be a real read — now the stray-phrase check is
  //    safe, because a real article would have passed the okFloor above.
  if (words < config.okFloor) {
    let status: Receipt["status"];
    let note: string;
    if (CHALLENGE.test(html.slice(0, 6000))) {
      status = "doorman";
      note = "bot challenge — server refused; needs the engine (may also be blocked there)";
    } else if (rawWords < 200 && hasScripts(html)) {
      status = "js-shell";
      note = "no content in the HTML — it's behind JavaScript; use the engine";
    } else {
      status = "empty";
      note = `almost no readable text (${rawWords} raw words)`;
    }
    return {
      receipt: base({ finalUrl, httpStatus, rawWords, status, extractor: "none", note }),
      title,
      text: "",
      outline: [],
      handle: null,
    };
  }

  // 5. It's a real read. Apply the budget; store a handle only if we truncated.
  const outline = getOutline(html);
  const totalWords = words;
  let outText = text;
  let truncated = false;
  let handle: string | null = null;

  if (words > config.budgetWords) {
    const cut = truncateToParagraphs(text, config.budgetWords);
    outText = cut.text;
    words = cut.words;
    truncated = true;
    handle = store.put({ url: finalUrl, title, fullText: text, outline });
  }

  const note =
    totalWords < config.cleanWords ? `short page (${totalWords} words) — may be a stub` : undefined;

  return {
    receipt: base({
      finalUrl,
      httpStatus,
      status: "ok",
      extractor,
      words,
      totalWords,
      rawWords,
      truncated,
      note,
    }),
    title,
    text: outText,
    outline,
    handle,
  };
}
