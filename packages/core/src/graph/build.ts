/**
 * buildGraph — the pipeline, in order, on a live tab.
 *
 * Stage 1 (AX tree) → stable ids → Stage 2 (events). Stage 3 (network
 * correlation) lands with the interaction slice, since a request has to fire
 * before there is anything to correlate.
 *
 * Measured cost: the whole thing is 7–140ms depending on page size, against a
 * 210–2,803ms settle. Which is why we always rebuild rather than diff.
 */
import type { CDPClient } from "../browser/cdp-client.js";
import { buildFromAXTree } from "../pipeline/stage-1-axtree.js";
import { enrichWithEvents, type Stage2Stats } from "../pipeline/stage-2-events.js";
import { DOER_ROLES, routeOf, type BehaviorGraph } from "./model.js";

export interface BuildResult {
  graph: BehaviorGraph;
  stage2: Stage2Stats;
}

async function pageMeta(client: CDPClient): Promise<{ url: string; title: string }> {
  const read = async (expr: string): Promise<string> => {
    try {
      const r = (await client.send("Runtime.evaluate", {
        expression: expr,
        returnByValue: true,
      })) as { result?: { value?: unknown } };
      return typeof r.result?.value === "string" ? r.result.value : "";
    } catch {
      return "";
    }
  };
  return { url: await read("location.href"), title: await read("document.title") };
}

export async function buildGraph(client: CDPClient): Promise<BuildResult> {
  const t0 = Date.now();

  const { url, title } = await pageMeta(client);
  const { nodes, axNodeCount } = await buildFromAXTree(client);
  const stage2 = await enrichWithEvents(client, nodes);

  const map = new Map(nodes.map((n) => [n.id, n]));
  const doers: string[] = [];
  const links: string[] = [];
  for (const n of nodes) {
    // Unnamed doers are unaddressable in practice — an agent cannot refer to
    // "the third unnamed textbox" meaningfully — so they're counted but not
    // surfaced. Named-ness is the addressability test.
    if (DOER_ROLES.has(n.role)) {
      if (n.name) doers.push(n.id);
    } else {
      links.push(n.id);
    }
  }

  return {
    graph: {
      meta: { url, title, route: routeOf(url), axNodes: axNodeCount, builtInMs: Date.now() - t0 },
      nodes: map,
      doers,
      links,
    },
    stage2,
  };
}
