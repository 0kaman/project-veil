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
import { CLICKABLE, DOER_ROLES, routeOf, type BehaviorGraph } from "./model.js";

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
    // The addressability test is the ROLE, not the name. Requiring a name was
    // measured wrong (DECISIONS 2026-07-25): Hacker News' site search is an
    // unlabelled textbox, so the front page reported "nothing on this page is
    // actionable" while holding a node that fires GET //hn.algolia.com/. A live
    // model read that receipt and concluded, correctly and uselessly, that it
    // was stuck. Unnamed nodes ARE addressable — ids are stable and deduped
    // (`textbox`, `textbox-2`) and `fires` describes them. Cost is ~1 node:
    // measured 0 unnamed doers on httpbin's 16-control form, github/login and
    // a wikipedia article; 1 on HN.
    if (DOER_ROLES.has(n.role)) {
      doers.push(n.id);
    } else {
      links.push(n.id);
    }
  }

  // Which targets can already be reached by CLICKING something? A form with a
  // submit button needs no advice on its fields; a form without one does.
  const covered = new Set<string>();
  for (const id of doers) {
    const n = map.get(id);
    if (n?.fires && CLICKABLE.has(n.role)) covered.add(n.fires);
  }
  for (const id of doers) {
    const n = map.get(id)!;
    if (
      !CLICKABLE.has(n.role) &&
      n.events.some((e) => e.category === "form_submit") &&
      !(n.fires && covered.has(n.fires))
    ) {
      n.submitOnly = true;
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
