/**
 * @veil/search — the first rung. Brave in, projected results out, never a browser.
 *
 *   const search = new Search();               // reads BRAVE_API_KEY from env
 *   const r = await search.run("fusion energy latest");
 *   r.receipt.status   // "ok" | "empty" | "rate-limited" | "no-key" | "error"
 *   r.results          // [{ title, url, description, age? }]
 *
 * Zero runtime deps — pure fetch + projection. Two behaviours the free tier
 * forces and that belong in the client, not every caller:
 *   - a CACHE: the same query is stable for hours, and a hit skips the rate gate.
 *   - a RATE GATE: Brave free is 1 query/sec; requests are SPACED, not rejected,
 *     so a burst serialises instead of failing.
 *
 * Never throws — every failure comes back as a receipt (docs/DECISIONS.md).
 */
export type {
  Result,
  SearchResult,
  SearchReceipt,
  SearchStatus,
  SearchVia,
} from "./types.js";
export { formatSearchReceipt } from "./types.js";
export { projectBrave } from "./project.js";

import type { Result, SearchResult, SearchReceipt } from "./types.js";
import { projectBrave } from "./project.js";

const ENDPOINT = "https://api.search.brave.com/res/v1/web/search";
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export interface SearchFetchResponse {
  status: number;
  text(): Promise<string>;
}
export type SearchFetchLike = (url: string, init?: unknown) => Promise<SearchFetchResponse>;

export interface SearchOptions {
  apiKey?: string;
  fetchImpl?: SearchFetchLike;
  /** Results to return after projection. Default 10 (Brave's typical page). */
  count?: number;
  /** Cache lifetime. Default 1h — Brave results are stable for hours. */
  cacheTtlMs?: number;
  /** Minimum spacing between real Brave calls. Default 1100ms (free tier: 1/sec). */
  minIntervalMs?: number;
}

interface CacheEntry {
  at: number;
  results: Result[];
}

export class Search {
  private readonly apiKey: string | undefined;
  private readonly fetchImpl: SearchFetchLike;
  private readonly count: number;
  private readonly cacheTtlMs: number;
  private readonly minIntervalMs: number;

  private readonly cache = new Map<string, CacheEntry>();
  // Rate gate: a promise chain that serialises real calls and spaces them.
  private gate: Promise<void> = Promise.resolve();
  private lastCallAt = 0;

  constructor(opts: SearchOptions = {}) {
    // Guarded env parse: Number(undefined) is NaN, and `?? ` does NOT catch NaN,
    // so a naive chain would leave the field NaN when the env var is unset.
    const env = (name: string, d: number) => {
      const v = process.env[name];
      const n = v ? Number(v) : NaN;
      return Number.isFinite(n) ? n : d;
    };
    this.apiKey = opts.apiKey ?? process.env.BRAVE_API_KEY;
    this.fetchImpl = opts.fetchImpl ?? (globalThis.fetch as unknown as SearchFetchLike);
    this.count = opts.count ?? env("VEIL_SEARCH_COUNT", 10);
    this.cacheTtlMs = opts.cacheTtlMs ?? env("VEIL_SEARCH_TTL_MS", 3_600_000);
    this.minIntervalMs = opts.minIntervalMs ?? env("VEIL_SEARCH_INTERVAL_MS", 1_100);
  }

  /** Run a search. Never throws — failures are receipts. */
  async run(query: string): Promise<SearchResult> {
    const t0 = Date.now();
    const key = query.trim().toLowerCase();

    // 1. Cache — free, and skips the rate gate entirely.
    const hit = this.cache.get(key);
    if (hit && Date.now() - hit.at < this.cacheTtlMs) {
      return {
        receipt: this.receipt("cache", query, t0, "ok", hit.results.length, true),
        results: hit.results,
      };
    }

    // 2. Config problem, said out loud rather than thrown.
    if (!this.apiKey) {
      return {
        receipt: this.receipt("brave", query, t0, "no-key", 0, false, "BRAVE_API_KEY is not set"),
        results: [],
      };
    }

    // 3. A real call — spaced behind the rate gate.
    return this.spaced(() => this.callBrave(query, key, t0));
  }

  private async callBrave(query: string, key: string, t0: number): Promise<SearchResult> {
    const url = `${ENDPOINT}?q=${encodeURIComponent(query)}&count=${this.count}`;
    let res: SearchFetchResponse;
    let body: string;
    try {
      res = await this.fetchImpl(url, {
        headers: { Accept: "application/json", "X-Subscription-Token": this.apiKey as string },
        signal: AbortSignal.timeout(10_000),
      });
      body = await res.text();
    } catch (err) {
      const name = err instanceof Error ? err.name : "Error";
      return {
        receipt: this.receipt("brave", query, t0, "error", 0, false, `fetch failed: ${name}`),
        results: [],
      };
    }

    if (res.status === 429) {
      return {
        receipt: this.receipt("brave", query, t0, "rate-limited", 0, false, "Brave 429 — back off"),
        results: [],
      };
    }
    if (res.status !== 200) {
      return {
        receipt: this.receipt("brave", query, t0, "error", 0, false, `HTTP ${res.status}`),
        results: [],
      };
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(body);
    } catch {
      return {
        receipt: this.receipt("brave", query, t0, "error", 0, false, "unparseable response"),
        results: [],
      };
    }

    const results = projectBrave(parsed, this.count);
    if (results.length === 0) {
      return {
        receipt: this.receipt("brave", query, t0, "empty", 0, false, "no results"),
        results: [],
      };
    }

    this.cache.set(key, { at: Date.now(), results });
    return { receipt: this.receipt("brave", query, t0, "ok", results.length, false), results };
  }

  /** Serialise real calls and space them by minIntervalMs. Cache hits never
   * reach here, so a warm query is always instant. */
  private spaced<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.gate.then(async () => {
      const wait = this.minIntervalMs - (Date.now() - this.lastCallAt);
      if (wait > 0) await sleep(wait);
      this.lastCallAt = Date.now();
      return fn();
    });
    // Advance the gate whether or not this call succeeded, so one failure can't
    // wedge the queue.
    this.gate = run.then(
      () => {},
      () => {},
    );
    return run;
  }

  private receipt(
    via: SearchReceipt["via"],
    query: string,
    t0: number,
    status: SearchReceipt["status"],
    count: number,
    cached: boolean,
    note?: string,
  ): SearchReceipt {
    return { via, query, ms: Date.now() - t0, status, count, cached, ...(note && { note }) };
  }
}
