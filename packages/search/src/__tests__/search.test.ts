import { describe, it, expect, vi } from "vitest";
import { Search, projectBrave, type SearchFetchLike } from "../index.js";

/** A canned Brave response — the real shape, trimmed. Tests NEVER hit the live
 * API: the free tier is 66 queries/day and would be exhausted by a test run. */
const braveBody = JSON.stringify({
  web: {
    results: [
      {
        title: "Fusion <strong>energy</strong> milestone",
        url: "https://example.org/fusion",
        description: "Researchers reported <strong>net energy</strong> gain again.",
        age: "2 days ago",
        family_friendly: true, // noise that must be projected away
        meta_url: { hostname: "example.org" },
      },
      { title: "Second result", url: "https://example.org/two", description: "More detail here." },
      { title: "no url dropped", description: "has no url so must be skipped" },
    ],
  },
});

function mockFetch(body: string, status = 200): SearchFetchLike & { calls: number } {
  const wrapper = Object.assign(
    (async () => {
      wrapper.calls++;
      return { status, text: async () => body };
    }) as SearchFetchLike,
    { calls: 0 },
  );
  return wrapper;
}

const opts = (fetchImpl: SearchFetchLike, extra = {}) => ({
  apiKey: "test-key",
  fetchImpl,
  minIntervalMs: 0, // no real spacing in most tests
  ...extra,
});

describe("projectBrave", () => {
  it("keeps only title/url/description/age, strips tags, drops url-less rows", () => {
    const results = projectBrave(JSON.parse(braveBody), 10);
    expect(results).toHaveLength(2); // the url-less row is gone
    expect(results[0]).toEqual({
      title: "Fusion energy milestone",
      url: "https://example.org/fusion",
      description: "Researchers reported net energy gain again.",
      age: "2 days ago",
    });
    // noise is not carried through
    expect(JSON.stringify(results)).not.toMatch(/family_friendly|meta_url/);
  });

  it("caps to count", () => {
    expect(projectBrave(JSON.parse(braveBody), 1)).toHaveLength(1);
  });
});

describe("Search — results", () => {
  it("returns projected results with an ok receipt", async () => {
    const r = await new Search(opts(mockFetch(braveBody))).run("fusion energy");
    expect(r.receipt.status).toBe("ok");
    expect(r.receipt.via).toBe("brave");
    expect(r.results).toHaveLength(2);
  });

  it("empty results → empty status, not a lie", async () => {
    const r = await new Search(opts(mockFetch(JSON.stringify({ web: { results: [] } })))).run("zzz");
    expect(r.receipt.status).toBe("empty");
    expect(r.results).toHaveLength(0);
  });
});

describe("Search — the cache", () => {
  it("a repeat query hits cache, does not call Brave again, and is marked cached", async () => {
    const fetchImpl = mockFetch(braveBody);
    const search = new Search(opts(fetchImpl));
    await search.run("fusion energy");
    const second = await search.run("  Fusion Energy  "); // normalises to same key
    expect(fetchImpl.calls).toBe(1);
    expect(second.receipt.via).toBe("cache");
    expect(second.receipt.cached).toBe(true);
    expect(second.results).toHaveLength(2);
  });

  it("an expired entry re-fetches", async () => {
    const fetchImpl = mockFetch(braveBody);
    const search = new Search(opts(fetchImpl, { cacheTtlMs: 0 }));
    await search.run("q");
    await search.run("q");
    expect(fetchImpl.calls).toBe(2);
  });
});

describe("Search — failure modes are receipts", () => {
  it("no key → no-key status, never throws", async () => {
    const r = await new Search({ apiKey: undefined, fetchImpl: mockFetch(braveBody) }).run("q");
    expect(r.receipt.status).toBe("no-key");
  });

  it("Brave 429 → rate-limited", async () => {
    const r = await new Search(opts(mockFetch("{}", 429))).run("q");
    expect(r.receipt.status).toBe("rate-limited");
  });

  it("non-200 → error with the code", async () => {
    const r = await new Search(opts(mockFetch("nope", 500))).run("q");
    expect(r.receipt.status).toBe("error");
    expect(r.receipt.note).toMatch(/500/);
  });

  it("unparseable body → error, not a crash", async () => {
    const r = await new Search(opts(mockFetch("<html>not json</html>"))).run("q");
    expect(r.receipt.status).toBe("error");
  });

  it("a thrown fetch → error receipt", async () => {
    const throwing: SearchFetchLike = async () => {
      throw new Error("net down");
    };
    const r = await new Search(opts(throwing)).run("q");
    expect(r.receipt.status).toBe("error");
  });
});

describe("Search — the rate gate", () => {
  it("spaces two distinct queries by minIntervalMs; cache hits skip the gate", async () => {
    vi.useFakeTimers();
    try {
      const fetchImpl = mockFetch(braveBody);
      const search = new Search(opts(fetchImpl, { minIntervalMs: 1000 }));

      const p1 = search.run("alpha");
      const p2 = search.run("beta"); // distinct key → must wait behind the gate
      await vi.advanceTimersByTimeAsync(0);
      const r1 = await p1;
      expect(r1.receipt.status).toBe("ok"); // first goes immediately
      expect(fetchImpl.calls).toBe(1);

      await vi.advanceTimersByTimeAsync(1000); // release the spacing
      const r2 = await p2;
      expect(r2.receipt.status).toBe("ok");
      expect(fetchImpl.calls).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });
});
