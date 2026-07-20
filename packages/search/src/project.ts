/**
 * Projection — Brave's response is 26KB (~6,709 tokens) for 10 results. The
 * useful part (title, url, description, age) is ~900. Everything else —
 * family_friendly, is_live, profile objects, thumbnails, meta_url — is noise a
 * model must not be made to pay for. This is handle-not-payload at the search
 * surface: ship only what's used.
 */
import type { Result } from "./types.js";

interface BraveResult {
  title?: string;
  url?: string;
  description?: string;
  age?: string;
  page_age?: string;
}
interface BraveResponse {
  web?: { results?: BraveResult[] };
}

/** Brave bolds query terms with markup; strip all tags and collapse space. */
function stripTags(s: string): string {
  return s.replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
}

/** Project a parsed Brave response down to the fields that earn their tokens. */
export function projectBrave(raw: unknown, count: number): Result[] {
  const results = (raw as BraveResponse)?.web?.results;
  if (!Array.isArray(results)) return [];

  const out: Result[] = [];
  for (const r of results) {
    if (!r?.url || !r?.title) continue;
    const item: Result = {
      title: stripTags(r.title),
      url: r.url,
      description: stripTags(r.description ?? ""),
    };
    const age = r.age ?? r.page_age;
    if (age) item.age = age;
    out.push(item);
    if (out.length >= count) break;
  }
  return out;
}
