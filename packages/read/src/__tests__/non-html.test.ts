/**
 * veil_read against things that are not HTML.
 *
 * Two defects, one omission. `performRead` never looked at `content-type`, so
 * every body went into an HTML pipeline:
 *   - a tagless body (markdown, JSON, CSV, plain text) parses to a document with
 *     a null `documentElement`, and linkedom's `document.body` getter THROWS on
 *     it — `veil_read` on a raw `.md` URL crashed with "Cannot destructure
 *     property 'firstElementChild'". Found by the PinchTab arena, 2026-07-31.
 *   - worse and unreported: a text body carrying any stray tag parses to an
 *     EMPTY body and comes back `empty · almost no readable text (0 raw words)`.
 *     RFC 7231's 32,091 words reported as zero. The crash is loud; this is
 *     confident and wrong.
 */
import { describe, it, expect } from "vitest";
import { Reader } from "../index.js";
import { fixture, mockFetch } from "./helpers.js";

const MARKDOWN = `# MCP agents

Veil exposes eight tools over stdio. The prime interface is the MCP server.

## Getting started

Run \`pnpm build\` first, then point your client at the binary.
`;

describe("the reported crash — a tagless body", () => {
  it("raw markdown served as text/plain reads, instead of throwing", async () => {
    const r = await new Reader({
      fetchImpl: mockFetch(MARKDOWN, { contentType: "text/plain; charset=utf-8" }),
    }).read("https://raw.test/docs/guides/mcp-agents.md");

    expect(r.receipt.status).toBe("ok");
    expect(r.receipt.extractor).toBe("text");
    expect(r.receipt.mediaType).toBe("text/plain");
    expect(r.receipt.words).toBeGreaterThan(20);
    expect(r.text).toContain("eight tools over stdio");
  });

  it("JSON reads as text rather than crashing or vanishing", async () => {
    const body = JSON.stringify({ name: "node", stargazers_count: 98000, topics: ["js", "runtime"] });
    const r = await new Reader({
      fetchImpl: mockFetch(body, { contentType: "application/json; charset=utf-8" }),
    }).read("https://api.test/repos/nodejs/node");

    expect(r.receipt.status).toBe("ok");
    expect(r.receipt.mediaType).toBe("application/json");
    expect(r.text).toContain("stargazers_count");
  });

  it("Reader.read still never throws — the documented contract", async () => {
    // The crash escaped performRead AND Reader.read, which is documented
    // "Never throws — a failure comes back as a receipt". @veil/mcp's guard()
    // turned it into "[ERROR] Cannot destructure property 'firstElementChild'".
    for (const body of [MARKDOWN, "", "   ", '{"a":1}', "a,b\n1,2"]) {
      for (const ct of ["text/plain", "text/html", "application/json", null]) {
        const r = await new Reader({ fetchImpl: mockFetch(body, { contentType: ct }) }).read("https://x.test/y");
        expect(r.receipt, `${ct} / ${JSON.stringify(body.slice(0, 12))}`).toBeTruthy();
      }
    }
  });
});

