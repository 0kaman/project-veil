import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { FetchLike } from "../read.js";

const here = dirname(fileURLToPath(import.meta.url));

export function fixture(name: string): string {
  return readFileSync(join(here, "fixtures", `${name}.html`), "utf8");
}

/**
 * A fetch that always returns the given body, for offline tests.
 *
 * `contentType` produces a `headers.get()` shim. NOTE what this cannot prove: a
 * plain-object shim would pass even if the real-`Headers` contract were read
 * wrongly (case-insensitivity, `; charset=…` parameters). That is what the
 * Layer-2 suite in `integration/` is for.
 */
export function mockFetch(
  html: string,
  opts: { status?: number; url?: string; contentType?: string | null; onText?: () => void } = {},
): FetchLike {
  return async (url) => ({
    status: opts.status ?? 200,
    url: opts.url ?? url,
    headers:
      opts.contentType === undefined
        ? undefined
        : {
            get: (name: string) =>
              name.toLowerCase() === "content-type" ? opts.contentType ?? null : null,
          },
    text: async () => {
      opts.onText?.();
      return html;
    },
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
