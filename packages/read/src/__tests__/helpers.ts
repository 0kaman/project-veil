import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { FetchLike } from "../read.js";

const here = dirname(fileURLToPath(import.meta.url));

export function fixture(name: string): string {
  return readFileSync(join(here, "fixtures", `${name}.html`), "utf8");
}

/** A fetch that always returns the given HTML, for offline tests. */
export function mockFetch(html: string, opts: { status?: number; url?: string } = {}): FetchLike {
  return async (url) => ({
    status: opts.status ?? 200,
    url: opts.url ?? url,
    text: async () => html,
  });
}

/** A fetch that throws — for the fetch-failed path. */
export function failingFetch(name = "TypeError"): FetchLike {
  return async () => {
    const e = new Error("boom");
    e.name = name;
    throw e;
  };
}