describe("the silent half — text that carries a stray tag", () => {
  // RFC 7231 is text/plain, 32,091 words, and contains things like <sp> that
  // give the parse a non-null documentElement with an EMPTY body.
  const rfc = `Hypertext Transfer Protocol (HTTP/1.1): Semantics and Content

   The <sp> rule is used where one linear whitespace octet is required.

${"   This section defines the semantics of HTTP messages as expressed by request methods and header fields. ".repeat(400)}`;

  it("reports the words that are actually there, not zero", async () => {
    const r = await new Reader({
      fetchImpl: mockFetch(rfc, { contentType: "text/plain;charset=utf-8" }),
    }).read("https://rfc.test/rfc/rfc7231.txt");

    expect(r.receipt.status).toBe("ok");
    expect(r.receipt.note ?? "").not.toMatch(/almost no readable text/);
    expect(r.receipt.totalWords).toBeGreaterThan(5000);
    expect(r.text).toMatch(/Hypertext Transfer Protocol/);
  });

  it("truncates a long text body and hands back a working handle", async () => {
    const reader = new Reader({
      fetchImpl: mockFetch(rfc, { contentType: "text/plain" }),
      config: { budgetWords: 300 },
    });
    const r = await reader.read("https://rfc.test/rfc/rfc7231.txt");
    expect(r.receipt.truncated).toBe(true);
    expect(r.receipt.words).toBeLessThan(r.receipt.totalWords);
    expect(r.handle).toBeTruthy();

    const pull = reader.more(r.handle!, "linear whitespace");
    expect(pull!.text).toMatch(/linear whitespace/);
  });

  it("a text body over the CHARACTER ceiling does not go inline whole", async () => {
    // The npm-registry shape: 805 KB, one line, ~10,836 whitespace-"words".
    const minified = JSON.stringify({ blob: "x".repeat(200_000) });
    const reader = new Reader({
      fetchImpl: mockFetch(minified, { contentType: "application/json" }),
      config: { budgetWords: 4000, budgetChars: 20_000 },
    });
    const r = await reader.read("https://registry.test/pkg");
    expect(r.text.length).toBeLessThanOrEqual(20_000);
    expect(r.receipt.truncated).toBe(true);
    expect(r.handle).toBeTruthy();
  });
});

describe("the null-documentElement guard — what content-type CANNOT catch", () => {
  it("an EMPTY body labelled text/html is empty, not a crash", async () => {
    const r = await new Reader({
      fetchImpl: mockFetch("", { contentType: "text/html; charset=utf-8" }),
    }).read("https://x.test/blank");
    expect(r.receipt.status).toBe("empty");
    expect(r.text).toBe("");
  });

  it("whitespace-only text/html is empty, not a crash", async () => {
    const r = await new Reader({
      fetchImpl: mockFetch("   \n  ", { contentType: "text/html" }),
    }).read("https://x.test/blank");
    expect(r.receipt.status).toBe("empty");
  });

  it("a TAGLESS body labelled text/html still returns its words", async () => {
    // THE DISCRIMINATING CASE. Catching the TypeError and returning `empty`
    // would pass every other test in this file — and would silently resurrect
    // the RFC-7231 lie through a different door. The guard must route to the
    // TEXT lane, not to `empty`.
    const body = `Service temporarily unavailable. ${"Please retry your request in a few minutes. ".repeat(30)}`;
    const r = await new Reader({
      fetchImpl: mockFetch(body, { contentType: "text/html" }),
    }).read("https://x.test/plain-error");

    expect(r.receipt.status).toBe("ok");
    expect(r.receipt.extractor).toBe("text");
    expect(r.receipt.words).toBeGreaterThan(100);
    expect(r.text).toContain("Service temporarily unavailable");
  });
});

describe("the sniff override — a mislabelled HTML page stays in the HTML lane", () => {
  it("text/plain whose body starts <!doctype html> is extracted as HTML", async () => {
    const r = await new Reader({
      fetchImpl: mockFetch(fixture("clean-article"), { contentType: "text/plain" }),
    }).read("https://cdn.test/article");

    expect(r.receipt.status).toBe("ok");
    expect(r.receipt.extractor).toBe("readability");
    expect(r.text).toMatch(/stateless/i);
    // Returning the raw source as "prose" would be a new lie.
    expect(r.text).not.toMatch(/<html|<body/i);
  });

  it("HTML with no content-type header at all is unchanged (back-compat)", async () => {
    const r = await new Reader({ fetchImpl: mockFetch(fixture("clean-article")) }).read("https://x.test/a");
    expect(r.receipt.status).toBe("ok");
    expect(r.receipt.extractor).toBe("readability");
    expect(r.receipt.mediaType).toBeNull();
  });
});

