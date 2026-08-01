/**
 * Layer 2 — the read path against a real socket and the real global `fetch`.
 *
 * What a hermetic test CANNOT prove: `mockFetch` hands back a plain object with
 * a `headers.get` shim of our own design, so every Layer-1 case would pass even
 * if the real `Headers` contract were read wrongly. A real `Headers.get()` is
 * case-insensitive on the name and returns the FULL field value including
 * `; charset=utf-8` parameters — both of which `classifyMedia` depends on
 * handling. Only a real response proves it.
 *
 * No Chrome needed, so this never auto-skips.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createServer, type Server } from "node:http";
import { Reader } from "../src/index.js";

const MARKDOWN = `# MCP agents

Veil exposes eight tools over stdio, and the MCP server is the prime interface.

## Getting started

Run \`pnpm build\` first, then point the client at the built binary.
`;

const ARTICLE = `<!doctype html><html><head><title>Real HTML</title></head><body>
  <article><h1>Understanding sockets</h1>
  <p>${"A socket is an endpoint for sending and receiving data across a network. ".repeat(30)}</p>
  <p>${"Every connection is identified by a five-tuple of protocol and addresses. ".repeat(30)}</p>
  </article></body></html>`;

// Big enough to force truncation over a real socket.
// One paragraph deep inside carries a unique marker, so the handle pull is
// proved to reach past the inline budget rather than re-returning the top.
// (`pull` ORs its query terms, so the marker has to be a word that appears
// exactly once.)
const LONG_TEXT = Array.from(
  { length: 400 },
  (_, i) =>
    `Paragraph ${i}. ${i === 300 ? "quokka " : ""}${"The quick brown fox jumps over the lazy dog. ".repeat(6)}`,
).join("\n\n");

// One line, no paragraph breaks — the shape that used to defeat the budget.
const MINIFIED = JSON.stringify({ name: "pkg", blob: "x".repeat(120_000) });

describe("read over a real socket — content-type drives the lane (Layer 2)", () => {
  let server: Server;
  let base: string;

  beforeAll(async () => {
    server = createServer((req, res) => {
      const send = (type: string, body: string | Buffer) => {
        res.writeHead(200, { "content-type": type });
        res.end(body);
      };
      switch (req.url) {
        case "/guide.md":
          // Deliberately odd casing + a charset parameter: the two things a
          // plain-object mock cannot exercise.
          return send("Text/Plain; charset=UTF-8", MARKDOWN);
        case "/readme.markdown":
          return send("text/markdown; charset=utf-8", MARKDOWN);
        case "/repo.json":
          return send("application/json; charset=utf-8", JSON.stringify({ stars: 98000, name: "node" }));
        case "/data.csv":
          return send("text/csv", "airline,fare\nIndiGo,4812\nAir India,9584\n");
        case "/article":
          return send("text/html; charset=utf-8", ARTICLE);
        case "/mislabelled":
          // A CDN stamping text/plain on real HTML.
          return send("text/plain", ARTICLE);
        case "/tagless-html":
          // 200, labelled text/html, no markup at all — the case no header can
          // catch, and the one that used to throw.
          return send("text/html; charset=utf-8", `Service unavailable. ${"Please retry shortly. ".repeat(40)}`);
        case "/blank":
          res.writeHead(200, { "content-type": "text/html", "content-length": "0" });
          return res.end();
        case "/doc.pdf":
          return send("application/pdf", Buffer.from("%PDF-1.4\n%\xE2\xE3\xCF\xD3\nbinary junk", "binary"));
        case "/long.txt":
          return send("text/plain; charset=utf-8", LONG_TEXT);
        case "/minified.json":
          return send("application/json", MINIFIED);
        case "/latin1.txt":
          return send("text/plain; charset=iso-8859-1", Buffer.from([0x63, 0x61, 0x66, 0xe9]) as unknown as Buffer);
        default:
          res.writeHead(404, { "content-type": "text/plain" });
          return res.end("not found");
      }
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const addr = server.address();
    if (!addr || typeof addr === "string") throw new Error("no address");
    base = `http://127.0.0.1:${addr.port}`;
  });

  afterAll(async () => {
    await new Promise<void>((r) => server.close(() => r()));
  });

  it("markdown over the wire reads as text — the exact reported crash", async () => {
    const r = await new Reader().read(`${base}/guide.md`);
    expect(r.receipt.status).toBe("ok");
    expect(r.receipt.extractor).toBe("text");
    // Proves the params were stripped and the case folded off a REAL Headers.
    expect(r.receipt.mediaType).toBe("text/plain");
    expect(r.text).toContain("eight tools over stdio");
  });

  it("text/markdown, application/json and text/csv all reach the text lane", async () => {
    for (const [path, mediaType, needle] of [
      ["/readme.markdown", "text/markdown", "prime interface"],
      ["/repo.json", "application/json", "stars"],
      ["/data.csv", "text/csv", "IndiGo"],
    ] as const) {
      const r = await new Reader().read(`${base}${path}`);
      expect(r.receipt.status, path).toBe("ok");
      expect(r.receipt.mediaType, path).toBe(mediaType);
      expect(r.text, path).toContain(needle);
    }
  });

  it("real HTML still goes through Readability, unchanged", async () => {
    const r = await new Reader().read(`${base}/article`);
    expect(r.receipt.status).toBe("ok");
    expect(r.receipt.extractor).toBe("readability");
    expect(r.receipt.mediaType).toBe("text/html");
    expect(r.text).toMatch(/endpoint for sending/);
  });

  it("HTML mislabelled text/plain is still read as HTML, not dumped as source", async () => {
    const r = await new Reader().read(`${base}/mislabelled`);
    expect(r.receipt.extractor).toBe("readability");
    expect(r.text).not.toMatch(/<article|<html/i);
  });

  it("a tagless body labelled text/html returns its words instead of throwing", async () => {
    const r = await new Reader().read(`${base}/tagless-html`);
    expect(r.receipt.status).toBe("ok");
    expect(r.receipt.extractor).toBe("text");
    expect(r.text).toContain("Service unavailable");
  });

  it("a 200 with an empty body is empty, over a real socket", async () => {
    const r = await new Reader().read(`${base}/blank`);
    expect(r.receipt.status).toBe("empty");
    expect(r.text).toBe("");
  });

  it("a PDF is refused by name, and its bytes are never decoded", async () => {
    const r = await new Reader().read(`${base}/doc.pdf`);
    expect(r.receipt.mediaType).toBe("application/pdf");
    expect(r.receipt.note ?? "").toMatch(/application\/pdf/);
    expect(r.receipt.note ?? "").toMatch(/veil_search|HTML version/);
    expect(r.text).toBe("");
  });

  it("a long text body truncates end-to-end and the handle pulls from it", async () => {
    const reader = new Reader({ config: { budgetWords: 300 } });
    const r = await reader.read(`${base}/long.txt`);
    expect(r.receipt.truncated).toBe(true);
    expect(r.receipt.words).toBeLessThan(r.receipt.totalWords);
    expect(r.handle).toBeTruthy();

    const pull = reader.more(r.handle!, "quokka");
    expect(pull!.matched).toBe(1);
    expect(pull!.text).toContain("Paragraph 300");
    expect(pull!.words).toBeLessThanOrEqual(400);
    // and that paragraph was NOT in the inline slice — the handle earned its keep
    expect(r.text).not.toContain("quokka");
  });

  it("a minified one-line body respects the character ceiling", async () => {
    const reader = new Reader({ config: { budgetWords: 4000, budgetChars: 10_000 } });
    const r = await reader.read(`${base}/minified.json`);
    expect(r.text.length).toBeLessThanOrEqual(10_000);
    expect(r.receipt.truncated).toBe(true);
    expect(r.receipt.note ?? "").toMatch(/cut mid-line|mid-paragraph/);

    // and the handle still holds the whole thing
    const pull = reader.more(r.handle!);
    expect(pull!.totalWords).toBeGreaterThan(0);
    expect(pull!.text.length).toBeLessThanOrEqual(10_000);
  });

  it("CHARACTERISATION: a declared charset is ignored by Response.text()", async () => {
    // Measured, not assumed: `new Response(Buffer.from([0x63,0x61,0x66,0xE9]),
    // {headers:{'content-type':'text/plain; charset=iso-8859-1'}}).text()`
    // yields "caf�". This is PRE-EXISTING and already affects HTML; the
    // text lane inherits it. Pinned here so it is a known gap rather than a
    // surprise, and so a future fix has a test to flip.
    const r = await new Reader().read(`${base}/latin1.txt`);
    expect(r.receipt.mediaType).toBe("text/plain");
    expect(r.text).toContain("caf");
    expect(r.text).not.toContain("café");
  });
});
