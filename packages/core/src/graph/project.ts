/**
 * The lean view — the only thing that crosses the wire.
 *
 * Measured (DECISIONS 2026-07-25): listing every interactive node costs
 * 184–9,122 tokens depending on the page. Leading with DOERS and reducing links
 * to a count puts every page type in a 58–426 token band, because links are
 * navigation and navigation is what veil_search/veil_read are for.
 *
 * The withheld count is always stated. A capped view that looks complete is the
 * failure this whole project exists to design out.
 */
import type { BehaviorGraph, BehaviorNode } from "./model.js";

export interface ProjectOptions {
  /** Max doers to list before truncating. Nothing measured needed this — 52 was
   * the worst case — but a design tool or spreadsheet could, and a silent cap is
   * forbidden. */
  maxDoers?: number;
}

function stateSuffix(n: BehaviorNode): string {
  const entries = Object.entries(n.state);
  if (entries.length === 0) return "";
  return ` {${entries.map(([k, v]) => (v === true ? k : `${k}:${v}`)).join(", ")}}`;
}

function line(n: BehaviorNode): string {
  const name = n.name ? ` "${n.name}"` : "";
  const value = n.value ? ` =${JSON.stringify(n.value)}` : "";
  const fires = n.fires ? `  → ${n.fires}` : "";
  const delegated = !n.fires && n.events.some((e) => e.delegated) ? "  → (delegated handler)" : "";
  return `  ${n.id} [${n.role}]${name}${value}${stateSuffix(n)}${fires}${delegated}`;
}

export function projectLean(graph: BehaviorGraph, opts: ProjectOptions = {}): string {
  const maxDoers = opts.maxDoers ?? 60;
  const out: string[] = [];

  out.push(`route: ${graph.meta.route}`);
  if (graph.meta.title) out.push(`title: ${graph.meta.title}`);

  const doers = graph.doers.map((id) => graph.nodes.get(id)!).filter(Boolean);
  const shown = doers.slice(0, maxDoers);
  const withheld = doers.length - shown.length;

  out.push("");
  out.push(
    withheld > 0
      ? `ACTIONS (${shown.length} of ${doers.length} — ${withheld} withheld, veil_query for the rest)`
      : `ACTIONS (${doers.length})`,
  );
  if (shown.length === 0) out.push("  (none — nothing on this page is actionable)");
  for (const n of shown) out.push(line(n));

  // Links are counted, never listed. This is the measured win: wikipedia's 1,008
  // links would be 9,000 tokens; the count is 12.
  if (graph.links.length > 0) {
    out.push("");
    out.push(`LINKS (${graph.links.length}) — veil_query(role:"link", name:"…") to list`);
  }

  return out.join("\n");
}
