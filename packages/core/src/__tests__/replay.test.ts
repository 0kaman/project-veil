import { describe, it, expect } from "vitest";
import { gateReplay, loadConfig } from "../config.js";
import { applyEdits, tokenValues } from "../browser/replay.js";
import type { CapturedRequest } from "../browser/capture.js";

const tmpl = (over: Partial<CapturedRequest> = {}): CapturedRequest => ({
  requestId: "1",
  method: "POST",
  url: "https://shop.test/api/cart",
  headers: { "content-type": "application/json" },
  postData: JSON.stringify({ sku: "A1", qty: 1, csrf_token: "OLD" }),
  startedAt: 0,
  ...over,
});

describe("gateReplay — the security boundary", () => {
  const safe = loadConfig({ replay: "safe", replayDomains: [] });
  const all = loadConfig({ replay: "all", replayDomains: [] });
  const off = loadConfig({ replay: "off", replayDomains: [] });

  it("defaults to safe, not all", () => {
    // The default must be the cautious one: replaying a GET wastes a request,
    // replaying a POST can charge a card.
    expect(loadConfig({}).replay).toBe("safe");
  });

  it("off refuses everything, including GET", () => {
    expect(gateReplay(off, "GET", "https://x.test/a").allowed).toBe(false);
  });

  it("safe permits idempotent methods and refuses mutations, with a reason", () => {
    expect(gateReplay(safe, "GET", "https://x.test/a").allowed).toBe(true);
    expect(gateReplay(safe, "HEAD", "https://x.test/a").allowed).toBe(true);
    const post = gateReplay(safe, "POST", "https://x.test/a");
    expect(post.allowed).toBe(false);
    expect(post.reason).toMatch(/safe/);
    expect(post.reason).toMatch(/veil_do/); // points at the recovery
    for (const m of ["PUT", "PATCH", "DELETE"]) {
      expect(gateReplay(safe, m, "https://x.test/a").allowed).toBe(false);
    }
  });

  it("all permits mutations", () => {
    expect(gateReplay(all, "POST", "https://x.test/a").allowed).toBe(true);
    expect(gateReplay(all, "DELETE", "https://x.test/a").allowed).toBe(true);
  });

  it("an allowlist confines replay to those hosts, subdomains included", () => {
    const cfg = loadConfig({ replay: "all", replayDomains: ["shop.test"] });
    expect(gateReplay(cfg, "POST", "https://shop.test/api").allowed).toBe(true);
    expect(gateReplay(cfg, "POST", "https://api.shop.test/x").allowed).toBe(true);
    // a lookalike host must NOT pass
    expect(gateReplay(cfg, "POST", "https://evil-shop.test/x").allowed).toBe(false);
    expect(gateReplay(cfg, "POST", "https://elsewhere.test/x").allowed).toBe(false);
  });
});

describe("applyEdits — refresh at fire time", () => {
  it("substitutes a token-ish JSON body field with the LIVE value", () => {
    const p = applyEdits(tmpl(), undefined, { csrf_token: "FRESH" });
    expect(JSON.parse(p.body!).csrf_token).toBe("FRESH");
    expect(p.refreshed).toContain("body:csrf_token");
    // and leaves everything else alone
    expect(JSON.parse(p.body!).sku).toBe("A1");
  });

  it("refreshes form-urlencoded bodies too", () => {
    const p = applyEdits(
      tmpl({
        headers: { "content-type": "application/x-www-form-urlencoded" },
        postData: "q=hello&authenticity_token=OLD",
      }),
      undefined,
      { authenticity_token: "FRESH" },
    );
    expect(new URLSearchParams(p.body!).get("authenticity_token")).toBe("FRESH");
    expect(new URLSearchParams(p.body!).get("q")).toBe("hello");
  });

  it("matches token names case-insensitively (SO ships fkey AND fKey)", () => {
    const p = applyEdits(
      tmpl({ postData: JSON.stringify({ fKey: "OLD" }) }),
      undefined,
      { fkey: "FRESH" },
    );
    expect(JSON.parse(p.body!).fKey).toBe("FRESH");
  });

  it("refreshes token headers, including the x- prefixed form", () => {
    const p = applyEdits(
      tmpl({ headers: { "x-csrf-token": "OLD", "content-type": "application/json" } }),
      undefined,
      { "csrf-token": "FRESH" },
    );
    expect(p.headers["x-csrf-token"]).toBe("FRESH");
    expect(p.refreshed).toContain("header:x-csrf-token");
  });

  it("leaves non-token fields untouched — it refreshes, it doesn't rewrite", () => {
    const p = applyEdits(tmpl(), undefined, { sku: "SHOULD-NOT-APPLY", qty: "99" });
    const body = JSON.parse(p.body!);
    expect(body.sku).toBe("A1");
    expect(body.qty).toBe(1);
  });

  it("applies caller edits and reports them separately from refreshes", () => {
    const p = applyEdits(tmpl(), { body: { qty: 5 } }, { csrf_token: "FRESH" });
    expect(JSON.parse(p.body!).qty).toBe(5);
    expect(p.edited).toContain("body:qty");
    expect(p.refreshed).toContain("body:csrf_token");
    // the two are distinguishable — one sighting is not a schema, so the caller
    // must be able to see exactly what THEY changed
    expect(p.edited).not.toContain("body:csrf_token");
  });

  it("sets query params and refreshes token-ish ones", () => {
    const p = applyEdits(
      tmpl({ url: "https://shop.test/api?_token=OLD&page=1" }),
      { query: { page: "2" } },
      { _token: "FRESH" },
    );
    const u = new URL(p.url);
    expect(u.searchParams.get("_token")).toBe("FRESH");
    expect(u.searchParams.get("page")).toBe("2");
  });

  it("survives a body that claims JSON but isn't", () => {
    const p = applyEdits(tmpl({ postData: "not json at all" }), undefined, { csrf_token: "F" });
    expect(p.body).toBe("not json at all"); // left untouched, no throw
  });

  it("adds a JSON body when the template had none but the caller supplies edits", () => {
    const p = applyEdits(tmpl({ postData: undefined, headers: {} }), { body: { a: 1 } }, {});
    expect(JSON.parse(p.body!).a).toBe(1);
    expect(p.headers["content-type"]).toMatch(/json/);
  });
});

describe("tokenValues — what a request would spend", () => {
  it("finds token values in a JSON body", () => {
    expect(tokenValues(applyEdits(tmpl(), undefined, {}))).toEqual(["OLD"]);
  });

  it("finds them in headers and query too, and dedupes", () => {
    const p = applyEdits(
      tmpl({
        url: "https://shop.test/api?_token=T&page=1",
        headers: { "x-csrf-token": "T", "content-type": "application/json" },
        postData: JSON.stringify({ csrf_token: "T", sku: "A1" }),
      }),
      undefined,
      {},
    );
    expect(tokenValues(p)).toEqual(["T"]); // one value, three carriers
  });

  it("ignores non-token fields — spending is about tokens, not payload", () => {
    const p = applyEdits(tmpl({ postData: JSON.stringify({ sku: "A1", qty: 1 }) }), undefined, {});
    expect(tokenValues(p)).toEqual([]);
  });

  it("reads form-urlencoded bodies", () => {
    const p = applyEdits(
      tmpl({
        headers: { "content-type": "application/x-www-form-urlencoded" },
        postData: "q=hi&authenticity_token=AT",
      }),
      undefined,
      {},
    );
    expect(tokenValues(p)).toEqual(["AT"]);
  });
});
