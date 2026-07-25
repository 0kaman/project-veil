/**
 * Layer 2 — the session pool against real headless Chrome.
 *
 * The point of a session is that it OUTLIVES the call that made it: the tab stays
 * open, the graph stays queryable, and the next tool call resumes where the last
 * one left off. And under memory pressure it evicts rather than rejecting, saying
 * so, because an agent should never have to reason about our memory ceiling.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createServer, type Server } from "node:http";
import { SessionPool, chromeAvailable, browserTreeRssMb } from "../src/index.js";

const suite = chromeAvailable() ? describe : describe.skip;

const PAGE = (n: string) => `<!doctype html><html><head><title>Page ${n}</title></head><body>
  <form action="/submit-${n}" method="POST">
    <input name="q" aria-label="Query ${n}" required>
    <button type="submit">Go ${n}</button>
  </form>
  <a href="/one">First link</a><a href="/two">Second link</a>
</body></html>`;

/** A search whose RESULTS exist only after the form is driven — re-fetching the
 * URL gets you the empty form back, which is exactly why a session must be
 * readable. */
const SEARCH_PAGE = `<!doctype html><html><head><title>Fare search</title></head><body>
  <input id="q" aria-label="Route">
  <button id="go" aria-label="Search">Search</button>
  <div id="out"></div>
  <script>
    // Fetched, not inlined: a literal here would sit in the script source and
    // show up in outerHTML BEFORE the click, which made the first version of
    // this test assert nothing at all.
    document.getElementById('go').addEventListener('click', function(){
      fetch('/results').then(function(r){ return r.text(); })
        .then(function(t){ document.getElementById('out').innerHTML = t; });
    });
  </script></body></html>`;

const RESULTS = `<article><h1>Results</h1>
  <p>IndiGo 6E-2043 departs 06:10 and the fare is 4,812 rupees nonstop.</p>
  <p>Air India AI-504 departs 07:45 and the fare is 6,330 rupees nonstop.</p>
  <p>${"filler ".repeat(4200)}</p></article>`;