describe("binary — say what it was, do not pretend it was empty prose", () => {
  it("a PDF names its media type and byte count instead of '0 raw words'", async () => {
    const r = await new Reader({
      fetchImpl: mockFetch("%PDF-1.4 binary junk", { contentType: "application/pdf" }),
    }).read("https://w3.test/dummy.pdf");

    expect(r.receipt.status).not.toBe("ok");
    expect(r.receipt.mediaType).toBe("application/pdf");
    expect(r.receipt.note ?? "").toMatch(/application\/pdf/);
    expect(r.text).toBe("");
  });

  it("an image is never decoded — the body is not turned into a string", async () => {
    // With fetchImpl injected this proves the decode is skipped, not that a
    // socket read was avoided; the real-network claim belongs to Layer 2.
    let decoded = false;
    const r = await new Reader({
      fetchImpl: mockFetch("PNGDATA", { contentType: "image/png", onText: () => { decoded = true; } }),
    }).read("https://wikimedia.test/x.png");

    expect(decoded).toBe(false);
    expect(r.text).toBe("");
    expect(r.receipt.mediaType).toBe("image/png");
  });

  it("a 403 is still a doorman, whatever the media type says", async () => {
    const r = await new Reader({
      fetchImpl: mockFetch("%PDF-1.4", { contentType: "application/pdf", status: 403 }),
    }).read("https://blocked.test/x.pdf");
    expect(r.receipt.status).toBe("doorman");
  });
});

describe("the text lane never escalates to a browser", () => {
  it("a short text body does not summon Chrome — the bytes ARE the content", async () => {
    let rendered = false;
    const renderer = async (url: string) => {
      rendered = true;
      return { html: fixture("clean-article"), finalUrl: url, ok: true, ms: 1200 };
    };
    const r = await new Reader({
      fetchImpl: mockFetch("# tiny\n\nnot much here", { contentType: "text/markdown" }),
      renderer,
    }).read("https://raw.test/tiny.md");

    expect(rendered).toBe(false);
    expect(r.receipt.via).toBe("fetch");
    // and it keeps its text rather than discarding it for being short
    expect(r.text).toContain("not much here");
  });
});

/**
 * The other direction, and the one that nearly shipped.
 *
 * The first cut of `classifyMedia` defaulted every body that was not provably
 * HTML to the TEXT lane. `performRead` returns from the text lane BEFORE the
 * escalation block, so that default silently switched off the bottom of the
 * ladder: a JS shell served with no `content-type` came back `ok · text` with
 * its own markup as the answer and Chrome was never summoned. Measured before
 * and after. It is the same fault class these tests exist to remove — reporting
 * `ok` for something that did nothing — so it gets the same treatment.
 */
describe("fixing the text lane must not disable the ladder", () => {
  const SHELL = `<div id="root"></div><script src="/app.js"></script>`;

  it("a JS shell with NO content-type still escalates to a render", async () => {
    let rendered = false;
    const renderer = async (url: string) => {
      rendered = true;
      return { html: fixture("clean-article"), finalUrl: url, ok: true, ms: 900 };
    };
    const r = await new Reader({ fetchImpl: mockFetch(SHELL), renderer }).read("https://spa.test/x");

    expect(rendered).toBe(true);
    expect(r.receipt.via).toBe("render");
    expect(r.receipt.extractor).toBe("readability");
    // and above all it does not hand the agent the page's own markup as prose
    expect(r.text).not.toMatch(/<div id="root">/);
  });

  it("an unrecognised media type keeps Readability, rather than dumping source", async () => {
    // application/xml on an XHTML page. No header is missing here — this is a
    // server saying something we simply do not have a text rule for.
    const r = await new Reader({
      fetchImpl: mockFetch(`<?xml version="1.0" encoding="UTF-8"?>\n${fixture("clean-article")}`, {
        contentType: "application/xml",
      }),
    }).read("https://x.test/a.xhtml");

    expect(r.receipt.extractor).toBe("readability");
    expect(r.text).not.toMatch(/<\?xml|<html|<body/i);
  });

  it("HTML that does not LEAD with a doctype is still read as HTML", async () => {
    const r = await new Reader({
      fetchImpl: mockFetch(`<!-- built by a generator -->\n${fixture("clean-article")}`),
    }).read("https://x.test/b");

    expect(r.receipt.extractor).toBe("readability");
    expect(r.text).not.toMatch(/<html|<body/i);
  });

  it("KNOWN HOLE: prose with no content-type AND a stray tag still reports empty", async () => {
    // Named rather than fixed. With no header there is no signal that separates
    // this from a real page whose body failed to parse, and the sniff cannot
    // help — it must stay narrow or it swallows markdown that mentions <html>.
    // The cost of the alternative (defaulting to text) is measured in the two
    // tests above. A server that sends `text/plain` — which is nearly all of
    // them — takes the text lane correctly; see the top of this file.
    const r = await new Reader({
      fetchImpl: mockFetch(`RFC 7231 HTTP/1.1 Semantics\n\nSee <https://example.com/spec> for more.\n\n${"word ".repeat(400)}`),
    }).read("https://rfc.test/rfc7231.txt");

    expect(r.receipt.status).toBe("empty");
    // The same bytes WITH the header every real server sends read correctly.
    const ok = await new Reader({
      fetchImpl: mockFetch(`RFC 7231 HTTP/1.1 Semantics\n\nSee <https://example.com/spec> for more.\n\n${"word ".repeat(400)}`, {
        contentType: "text/plain",
      }),
    }).read("https://rfc.test/rfc7231.txt");
    expect(ok.receipt.status).toBe("ok");
    expect(ok.receipt.words).toBeGreaterThan(300);
  });
});

