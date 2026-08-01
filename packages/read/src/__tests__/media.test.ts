import { describe, it, expect } from "vitest";
import { classifyMedia, isBinaryMediaType, parseMediaType } from "../media.js";

const PROSE = "The quick brown fox jumps over the lazy dog. ".repeat(10);

describe("parseMediaType — normalisation", () => {
  it("strips parameters and folds case", () => {
    expect(parseMediaType("TEXT/HTML; charset=UTF-8")).toBe("text/html");
    expect(parseMediaType("text/plain;charset=iso-8859-1")).toBe("text/plain");
    expect(parseMediaType("  application/json  ")).toBe("application/json");
  });

  it("an absent or blank header is null, not a guess", () => {
    expect(parseMediaType(null)).toBeNull();
    expect(parseMediaType(undefined)).toBeNull();
    expect(parseMediaType("")).toBeNull();
    expect(parseMediaType("   ")).toBeNull();
  });
});

describe("classifyMedia — the lane table", () => {
  const cases: Array<[string | null, string, "html" | "text" | "binary", string | null]> = [
    ["text/html; charset=utf-8", "<!doctype html><p>hi</p>", "html", "text/html"],
    ["application/xhtml+xml", "<html><p>hi</p></html>", "html", "application/xhtml+xml"],
    ["text/plain; charset=utf-8", "# Title\n\nbody", "text", "text/plain"],
    ["text/markdown", "# Title\n\nbody", "text", "text/markdown"],
    ["application/json; charset=utf-8", '{"a":1}', "text", "application/json"],
    ["text/csv", "a,b\n1,2", "text", "text/csv"],
    ["text/x-rst", "Title\n=====", "text", "text/x-rst"],
    ["application/pdf", "%PDF-1.4 stuff", "binary", "application/pdf"],
    ["image/png", "\ufffd\ufffdPNG", "binary", "image/png"],
    ["video/mp4", "junk", "binary", "video/mp4"],
    ["font/woff2", "junk", "binary", "font/woff2"],
    ["application/zip", "PK\u0003\u0004", "binary", "application/zip"],
    // XML-ish parses to a real document; Readability pulls its element text.
    ["application/xml", "<?xml version=\"1.0\"?><doc><p>hi</p></doc>", "html", "application/xml"],
    ["text/xml", "<?xml version=\"1.0\"?><doc>hi</doc>", "html", "text/xml"],
    ["application/rss+xml", "<rss><channel>hi</channel></rss>", "html", "application/rss+xml"],
    // No header at all — HTML, because that is where the whole ladder lives.
    // An absent content-type is not evidence of prose, and diverting it to the
    // text lane silently disables escalation. See the default-lane block below.
    [null, PROSE, "html", null],
    [null, "<!doctype html><p>hi</p>", "html", null],
  ];

  for (const [ct, body, lane, mediaType] of cases) {
    it(`${ct ?? "(no content-type)"} → ${lane}`, () => {
      const v = classifyMedia(ct, body);
      expect(v.lane).toBe(lane);
      expect(v.mediaType).toBe(mediaType);
    });
  }
});

describe("classifyMedia — the two overrides, in the order that matters", () => {
  it("a body that starts <!doctype html> beats a text/plain label (CDNs mislabel HTML)", () => {
    // Returning HTML source as prose would be a new lie, so the sniff wins here.
    expect(classifyMedia("text/plain", "<!doctype html><html><body><p>x</p></body></html>").lane).toBe("html");
    expect(classifyMedia("text/plain", "\n  <HTML>\n<body>x</body></html>").lane).toBe("html");
  });

  it("but a BINARY media type beats the body sniff — a media type always wins", () => {
    // If this order ever inverts, an unusually-encoded HTML page silently
    // becomes binary and the failure is total.
    expect(classifyMedia("image/png", "<!doctype html><p>hi</p>").lane).toBe("binary");
    expect(classifyMedia("application/pdf", "<html>hi</html>").lane).toBe("binary");
  });

  it("markdown that merely mentions <html> is still text, not HTML", () => {
    expect(classifyMedia("text/plain", "# Guide\n\nUse <html> tags like this.").lane).toBe("text");
  });
});

describe("classifyMedia — the byte sniff is scoped to 'the type told us nothing'", () => {
  it("octet-stream carrying text falls to the HTML lane — it is not a prose claim", () => {
    // "The server has no idea" is not evidence of prose. It reaches the sniff so
    // that binary is caught, and then takes the ordinary default like any other
    // unrecognised type, keeping Readability and escalation available.
    expect(classifyMedia("application/octet-stream", PROSE).lane).toBe("html");
  });

  it("octet-stream carrying decoded binary is binary", () => {
    const blob = "\u0000\u0001\u0002\ufffd\ufffd\u0007".repeat(200);
    expect(classifyMedia("application/octet-stream", blob).lane).toBe("binary");
  });

  it("no content-type + decoded binary is binary", () => {
    expect(classifyMedia(null, "\u0000\u0000\u0001\ufffd".repeat(200)).lane).toBe("binary");
  });

  it("an empty body is never binary — there is nothing to sniff", () => {
    expect(classifyMedia(null, "").lane).toBe("html");
    expect(classifyMedia("text/plain", "").lane).toBe("text");
  });
});

describe("classifyMedia — the DEFAULT lane, which is the whole ladder", () => {
  // This block exists because the first cut of media.ts defaulted to text and
  // that silently switched off escalation: a JS shell with no content-type came
  // back `ok · text` with its own markup as the answer and Chrome never ran.
  // The rule is an ALLOWLIST — a type must positively announce prose to divert.
  it("an unrecognised media type stays in the HTML lane", () => {
    for (const t of ["application/octet-stream", "application/xml", "application/rss+xml", "text/xml"]) {
      expect(classifyMedia(t, PROSE).lane).toBe("html");
    }
  });

  it("a JS shell with no content-type stays HTML, so it can still escalate", () => {
    expect(classifyMedia(null, '<div id="root"></div><script src="/app.js"></script>').lane).toBe("html");
  });

  it("HTML that does not LEAD with a doctype still reaches the HTML lane", () => {
    // The sniff is deliberately narrow, so this one is carried by the default
    // rather than by step 3 — which is precisely why the default must be html.
    expect(classifyMedia(null, "<!-- built by a generator -->\n<!doctype html><p>x</p>").lane).toBe("html");
  });

  it("only a positively textual type diverts", () => {
    for (const t of ["text/plain", "text/markdown", "text/csv", "application/json", "application/ld+json", "application/x-ndjson", "application/yaml"]) {
      expect(classifyMedia(t, PROSE).lane).toBe("text");
    }
  });
});

describe("isBinaryMediaType — the pre-decode early-out", () => {
  it("is true for types that can never be prose", () => {
    for (const t of ["image/png", "image/svg+xml", "audio/mpeg", "video/mp4", "font/woff2", "application/pdf", "application/zip", "application/gzip", "application/wasm"]) {
      expect(isBinaryMediaType(t), t).toBe(true);
    }
  });

  it("is false for anything that might be prose, INCLUDING octet-stream", () => {
    // octet-stream means "the server has no idea" — that is not evidence of
    // binary, so it must reach the sniff rather than short-circuit the decode.
    for (const t of ["text/html", "text/plain", "text/markdown", "application/json", "application/xhtml+xml", "application/octet-stream"]) {
      expect(isBinaryMediaType(t), t).toBe(false);
    }
  });
});