suite("session pool — real Chrome (Layer 2)", () => {
  let server: Server;
  let base: string;

  beforeAll(async () => {
    server = createServer((req, res) => {
      if ((req.url ?? "").startsWith("/results")) {
        res.writeHead(200, { "content-type": "text/html" });
        res.end(RESULTS);
        return;
      }
      if ((req.url ?? "").startsWith("/search")) {
        res.writeHead(200, { "content-type": "text/html" });
        res.end(SEARCH_PAGE);
        return;
      }
      const n = (req.url ?? "/a").replace(/[^a-z0-9]/gi, "") || "a";
      res.writeHead(200, { "content-type": "text/html" });
      res.end(PAGE(n));
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const a = server.address();
    base = `http://127.0.0.1:${typeof a === "object" && a ? a.port : 0}`;
  });

  afterAll(async () => {
    await new Promise<void>((r) => server.close(() => r()));
  });

  it("READS a page it has driven — prose that exists nowhere but the tab", async () => {
    // The failure this closes: an agent drove a flight search to a results page,
    // called veil_read with the session id, and got FETCH-FAILED. It had the
    // answer on screen and no way to read it. Re-fetching the URL returns the
    // empty form, so the session is the only place the answer lives.
    const pool = new SessionPool({ capMs: 4000 });
    try {
      const open = await pool.open(`${base}/search`);
      const before = await pool.html(open.sessionId!);
      // nothing of the answer is on the page yet — not even in the script source
      expect("html" in before && before.html.includes("4,812")).toBe(false);
      expect("html" in before && before.html.includes("IndiGo")).toBe(false);

      await pool.act(open.sessionId!, "button-search", { kind: "click" });

      const after = await pool.html(open.sessionId!);
      expect("html" in after).toBe(true);
      if (!("html" in after)) return;
      expect(after.html).toContain("IndiGo 6E-2043");
      expect(after.html).toContain("4,812");
      expect(after.url).toContain("/search");
    } finally {
      await pool.shutdown();
    }
  }, 90_000);

  it("says a closed session is gone rather than returning empty prose", async () => {
    const pool = new SessionPool({ capMs: 4000 });
    try {
      const open = await pool.open(`${base}/search`);
      await pool.close(open.sessionId!);
      const r = await pool.html(open.sessionId!);
      expect("gone" in r).toBe(true);
    } finally {
      await pool.shutdown();
    }
  }, 90_000);

  it("a session OUTLIVES the open call — the graph stays queryable", async () => {
    const pool = new SessionPool();
    try {
      const open = await pool.open(`${base}/alpha`);
      expect(open.ok).toBe(true);
      expect(open.sessionId).toBeTruthy();
      expect(open.lean).toMatch(/ACTIONS \(2\)/); // input + button
      expect(open.lean).toMatch(/LINKS \(2\)/);

      // a later, separate call still sees the same page
      const q = pool.query(open.sessionId!, { role: "button" });
      expect("gone" in q).toBe(false);
      if ("gone" in q) return;
      expect(q.returned[0]?.fires).toMatch(/POST \/submit-alpha/);
    } finally {
      await pool.shutdown();
    }
  }, 60_000);

  it("query pulls the links the lean view only counted", async () => {
    const pool = new SessionPool();
    try {
      const open = await pool.open(`${base}/beta`);
      // the lean view withheld them...
      expect(open.lean).not.toMatch(/link-first-link \[link\]/);
      // ...and query produces them, at zero browser cost
      const q = pool.query(open.sessionId!, { role: "link" });
      if ("gone" in q) throw new Error("session gone");
      expect(q.matched).toBe(2);
      expect(q.returned.map((n) => n.id)).toContain("link-first-link");
    } finally {
      await pool.shutdown();
    }
  }, 60_000);

  it("EVICTS under memory pressure and says which sessions went", async () => {
    // budgetMb: 1 guarantees every open is over budget, so eviction always fires.
    const pool = new SessionPool({ budgetMb: 1 });
    try {
      const first = await pool.open(`${base}/gamma`);
      expect(first.ok).toBe(true);

      const second = await pool.open(`${base}/delta`);
      expect(second.ok).toBe(true); // eviction, NOT rejection
      expect(second.evicted).toContain(first.sessionId);

      // the evicted handle now explains itself rather than failing opaquely
      const q = pool.query(first.sessionId!, { role: "button" });
      expect("gone" in q).toBe(true);
      if ("gone" in q) expect(q.gone).toBe("evicted-memory");
    } finally {
      await pool.shutdown();
    }
  }, 90_000);

  it("reaps idle sessions", async () => {
    const pool = new SessionPool({ idleMs: 1 }); // everything is instantly idle
    try {
      const first = await pool.open(`${base}/epsilon`);
      await new Promise((r) => setTimeout(r, 30));
      const second = await pool.open(`${base}/zeta`);
      expect(second.evicted).toContain(first.sessionId);
      expect(pool.goneReason(first.sessionId!)).toBe("evicted-idle");
    } finally {
      await pool.shutdown();
    }
  }, 90_000);

  it("close frees the session and is honest about a second attempt", async () => {
    const pool = new SessionPool();
    try {
      const open = await pool.open(`${base}/eta`);
      expect(await pool.close(open.sessionId!)).toBe(true);
      expect(await pool.close(open.sessionId!)).toBe(false);
      expect(pool.goneReason(open.sessionId!)).toBe("closed");
      expect(pool.list()).toHaveLength(0);
    } finally {
      await pool.shutdown();
    }
  }, 60_000);

  it("measures OUR browser tree, not every Chrome on the machine", async () => {
    const pool = new SessionPool();
    try {
      const open = await pool.open(`${base}/theta`);
      expect(open.memoryMb).toBeGreaterThan(0);
      // A freshly-launched browser with one small tab should be well under the
      // 3,921MB we measured for 8 heavy tabs. If this ever balloons, the tree
      // walk has started counting processes that aren't ours.
      expect(open.memoryMb!).toBeLessThan(2500);
    } finally {
      await pool.shutdown();
    }
  }, 60_000);

  it("browserTreeRssMb reports -1 for a pid that doesn't exist, not 0", async () => {
    // Treating unmeasurable as zero would mean eviction never fires.
    expect(await browserTreeRssMb(999_999)).toBe(-1);
  });
});
