/**
 * Replay — fire a captured request directly, without re-driving the DOM.
 *
 * Staleness is fixed by REFRESH AT FIRE TIME, not by a TTL (DECISIONS
 * 2026-07-25). Measured: essentially every real POST form carries a CSRF token
 * (7/7 found), names are site-specific and unguessable (`authenticity_token`,
 * `fkey`, `csrfmiddlewaretoken`, `_token`), and those tokens are re-readable
 * from the live DOM and session-stable. A session IS an open tab, so the current
 * token is right there when we fire.
 *
 * Verified against a local server implementing the three CSRF schemes real
 * frameworks use — refresh is strictly better than a cached value:
 *     session-scoped   stale 200 · refreshed 200
 *     rotating         stale 200 · refreshed 200
 *     single-use       stale 403 · refreshed 200   ← the hard case
 *
 * THE RESIDUAL, precisely: refresh reads whatever the page CURRENTLY holds. If
 * the app re-rendered since capture it gets a genuinely new token; if it hasn't,
 * re-reading returns the same captured value and refresh degenerates to stale.
 * That's definitional, not a guess. So on a rejection the honest recovery is
 * re-perceive or fall back to veil_do — never a blind retry.
 *
 * THE SECOND RESIDUAL — REPLAY DESYNCHRONIZES A SINGLE-USE-TOKEN PAGE. Measured
 * 2026-07-25 with a server-side instrumented loop (5 × click-then-replay):
 *
 *     iter | click            | replay
 *       1  | 200 ok           | 200 ok    refreshed=[body:csrf_token]
 *       2  | 403 SPENT        | 403 spent refreshed=[body:csrf_token]
 *      3-5 | 403 SPENT        | 403 spent
 *
 * A real click completes the app's handshake: response → the page's own `.then`
 * installs `nextToken`. Replay fires through raw fetch, so that handler never
 * runs — the token is consumed server-side and the successor is dropped on the
 * floor. The page is left holding a spent token, and from then on EVERY REAL
 * CLICK FAILS TOO, with no way to recover on its own (a 403 carries no new
 * token). Note this is NOT the first residual: `refreshed` is non-empty on those
 * 403 rows, i.e. the page did hand over something newer than the template — it
 * was spent, by us.
 *
 * Handled by measurement, never by guessing at response shapes (writing an
 * app-specific `nextToken` back into the DOM is exactly the inference this
 * project refuses).
 *
 * CRUCIALLY, the evidence runs the other way round. The first cut of this marked
 * a token spent because a replay SUCCEEDED, and inferred desync from "the page
 * still holds the value we sent". That inference is invalid, and the probe table
 * above says why: on session-scoped and rotating schemes — two of the three, and
 * the common ones (Django, Rails) — the page holds the same token because it is
 * STILL VALID, not because we burned it. Measured against a reusable-token
 * server, that cut reported `desynced` on a replay that broke nothing, then
 * refused replays #2 and #3 which would each have returned 200.
 *
 * So a token counts as spent only on evidence the SERVER supplied, and only when
 * that evidence is actually ABOUT the token:
 *   - the replay carried NO caller edits. A 403/422 on a payload we changed is
 *     evidence about the payload, not the token. Measured: a Rails-style 422
 *     ("quantity must be positive") on an edited replay marked a perfectly valid
 *     session token spent, and the next clean replay — which returns 200 — was
 *     refused without firing. This guard is structural, not a phrase match, so it
 *     holds in any language.
 *   - AND the status is a rejection (401/403/419/422) of a value that PREVIOUSLY
 *     WORKED in this session. Then it is confirmed one-shot and now spent; if the
 *     page still holds it, the page is genuinely desynchronized — say so.
 *   - BEFORE firing, refuse only when every token we would send is in that
 *     confirmed-spent set.
 *
 * Cost: one wasted 403 per single-use node, instead of zero. RESIDUAL: an
 * UNEDITED replay rejected for a reason that isn't the token (stock gone, rate
 * limit) is still read as a spent token, costing a false refusal. That is the
 * cheap direction — the recovery it names, re-perceive or veil_do, is the right
 * move anyway when the server starts rejecting a request that used to work.
 */
import type { CDPClient } from "./cdp-client.js";
import type { CapturedRequest } from "./capture.js";
import { debugLog } from "../debug.js";

/** Field names that carry one-shot / session-bound material worth refreshing. */
const TOKENISH = /csrf|xsrf|_token|authenticity|nonce|verification|fkey|state$/i;

