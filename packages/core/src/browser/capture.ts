/**
 * Capturing what an interaction fired — the other half of the moat, and the
 * foundation of the replay tier.
 *
 * ATTRIBUTION, honestly: this uses TEMPORAL attribution — requests that begin
 * between dispatching an action and the page settling are attributed to the node
 * acted on. v1 used async initiator stack frames, which is more precise but much
 * more machinery. Temporal attribution is correct for the common case (we just
 * clicked X, and these requests started immediately after) and its known failure
 * mode is ambient traffic: a background poll firing in the same window gets
 * misattributed.
 *
 * That failure mode is mitigated, not hidden: requests whose URL pattern was
 * ALREADY firing before the action are treated as ambient and excluded. Anything
 * that survives is reported with its method and URL so a caller can judge it.
 */
import type { CDPClient } from "./cdp-client.js";

export interface CapturedRequest {
  requestId: string;
  method: string;
  url: string;
  headers: Record<string, string>;
  postData?: string;
  resourceType?: string;
  startedAt: number;
  status?: number;
}

/** Collapse a URL to a shape, so `?page=2` and `?page=3` count as the same poll. */
export function urlPattern(url: string): string {
  try {
    const u = new URL(url);
    const path = u.pathname
      .split("/")
      .map((seg) =>
        /^\d+$/.test(seg) || /^[0-9a-f]{8,}$/i.test(seg) ? "{id}" : seg,
      )
      .join("/");
    return `${u.host}${path}`;
  } catch {
    return url;
  }
}

/**
 * Records requests on a session's tab. One instance lives per session; an
 * interaction takes a window out of it.
 */
export class NetworkRecorder {
  private requests = new Map<string, CapturedRequest>();
  /** Patterns seen at any point — the ambient baseline. */
  private seenPatterns = new Set<string>();
  private attached = false;

  constructor(private readonly client: CDPClient) {}

  attach(): void {
    if (this.attached) return;
    this.attached = true;
    this.client.on("Network.requestWillBeSent", this.onRequest);
    this.client.on("Network.responseReceived", this.onResponse);
  }

  detach(): void {
    if (!this.attached) return;
    this.attached = false;
    this.client.off("Network.requestWillBeSent", this.onRequest);
    this.client.off("Network.responseReceived", this.onResponse);
  }

  private onRequest = (p: unknown): void => {
    const e = p as {
      requestId?: string;
      type?: string;
      request?: { method?: string; url?: string; headers?: Record<string, string>; postData?: string };
    };
    if (!e.requestId || !e.request?.url) return;
    // Documents, XHR and fetch are the interesting ones; images/fonts/css are noise.
    const t = e.type ?? "";
    if (t !== "XHR" && t !== "Fetch" && t !== "Document") return;
    this.requests.set(e.requestId, {
      requestId: e.requestId,
      method: e.request.method ?? "GET",
      url: e.request.url,
      headers: e.request.headers ?? {},
      ...(e.request.postData && { postData: e.request.postData.slice(0, 64 * 1024) }),
      resourceType: t,
      startedAt: Date.now(),
    });
  };

  private onResponse = (p: unknown): void => {
    const e = p as { requestId?: string; response?: { status?: number } };
    if (!e.requestId) return;
    const r = this.requests.get(e.requestId);
    if (r && e.response?.status !== undefined) r.status = e.response.status;
  };

  /** Everything captured so far becomes the ambient baseline. */
  markBaseline(): void {
    for (const r of this.requests.values()) this.seenPatterns.add(urlPattern(r.url));
  }

  /**
   * Requests that started at or after `since` and are NOT part of the ambient
   * baseline. `markBaseline()` should have been called before the action.
   */
  since(sinceMs: number): CapturedRequest[] {
    const out: CapturedRequest[] = [];
    for (const r of this.requests.values()) {
      if (r.startedAt < sinceMs) continue;
      if (this.seenPatterns.has(urlPattern(r.url))) continue; // ambient poll
      out.push(r);
    }
    return out.sort((a, b) => a.startedAt - b.startedAt);
  }

  /** Bound memory on long-lived sessions — keep the most recent N. */
  prune(keep = 400): void {
    if (this.requests.size <= keep) return;
    const sorted = [...this.requests.values()].sort((a, b) => a.startedAt - b.startedAt);
    for (const r of sorted.slice(0, sorted.length - keep)) this.requests.delete(r.requestId);
  }
}

/** Pick the request most worth reporting/replaying: a mutation beats a GET. */
const MUTATING = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/** Does this request carry the text the user typed? Compared DECODED, because a
 * typed "behaviour graph" travels as `behaviour+graph` or `behaviour%20graph`
 * and a raw compare silently never matches. */
function carriesValue(r: CapturedRequest, value: string): boolean {
  const needle = value.trim().toLowerCase();
  if (!needle) return false;
  const decode = (s: string): string => {
    try {
      return decodeURIComponent(s.replace(/\+/g, " ")).toLowerCase();
    } catch {
      return s.toLowerCase();
    }
  };
  return decode(r.url).includes(needle) || (r.postData ? decode(r.postData).includes(needle) : false);
}

/**
 * Which of the requests an interaction fired is THE one it meant?
 *
 * Arrival order alone is wrong, measured: typing into Wikipedia's search box
 * fires `api.php?action=cirrus-config-dump` (telemetry) BEFORE
 * `rest.php/v1/search/title?q=behaviour+graph` (the search). First-wins learned
 * the telemetry call, and a later replay edited `search=` onto an endpoint with
 * no such parameter — the server replied "Unrecognized parameter: search" while
 * our receipt reported a clean 200.
 *
 * So when the action carried a VALUE, prefer the request carrying that value.
 * That is evidence, not a guess. Clicks have no value and are unaffected — they
 * keep mutations-first-then-arrival, the path already verified on real sites
 * (`POST /post` on httpbin, `GET /reply` on HN).
 */
export function pickPrimary(reqs: CapturedRequest[], value?: string): CapturedRequest | undefined {
  if (reqs.length === 0) return undefined;
  const mutations = reqs.filter((r) => MUTATING.has(r.method));
  const pool = mutations.length > 0 ? mutations : reqs;
  if (value) {
    const carrying = pool.filter((r) => carriesValue(r, value));
    if (carrying.length > 0) return carrying[0];
  }
  return pool[0];
}
