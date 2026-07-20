/**
 * @veil/read — the cheap rung. Fetch a page and return what it SAYS, no browser.
 *
 *   const reader = new Reader();
 *   const r = await reader.read("https://en.wikipedia.org/wiki/HTTP");
 *   r.receipt.status // "ok" | "js-shell" | "doorman" | "empty" | "fetch-failed"
 *   r.text           // the article, up to the budget
 *   r.handle         // set if truncated → reader.more(handle, "status codes")
 *
 * Everything a caller needs is on the receipt: it never has to guess why it got
 * what it got. That is the whole point (docs/DECISIONS.md, the receipt).
 */
export type { Receipt, ReadStatus, Extractor, Via } from "./receipt.js";
export { formatReceipt } from "./receipt.js";
export type { ReadResult, ReadConfig, FetchLike } from "./read.js";
export { HandleStore, type StoredRead, type Pull } from "./handles.js";
export {
  countWords,
  rawText,
  readabilityExtract,
  fallbackExtract,
  getOutline,
  documentTitle,
} from "./extract.js";

import { HandleStore } from "./handles.js";
import { defaultConfig, performRead, type FetchLike, type ReadConfig, type ReadResult } from "./read.js";
import type { Pull } from "./handles.js";

export interface ReaderOptions {
  /** Override the fetcher — tests inject a fixture server; prod uses global fetch. */
  fetchImpl?: FetchLike;
  /** Partial config override; unset fields fall back to env / defaults. */
  config?: Partial<ReadConfig>;
  /** Share a handle store across readers, or inject one for tests. */
  store?: HandleStore;
}

export class Reader {
  private readonly fetchImpl: FetchLike;
  private readonly store: HandleStore;
  private readonly config: ReadConfig;

  constructor(opts: ReaderOptions = {}) {
    this.fetchImpl = opts.fetchImpl ?? (globalThis.fetch as unknown as FetchLike);
    this.store = opts.store ?? new HandleStore();
    this.config = { ...defaultConfig(), ...opts.config };
  }

  /** Read a URL. Never throws — a failure comes back as a receipt. */
  read(url: string): Promise<ReadResult> {
    return performRead(url, { fetchImpl: this.fetchImpl, store: this.store, config: this.config });
  }

  /**
   * Pull more from a truncated read: with a query, the paragraphs mentioning it
   * (search-within-page); without, from the top. Returns null for an unknown
   * handle so the caller reports it rather than silently returning nothing.
   */
  more(handle: string, query?: string): (Pull & { handle: string }) | null {
    const pull = this.store.pull(handle, query, this.config.budgetWords);
    return pull ? { ...pull, handle } : null;
  }
}