export interface ReplayEdits {
  /** Merged into a JSON body, or set on a form-urlencoded one. */
  body?: Record<string, unknown>;
  /** Set on the URL's query string. */
  query?: Record<string, string>;
  /** Added to / overriding request headers. */
  headers?: Record<string, string>;
}

export interface ReplayResponse {
  status: number;
  statusText: string;
  contentType?: string;
  /** Response body, truncated — a replay returns DATA, not a document dump. */
  body: string;
  truncated: boolean;
}

export interface ReplayOutcome {
  ok: boolean;
  ms: number;
  method: string;
  url: string;
  response?: ReplayResponse;
  /** Volatile fields that were refreshed from the live page, by name. */
  refreshed: string[];
  /** Fields the caller changed, by name — the receipt reports what differs
   * from the captured original. One sighting is not a schema. */
  edited: string[];
  /** Edits naming a field the captured request never had — see Prepared. */
  unknownEdits: string[];
  /** Token VALUES this request carried, so the session can keep its ledger:
   * these WORKED on success, and are confirmed SPENT if later rejected. */
  tokensSent: string[];
  /** Confirmed by a REJECTION of a token that previously worked, with the page
   * still holding it: the page is out of step with the server, so real clicks
   * fail too until it re-renders. Never inferred from a success. */
  desynced?: boolean;
  /** Set when we declined to fire because every token would be known-spent. */
  staleRefusal?: string;
  error?: string;
}

/** Read every token-ish value the live page currently exposes, by field name. */
const READ_TOKENS = `(function(){
  var out = {};
  try {
    document.querySelectorAll('meta[name],meta[property]').forEach(function(m){
      var n = m.getAttribute('name') || m.getAttribute('property') || '';
      if (/csrf|xsrf|token|nonce/i.test(n)) out[n] = m.getAttribute('content') || '';
    });
    document.querySelectorAll('input[type=hidden][name]').forEach(function(i){
      out[i.getAttribute('name')] = i.value || '';
    });
  } catch (e) {}
  return JSON.stringify(out);
})()`;

async function liveTokens(client: CDPClient): Promise<Record<string, string>> {
  try {
    const r = (await client.send("Runtime.evaluate", {
      expression: READ_TOKENS,
      returnByValue: true,
    })) as { result?: { value?: string } };
    return r.result?.value ? (JSON.parse(r.result.value) as Record<string, string>) : {};
  } catch (err) {
    debugLog("replay: token read failed", err);
    return {};
  }
}

/** Case-insensitive lookup — `fkey` and `fKey` are the same token on SO. */
function findToken(tokens: Record<string, string>, name: string): string | undefined {
  if (tokens[name] !== undefined) return tokens[name];
  const lower = name.toLowerCase();
  for (const [k, v] of Object.entries(tokens)) if (k.toLowerCase() === lower) return v;
  return undefined;
}

function isJson(headers: Record<string, string>): boolean {
  const ct = Object.entries(headers).find(([k]) => k.toLowerCase() === "content-type")?.[1] ?? "";
  return ct.includes("json");
}

export interface Prepared {
  url: string;
  headers: Record<string, string>;
  body?: string;
  refreshed: string[];
  edited: string[];
  /** Edits whose key the CAPTURED request never had. Almost always a mistake —
   * either the wrong template or a guessed field name — and the server usually
   * ignores it, so the reply is a 200 that did nothing you asked for. Measured:
   * a replay edited `search=` onto Wikipedia's cirrus-config-dump endpoint and
   * got `{"warnings":{"main":"Unrecognized parameter: search."}}` behind a
   * cheerful `200`. Silence there is the failure this project designs out. */
  unknownEdits: string[];
}

/**
 * The token VALUES a prepared request actually carries, wherever they live.
 * Values, not names: what identifies a spent token is the string the server
 * consumed, and the same value can travel as a header on one app and a body
 * field on the next.
 */
export function tokenValues(p: Prepared): string[] {
  const out = new Set<string>();
  const take = (k: string, v: unknown) => {
    if (TOKENISH.test(k) && typeof v === "string" && v) out.add(v);
  };
  try {
    for (const [k, v] of new URL(p.url).searchParams) take(k, v);
  } catch {
    /* unparseable url — nothing to read */
  }
  for (const [k, v] of Object.entries(p.headers)) take(k, v);
  if (p.body !== undefined) {
    if (isJson(p.headers)) {
      try {
        for (const [k, v] of Object.entries(JSON.parse(p.body) as Record<string, unknown>)) {
          take(k, v);
        }
      } catch {
        /* claimed JSON, wasn't */
      }
    } else {
      for (const [k, v] of new URLSearchParams(p.body)) take(k, v);
    }
  }
  return [...out];
}

