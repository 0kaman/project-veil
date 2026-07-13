/**
 * Direct-API replay — parameterizing a captured request. applyEdits is pure, so
 * the whole edit matrix (JSON deep-merge, form-urlencoded, query, headers, GET)
 * is covered without a browser.
 */
import { describe, it, expect } from "vitest";
import { applyEdits } from "../browser/replay.js";
import type { CapturedRequest } from "../graph/model.js";

function tmpl(partial: Partial<CapturedRequest>): CapturedRequest {
  return {
    method: "POST",
    url: "https://api.x.com/cart",
    headers: { "content-type": "application/json" },
    body: '{"sku":"wh-1","qty":1}',
    triggerNodeId: "n",
    triggerEvent: "click",
    timestamp: 1,
    ...partial,
  };
}

describe("applyEdits", () => {
  it("returns the template unchanged when there are no edits", () => {
    const t = tmpl({});
    const c = applyEdits(t);
    expect(c).toEqual({ method: "POST", url: t.url, headers: t.headers, body: t.body });
  });

  it("deep-merges JSON body edits, preserving untouched fields", () => {
    const c = applyEdits(tmpl({ body: '{"sku":"wh-1","qty":1,"gift":{"wrap":false}}' }), {
      body: { qty: 5, gift: { wrap: true } },
    });
    expect(JSON.parse(c.body!)).toEqual({ sku: "wh-1", qty: 5, gift: { wrap: true } });
  });

  it("edits a form-urlencoded body without JSON-ifying it", () => {
    const c = applyEdits(
      tmpl({
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: "sku=wh-1&qty=1",
      }),
      { body: { qty: 5 } },
    );
    const params = new URLSearchParams(c.body);
    expect(params.get("sku")).toBe("wh-1");
    expect(params.get("qty")).toBe("5");
  });

  it("sets URL query parameters (GET replay)", () => {
    const c = applyEdits(
      tmpl({ method: "GET", url: "https://api.x.com/search?q=old&page=1", body: undefined }),
      { query: { q: "headphones", page: "2" } },
    );
    const u = new URL(c.url);
    expect(u.searchParams.get("q")).toBe("headphones");
    expect(u.searchParams.get("page")).toBe("2");
  });

  it("overrides/adds headers", () => {
    const c = applyEdits(tmpl({}), { headers: { "x-idempotency-key": "k1" } });
    expect(c.headers["x-idempotency-key"]).toBe("k1");
    expect(c.headers["content-type"]).toBe("application/json"); // original kept
  });

  it("builds a JSON body from scratch when the template had none", () => {
    const c = applyEdits(tmpl({ body: undefined }), { body: { hello: "world" } });
    expect(JSON.parse(c.body!)).toEqual({ hello: "world" });
  });

  it("combines body + query + header edits in one call", () => {
    const c = applyEdits(
      tmpl({ url: "https://api.x.com/cart?v=1" }),
      { body: { qty: 3 }, query: { v: "2" }, headers: { "x-test": "y" } },
    );
    expect(JSON.parse(c.body!).qty).toBe(3);
    expect(new URL(c.url).searchParams.get("v")).toBe("2");
    expect(c.headers["x-test"]).toBe("y");
  });
});
