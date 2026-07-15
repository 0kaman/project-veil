/**
 * Parse Veil's compact-text graph so the playground can report what the MODEL
 * actually saw — node count, section sizes, and what changed between steps.
 *
 * Deliberately parses the serialized text rather than calling into @veil/core:
 * the text is the LLM's entire perception, so any gap between it and the real
 * graph is exactly the class of bug this harness exists to surface. Parsing the
 * same bytes the model reads keeps us honest.
 *
 * Grammar (see packages/core/src/graph/serializer.ts):
 *   PAGE <url> "<title>"
 *   STATE route:<route>
 *   NODES
 *     <displayId> [<role>] "<name>"
 *       state: / value: / on:<event> → <category> / semantic: ...
 *   NETWORK / APIS / COMPONENTS
 */

export interface GraphStats {
  isGraph: boolean;
  url: string | null;
  title: string | null;
  route: string | null;
  nodeIds: string[];
  nodes: number;
  events: number;
  networkEdges: number;
  apis: number;
  components: number;
  chars: number;
  approxTokens: number;
}

const NODE_LINE = /^(\s+)([A-Za-z0-9][\w.:-]*)\s+\[([^\]]+)\]/;
const SECTIONS = new Set(["NODES", "NETWORK", "APIS", "COMPONENTS"]);

/** Rough token estimate. Mistral's real prompt_tokens is authoritative for LLM
 * calls; this is for sizing individual tool payloads, where ~4 chars/token is
 * close enough to spot a graph blowing up the context. */
export function approxTokens(s: string): number {
  return Math.ceil(s.length / 4);
}

export function parseGraph(text: string): GraphStats {
  const stats: GraphStats = {
    isGraph: false,
    url: null,
    title: null,
    route: null,
    nodeIds: [],
    nodes: 0,
    events: 0,
    networkEdges: 0,
    apis: 0,
    components: 0,
    chars: text.length,
    approxTokens: approxTokens(text),
  };

  // veil_open prefixes "session: ...\nurl: ...\n\n" before the graph.
  const pageIdx = text.indexOf("PAGE ");
  if (pageIdx === -1) return stats;
  stats.isGraph = true;

  let section = "";
  for (const line of text.slice(pageIdx).split("\n")) {
    const bare = line.trim();

    if (SECTIONS.has(bare)) {
      section = bare;
      continue;
    }

    if (bare.startsWith("PAGE ")) {
      const m = bare.match(/^PAGE (\S+)(?:\s+"(.*)")?$/);
      if (m) {
        stats.url = m[1];
        stats.title = m[2] ?? null;
      }
      continue;
    }
    if (bare.startsWith("STATE route:")) {
      stats.route = bare.slice("STATE route:".length).trim();
      continue;
    }

    if (!bare) continue;

    if (section === "NODES") {
      // Attribute lines (state:, value:, on:, semantic:) are not nodes.
      if (bare.startsWith("on:")) {
        stats.events++;
        continue;
      }
      if (/^(state|value|semantic):/.test(bare)) continue;

      const m = line.match(NODE_LINE);
      if (m) {
        stats.nodeIds.push(m[2]);
        stats.nodes++;
      }
      continue;
    }

    if (section === "NETWORK") stats.networkEdges++;
    else if (section === "APIS") stats.apis++;
    else if (section === "COMPONENTS" && !bare.startsWith("members:")) stats.components++;
  }

  return stats;
}

export interface GraphDelta {
  added: string[];
  removed: string[];
}

export function diffGraphs(prev: GraphStats | null, next: GraphStats): GraphDelta {
  if (!prev) return { added: next.nodeIds, removed: [] };
  const a = new Set(prev.nodeIds);
  const b = new Set(next.nodeIds);
  return {
    added: next.nodeIds.filter((id) => !a.has(id)),
    removed: prev.nodeIds.filter((id) => !b.has(id)),
  };
}