/**
 * Build the concrete request: refresh volatile fields from the live page, then
 * apply the caller's edits. Pure apart from the token read — testable.
 */
export function applyEdits(
  tmpl: CapturedRequest,
  edits: ReplayEdits | undefined,
  tokens: Record<string, string>,
): Prepared {
  const refreshed: string[] = [];
  const edited: string[] = [];
  const unknownEdits: string[] = [];

  // ── URL + query ──────────────────────────────────────────────────────────
  let url = tmpl.url;
  try {
    const u = new URL(tmpl.url);
    for (const key of [...u.searchParams.keys()]) {
      if (!TOKENISH.test(key)) continue;
      const fresh = findToken(tokens, key);
      if (fresh !== undefined && fresh !== u.searchParams.get(key)) {
        u.searchParams.set(key, fresh);
        refreshed.push(`query:${key}`);
      }
    }
    const hadQuery = new Set(u.searchParams.keys());
    for (const [k, v] of Object.entries(edits?.query ?? {})) {
      u.searchParams.set(k, v);
      edited.push(`query:${k}`);
      if (!hadQuery.has(k)) unknownEdits.push(`query:${k}`);
    }
    url = u.toString();
  } catch {
    /* keep the raw url */
  }

  // ── headers ──────────────────────────────────────────────────────────────
  const headers: Record<string, string> = { ...tmpl.headers };
  for (const key of Object.keys(headers)) {
    if (!TOKENISH.test(key)) continue;
    // x-csrf-token ↔ meta[name=csrf-token]
    const fresh = findToken(tokens, key) ?? findToken(tokens, key.replace(/^x-/i, ""));
    if (fresh !== undefined && fresh !== headers[key]) {
      headers[key] = fresh;
      refreshed.push(`header:${key}`);
    }
  }
  const hadHeader = new Set(Object.keys(headers).map((k) => k.toLowerCase()));
  for (const [k, v] of Object.entries(edits?.headers ?? {})) {
    headers[k] = v;
    edited.push(`header:${k}`);
    if (!hadHeader.has(k.toLowerCase())) unknownEdits.push(`header:${k}`);
  }

  // ── body ─────────────────────────────────────────────────────────────────
  let body = tmpl.postData;
  if (body !== undefined) {
    if (isJson(headers)) {
      try {
        const parsed = JSON.parse(body) as Record<string, unknown>;
        for (const key of Object.keys(parsed)) {
          if (!TOKENISH.test(key)) continue;
          const fresh = findToken(tokens, key);
          if (fresh !== undefined && fresh !== parsed[key]) {
            parsed[key] = fresh;
            refreshed.push(`body:${key}`);
          }
        }
        const hadKey = new Set(Object.keys(parsed));
        for (const [k, v] of Object.entries(edits?.body ?? {})) {
          parsed[k] = v;
          edited.push(`body:${k}`);
          if (!hadKey.has(k)) unknownEdits.push(`body:${k}`);
        }
        body = JSON.stringify(parsed);
      } catch {
        debugLog("replay: body claimed JSON but did not parse — left untouched");
      }
    } else {
      const params = new URLSearchParams(body);
      for (const key of [...params.keys()]) {
        if (!TOKENISH.test(key)) continue;
        const fresh = findToken(tokens, key);
        if (fresh !== undefined && fresh !== params.get(key)) {
          params.set(key, fresh);
          refreshed.push(`body:${key}`);
        }
      }
      const hadField = new Set(params.keys());
      for (const [k, v] of Object.entries(edits?.body ?? {})) {
        params.set(k, typeof v === "string" ? v : JSON.stringify(v));
        edited.push(`body:${k}`);
        if (!hadField.has(k)) unknownEdits.push(`body:${k}`);
      }
      body = params.toString();
    }
  } else if (edits?.body) {
    // No captured body but the caller wants one — send JSON.
    body = JSON.stringify(edits.body);
    for (const k of Object.keys(edits.body)) edited.push(`body:${k}`);
    if (!Object.keys(headers).some((h) => h.toLowerCase() === "content-type")) {
      headers["content-type"] = "application/json";
    }
  }

  return { url, headers, body, refreshed, edited, unknownEdits };
}

