/**
 * Direct-API execution — replay a captured request instead of re-simulating the
 * interaction that produced it.
 *
 * The capture layer records the full real request each interaction fired. This
 * module PARAMETERIZES that template (edit fields / query / headers) and FIRES
 * it through the page's own fetch — inheriting cookies, session, and any
 * app-added auth/CSRF headers — so the request looks exactly like the one the UI
 * would have made, minus the dispatch + settle + graph-rebuild overhead.
 *
 * `applyEdits` is pure (unit-tested without a browser); `fireRequest` is the
 * thin CDP execution.
 */
import type { CDPClient } from "./cdp-client.js";
import type { CapturedRequest } from "../graph/model.js";

export interface ReplayEdits {
  /** Fields merged into the request body (JSON deep-merge, or form-urlencoded set). */
  body?: Record<string, unknown>;
  /** Query parameters set on the URL. */
  query?: Record<string, string>;
  /** Headers added/overridden for this replay. */
  headers?: Record<string, string>;
}

export interface ConcreteRequest {
  method: string;
  url: string;
  headers: Record<string, string>;
  body?: string;
}

export interface ReplayResult {
  status: number;
  statusText: string;
  ok: boolean;
  headers: Record<string, string>;
  body: string;
  /** Parsed JSON body when the response is JSON, else undefined. */
  json?: unknown;
}

function lowerKeys(h: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(h)) out[k.toLowerCase()] = v;
  return out;
}

/** Recursive merge for nested JSON bodies (arrays and scalars replace). */
function deepMerge(base: unknown, patch: Record<string, unknown>): unknown {
  if (typeof base !== "object" || base === null || Array.isArray(base)) return patch;
  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  for (const [k, v] of Object.entries(patch)) {
    if (
      typeof v === "object" && v !== null && !Array.isArray(v) &&
      typeof out[k] === "object" && out[k] !== null && !Array.isArray(out[k])
    ) {
      out[k] = deepMerge(out[k], v as Record<string, unknown>);
    } else {
      out[k] = v;
    }
  }
  return out;
}

function safeParseJson(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return undefined;
  }
}

/** Apply edits to a captured template, producing a concrete request. Pure. */
export function applyEdits(tmpl: CapturedRequest, edits?: ReplayEdits): ConcreteRequest {
  const headers = { ...tmpl.headers, ...(edits?.headers ?? {}) };
  let url = tmpl.url;
  let body = tmpl.body;

  if (edits?.query && Object.keys(edits.query).length > 0) {
    const u = new URL(url);
    for (const [k, v] of Object.entries(edits.query)) u.searchParams.set(k, v);
    url = u.toString();
  }

  if (edits?.body && Object.keys(edits.body).length > 0) {
    const ct = (lowerKeys(headers)["content-type"] ?? "").toLowerCase();
    const looksForm = ct.includes("form-urlencoded") || (!!body && !ct.includes("json") && /^[^={}]+=[^&]*/.test(body));
    if (looksForm) {
      const params = new URLSearchParams(body ?? "");
      for (const [k, v] of Object.entries(edits.body)) params.set(k, String(v));
      body = params.toString();
    } else {
      // JSON (the common case) — deep-merge into the parsed body.
      const parsed = body ? safeParseJson(body) ?? {} : {};
      body = JSON.stringify(deepMerge(parsed, edits.body));
    }
  }

  return { method: tmpl.method, url, headers, body };
}

/** Fire a concrete request through the page's own fetch and return the response. */
export async function fireRequest(cdp: CDPClient, req: ConcreteRequest): Promise<ReplayResult> {
  const hasBody = req.body != null && req.method !== "GET" && req.method !== "HEAD";
  const expr =
    `(async () => {` +
    `const r = await fetch(${JSON.stringify(req.url)}, {` +
    `method: ${JSON.stringify(req.method)},` +
    `headers: ${JSON.stringify(req.headers)},` +
    (hasBody ? `body: ${JSON.stringify(req.body)},` : ``) +
    `credentials: 'include'});` +
    `const body = await r.text();` +
    `const headers = {}; r.headers.forEach((v,k)=>{headers[k]=v;});` +
    `return { status: r.status, statusText: r.statusText, ok: r.ok, headers, body };` +
    `})()`;

  const res = (await cdp.send("Runtime.evaluate", {
    expression: expr,
    awaitPromise: true,
    returnByValue: true,
  })) as { result?: { value?: Omit<ReplayResult, "json"> }; exceptionDetails?: { text?: string } };

  if (res.exceptionDetails || !res.result?.value) {
    throw new Error(`replay failed: ${res.exceptionDetails?.text ?? "no result"}`);
  }
  const value = res.result.value;
  return { ...value, json: safeParseJson(value.body) };
}