/**
 * A frameset's own bytes carry no prose. The read tier used to call that
 * `empty · almost no readable text (0 raw words)` and name no recovery, while
 * the very bytes it held said `<frame src="/frame-menu">`. Two of five arena
 * `frameset` runs acted on that receipt and concluded the page was "served with
 * a content type that isn't text" — a false diagnosis the receipt handed them.
 */
describe("a page whose content is in child documents says so", () => {
  const FRAMESET = `<!doctype html><html><head><title>Console</title></head>
    <frameset cols="200,*"><frame name="menu" src="/frame-menu">
    <frame name="body" src="/frame-body"></frameset></html>`;

  it("reports `frames`, not `empty`, and names the documents", async () => {
    const r = await new Reader({
      fetchImpl: mockFetch(FRAMESET, { contentType: "text/html" }),
    }).read("https://router.test/");

    expect(r.receipt.status).toBe("frames");
    expect(r.receipt.note).toContain("/frame-menu");
    expect(r.receipt.note).toContain("/frame-body");
    expect(r.receipt.note).toMatch(/veil_open/);
    expect(r.receipt.note).not.toMatch(/almost no readable text/);
  });

  it("escalates, because the engine composes child documents and a fetch cannot", async () => {
    let rendered = false;
    const renderer = async (url: string) => {
      rendered = true;
      return { html: fixture("clean-article"), finalUrl: url, ok: true, ms: 800 };
    };
    const r = await new Reader({
      fetchImpl: mockFetch(FRAMESET, { contentType: "text/html" }),
      renderer,
    }).read("https://router.test/");

    expect(rendered).toBe(true);
    expect(r.receipt.status).toBe("ok");
  });

  it("does NOT blame JavaScript when a frameset also carries a script", async () => {
    // `frames` is checked before `js-shell` precisely for this: the diagnosis
    // decides where the agent looks next, and "behind JavaScript" sends it after
    // the wrong thing on a page whose content is one document down.
    const r = await new Reader({
      fetchImpl: mockFetch(
        `<!doctype html><html><head><script src="/a.js"></script></head>
         <frameset><frame src="/menu"></frameset></html>`,
        { contentType: "text/html" },
      ),
    }).read("https://router.test/");

    expect(r.receipt.status).toBe("frames");
  });

  it("an ordinary JS shell is still a JS shell", async () => {
    // The complement — `frames` must not swallow the js-shell path.
    const r = await new Reader({
      fetchImpl: mockFetch(fixture("js-shell"), { contentType: "text/html" }),
    }).read("https://spa.test/");
    expect(r.receipt.status).toBe("js-shell");
  });

  it("ignores srcs that are not recoveries", async () => {
    const r = await new Reader({
      fetchImpl: mockFetch(
        `<!doctype html><html><body><p>hi</p>
         <iframe src="about:blank"></iframe>
         <iframe src="javascript:void(0)"></iframe></body></html>`,
        { contentType: "text/html" },
      ),
    }).read("https://x.test/");
    expect(r.receipt.status).toBe("empty");
  });
});