/** Headers the browser refuses to let fetch() set. */
const FORBIDDEN = /^(host|connection|content-length|origin|referer|cookie|sec-|:|accept-encoding)/i;

/**
 * Fire the prepared request through the PAGE's own fetch, so it inherits
 * cookies, origin and CSP exactly as the real interaction would have.
 */
export async function fireRequest(
  client: CDPClient,
  method: string,
  prepared: Prepared,
): Promise<ReplayResponse> {
  const headers = Object.fromEntries(
    Object.entries(prepared.headers).filter(([k]) => !FORBIDDEN.test(k)),
  );
  const init = {
    method,
    headers,
    ...(prepared.body !== undefined && { body: prepared.body }),
    credentials: "include" as const,
  };
  const expr = `(async function(){
    try {
      var r = await fetch(${JSON.stringify(prepared.url)}, ${JSON.stringify(init)});
      var t = await r.text();
      return JSON.stringify({ status: r.status, statusText: r.statusText,
        contentType: r.headers.get('content-type') || '', body: t.slice(0, 8000),
        truncated: t.length > 8000 });
    } catch (e) {
      return JSON.stringify({ status: 0, statusText: String(e && e.message || e),
        body: '', truncated: false });
    }
  })()`;

  const r = (await client.send("Runtime.evaluate", {
    expression: expr,
    awaitPromise: true,
    returnByValue: true,
  })) as { result?: { value?: string } };

  if (!r.result?.value) {
    return { status: 0, statusText: "no response from page", body: "", truncated: false };
  }
  return JSON.parse(r.result.value) as ReplayResponse;
}

/** Statuses a framework uses to reject a CSRF token (Laravel 419, Rails 422). */
const TOKEN_REJECTED = new Set([401, 403, 419, 422]);

/** What this session has learned about token values, from the server only. */
export interface TokenLedger {
  /** Values a replay has successfully sent. Not proof of anything on its own. */
  worked: ReadonlySet<string>;
  /** Values rejected AFTER having worked — confirmed one-shot, and now spent. */
  spent: ReadonlySet<string>;
}

export async function replayRequest(
  client: CDPClient,
  tmpl: CapturedRequest,
  edits?: ReplayEdits,
  ledger?: TokenLedger,
): Promise<ReplayOutcome> {
  const t0 = Date.now();
  const tokens = await liveTokens(client);
  const prepared = applyEdits(tmpl, edits, tokens);
  const tokensSent = tokenValues(prepared);
  const base = {
    ms: 0,
    method: tmpl.method,
    url: prepared.url,
    refreshed: prepared.refreshed,
    edited: prepared.edited,
    unknownEdits: prepared.unknownEdits,
    tokensSent,
  };

  // Every token this would carry is one the SERVER has already rejected after it
  // worked — confirmed one-shot and spent, so firing is a guaranteed rejection.
  // Refusing costs nothing and, unlike a 403, names the recovery.
  if (tokensSent.length > 0 && ledger && tokensSent.every((v) => ledger.spent.has(v))) {
    return {
      ...base,
      ok: false,
      ms: Date.now() - t0,
      staleRefusal:
        `the page still holds the token an earlier replay already consumed, so this ` +
        `request would be rejected. Re-perceive the page (veil_open) to pick up a ` +
        `fresh token, or use veil_do to perform the interaction for real.`,
    };
  }

  try {
    const response = await fireRequest(client, tmpl.method, prepared);
    const ok = response.status >= 200 && response.status < 400;
    // Desync is claimed ONLY on server evidence that is about the TOKEN: an
    // unedited request whose previously-working token was rejected, with the page
    // still holding it. A success proves nothing (a reusable token looks
    // identical), and a rejected edit proves nothing about the token.
    let desynced: boolean | undefined;
    if (
      !ok &&
      TOKEN_REJECTED.has(response.status) &&
      prepared.edited.length === 0 && // a rejected EDIT indicts the edit, not the token
      ledger &&
      tokensSent.some((v) => ledger.worked.has(v))
    ) {
      const held = new Set(Object.values(await liveTokens(client)));
      desynced = tokensSent.some((v) => ledger.worked.has(v) && held.has(v));
      if (desynced) debugLog("replay: page holds a token the server has now rejected");
    }
    return { ...base, ok, ms: Date.now() - t0, response, ...(desynced && { desynced }) };
  } catch (err) {
    return {
      ...base,
      ok: false,
      ms: Date.now() - t0,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
