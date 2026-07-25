import { describe, it, expect } from "vitest";
import { gateReplay, loadConfig } from "../config.js";
import { applyEdits, tokenValues } from "../browser/replay.js";
import { pickPrimary, type CapturedRequest } from "../browser/capture.js";

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

describe("pickPrimary — which fired request did the interaction MEAN?", () => {
  const req = (over: Partial<CapturedRequest>): CapturedRequest => ({
    requestId: "x", method: "GET", url: "https://x.test/", headers: {}, startedAt: 0, ...over,
  });
  // The real Wikipedia burst, in the order Chrome reported it.
  const wikipedia = [
    req({ url: "https://en.wikipedia.org/w/api.php?action=cirrus-config-dump&prop=usertesting" }),
    req({ url: "https://en.wikipedia.org/w/rest.php/v1/search/title?q=behaviour+graph&limit=10" }),
  ];

  it("prefers the request CARRYING the typed value over the one that merely fired first", () => {
    expect(pickPrimary(wikipedia, "behaviour graph")!.url).toContain("search/title");
  });

  it("decodes before matching — a typed space travels as + or %20", () => {
    expect(pickPrimary(wikipedia, "behaviour graph")!.url).toContain("q=behaviour+graph");
    const pct = [req({ url: "https://x.test/a" }), req({ url: "https://x.test/s?q=hello%20world" })];
    expect(pickPrimary(pct, "hello world")!.url).toContain("q=hello");
  });

  it("finds the value in a POST body too", () => {
    const reqs = [
      req({ url: "https://x.test/beacon" }),
      req({ method: "POST", url: "https://x.test/search", postData: '{"q":"behaviour graph"}' }),
    ];
    expect(pickPrimary(reqs, "behaviour graph")!.url).toContain("/search");
  });

  it("leaves CLICKS exactly as they were — no value, no change in behaviour", () => {
    // The path already verified on real sites (POST /post, GET /reply): mutations
    // first, then arrival order. Threading a value must not disturb it.
    expect(pickPrimary(wikipedia)!.url).toContain("cirrus-config-dump");
    const mixed = [req({ url: "https://x.test/a" }), req({ method: "POST", url: "https://x.test/b" })];
    expect(pickPrimary(mixed)!.url).toBe("https://x.test/b");
    expect(pickPrimary(mixed, "nothing matches this")!.url).toBe("https://x.test/b");
  });

  it("falls back to arrival order when nothing carries the value", () => {
    expect(pickPrimary(wikipedia, "unrelated")!.url).toContain("cirrus-config-dump");
    expect(pickPrimary([], "x")).toBeUndefined();
  });
});

describe("applyEdits — an edit naming a field the request never had", () => {
  it("flags a query param that is not in the captured URL", () => {
    // The measured case: `search=` edited onto cirrus-config-dump, which answered
    // 200 with "Unrecognized parameter: search".
    const p = applyEdits(tmpl({ url: "https://x.test/api?action=dump" }), { query: { search: "x" } }, {});
    expect(p.unknownEdits).toContain("query:search");
    expect(p.edited).toContain("query:search"); // still applied — we report, not refuse
  });

  it("stays silent when the param WAS in the captured request", () => {
    const p = applyEdits(tmpl({ url: "https://x.test/api?q=old" }), { query: { q: "new" } }, {});
    expect(p.unknownEdits).toEqual([]);
  });

  it("flags an unknown JSON body field, and not a known one", () => {
    const p = applyEdits(tmpl(), { body: { qty: 9, nonesuch: 1 } }, {});
    expect(p.unknownEdits).toEqual(["body:nonesuch"]);
  });

  it("flags an unknown form field", () => {
    const p = applyEdits(
      tmpl({ headers: { "content-type": "application/x-www-form-urlencoded" }, postData: "q=hi" }),
      { body: { page: "2" } },
      {},
    );
    expect(p.unknownEdits).toEqual(["body:page"]);
  });

  it("matches headers case-insensitively before calling one unknown", () => {
    const p = applyEdits(tmpl({ headers: { "Content-Type": "application/json" } }),
      { headers: { "content-type": "text/plain" } }, {});
    expect(p.unknownEdits).toEqual([]);
  });
});
