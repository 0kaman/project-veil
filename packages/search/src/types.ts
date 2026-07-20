/**
 * Search types + the receipt. Same discipline as @veil/read: every search
 * declares what it did and what it does NOT have, so a caller never guesses.
 */

/** Where the results came from. `cache` matters: searches can't be parallelised
 * (Brave free tier is 1/sec), so a cache hit is the difference between 0ms and a
 * rate-limited wait. */
export type SearchVia = "brave" | "cache";

/**
 * - `ok`           — results returned.
 * - `empty`        — the query ran but Brave found nothing.
 * - `rate-limited` — Brave's own 429; back off and retry, or rely on cache.
 * - `no-key`       — BRAVE_API_KEY isn't set. A config problem, said out loud.
 * - `error`        — Brave returned a non-200 we can't interpret.
 */
export type SearchStatus = "ok" | "empty" | "rate-limited" | "no-key" | "error";

/** One projected result — the useful ~90 tokens, not Brave's ~670 of metadata. */
export interface Result {
  title: string;
  url: string;
  /** Brave's snippet, HTML stripped. 40–68 words; often answers a shallow
   * question outright without a single page fetch. */
  description: string;
  /** Human age string if Brave supplied one ("2 days ago"). */
  age?: string;
}

export interface SearchReceipt {
  via: SearchVia;
  query: string;
  ms: number;
  status: SearchStatus;
  /** Results returned after projection + count cap. */
  count: number;
  cached: boolean;
  note?: string;
}

export interface SearchResult {
  receipt: SearchReceipt;
  results: Result[];
}

export function formatSearchReceipt(r: SearchReceipt): string {
  const bits = [`via: ${r.via}`, `${r.ms}ms`];
  if (r.status === "ok") bits.push(`${r.count} results`);
  else {
    bits.push(r.status.toUpperCase());
    if (r.note) bits.push(`— ${r.note}`);
  }
  return bits.join(" · ");
}
