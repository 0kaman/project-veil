/**
 * Rendering tool results to the text an LLM reads.
 *
 * Every rendering LEADS with the receipt — path, cost, and what's missing —
 * before any content. That ordering is deliberate: the model should know how
 * much to trust what follows before it reads it. This is the receipt principle
 * at the surface the agent actually sees.
 */
import type { SearchResult } from "@veil/search";
import type { ReadResult } from "@veil/read";
import type { Pull } from "@veil/read";

export function renderSearch(r: SearchResult): string {
  const c = r.receipt;
  const head = `via: ${c.via} · ${c.ms}ms · ${c.status}${c.status === "ok" ? ` · ${c.count} results` : ""}`;
  if (c.status !== "ok") {
    return `${head}${c.note ? `\n${c.note}` : ""}`;
  }
  const lines = r.results.map((x, i) => {
    const age = x.age ? ` (${x.age})` : "";
    return `${i + 1}. ${x.title}\n   ${x.url}\n   ${x.description}${age}`;
  });
  return `${head}\n\n${lines.join("\n\n")}`;
}

export function renderRead(r: ReadResult): string {
  const c = r.receipt;

  if (c.status !== "ok") {
    // Non-ok is the whole point of the receipt: say exactly why, and where next.
    const head = `via: ${c.via} · ${c.ms}ms · ${c.status.toUpperCase()}`;
    return `${head}${c.note ? `\n${c.note}` : ""}`;
  }

  const size = c.truncated ? `${c.words} of ${c.totalWords} words` : `${c.words} words`;
  const extractor = c.extractor === "fallback" ? " · fallback extractor" : "";
  const head = `via: ${c.via} · ${c.ms}ms · ${size}${extractor}${r.handle ? ` · handle ${r.handle}` : ""}`;

  const parts = [head];
  if (r.title) parts.push(`title: ${r.title}`);
  if (r.outline.length > 0) parts.push(`outline: ${r.outline.join(" · ")}`);
  parts.push("");
  parts.push(r.text);
  if (c.truncated && r.handle) {
    parts.push("");
    parts.push(`[truncated — veil_read("${r.handle}", query: "…") to pull a specific part]`);
  }
  return parts.join("\n");
}

export function renderPull(pull: Pull, handle: string): string {
  const head =
    `via: handle ${handle} · ${pull.words} of ${pull.totalWords} words · ` +
    `${pull.matched} matching paragraph${pull.matched === 1 ? "" : "s"}`;
  const parts = [head];
  if (pull.note) parts.push(pull.note);
  parts.push("");
  parts.push(pull.text || "(no text)");
  return parts.join("\n");
}
