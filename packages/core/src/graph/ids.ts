/**
 * Content-derived stable display ids.
 *
 * Chrome reassigns internal AX node ids on every run, so an agent can never be
 * given one — it would name a node that no longer exists next time. Instead the
 * id is derived from what the node IS (`button-sign-in`), which is stable across
 * runs, rebuilds, and reloads as long as the page's content is.
 *
 * Collisions are real (a page with three "Delete" buttons) and are disambiguated
 * with a numeric suffix in document order. That keeps ids stable for the common
 * case and merely positional for genuine duplicates — which is the best available
 * trade: there is nothing else to distinguish them by.
 */

/** Lowercase, alphanumeric-and-dashes, collapsed, trimmed, bounded. */
function slug(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32);
}

/**
 * Assign ids over nodes in document order. Mutates nothing; returns the ids in
 * the same order as the input, so callers can zip them back onto their nodes.
 */
export function assignDisplayIds(
  nodes: Array<{ role: string; name: string }>,
): string[] {
  const counts = new Map<string, number>();
  const out: string[] = [];

  for (const n of nodes) {
    const namePart = slug(n.name);
    // An unnamed node has nothing content-derived to key on. Fall back to role
    // plus an ordinal — unstable if the page reflows, but there is no better
    // handle, and the lean view omits unnamed nodes anyway.
    const base = namePart ? `${n.role}-${namePart}` : n.role;
    const seen = counts.get(base) ?? 0;
    counts.set(base, seen + 1);
    out.push(seen === 0 ? base : `${base}-${seen + 1}`);
  }
  return out;
}
