/**
 * Stage 1 — the accessibility tree is the skeleton.
 *
 * `Accessibility.getFullAXTree` gives us roles, computed accessible names and
 * actionability states in ONE round trip: Chrome has already done the work of
 * deciding what a thing is and what it's called (the AccName algorithm). Walking
 * the DOM instead would mean reimplementing that badly.
 *
 * We keep only what an agent can act on — doers and navigational nodes — and
 * drop the containers, text and generic wrappers. Measured: wikipedia's 10,381
 * non-ignored AX nodes reduce to 1,031 interactive, of which 23 are doers.
 */
import type { CDPClient } from "../browser/cdp-client.js";
import { assignDisplayIds } from "../graph/ids.js";
import {
  DOER_ROLES,
  NAV_ROLES,
  type BehaviorNode,
  type NodeState,
} from "../graph/model.js";

interface RawAXValue {
  value?: unknown;
}
interface RawAXProperty {
  name: string;
  value?: RawAXValue;
}
interface RawAXNode {
  nodeId: string;
  ignored?: boolean;
  role?: RawAXValue;
  name?: RawAXValue;
  value?: RawAXValue;
  properties?: RawAXProperty[];
  backendDOMNodeId?: number;
}

const STATE_KEYS = new Set([
  "disabled",
  "required",
  "checked",
  "expanded",
  "invalid",
  "focused",
  "readonly",
]);

function str(v: RawAXValue | undefined): string {
  return typeof v?.value === "string" ? v.value : "";
}

/** Pull the actionability state we care about, dropping AX's many others. */
function stateOf(props: RawAXProperty[] | undefined): NodeState {
  const out: NodeState = {};
  for (const p of props ?? []) {
    if (!STATE_KEYS.has(p.name)) continue;
    const v = p.value?.value;
    // AX reports invalid as the string "false" rather than a boolean. Normalise,
    // and drop the negative cases entirely so the lean view stays lean.
    if (v === false || v === "false" || v === undefined) continue;
    (out as Record<string, unknown>)[p.name] = v === "true" ? true : v;
  }
  return out;
}

export interface Stage1Result {
  nodes: BehaviorNode[];
  /** Non-ignored AX nodes seen — the denominator the receipt reports. */
  axNodeCount: number;
}

export async function buildFromAXTree(client: CDPClient): Promise<Stage1Result> {
  const res = (await client.send("Accessibility.getFullAXTree")) as { nodes?: RawAXNode[] };
  const all = (res.nodes ?? []).filter((n) => !n.ignored);

  // Interactive only, in document order (getFullAXTree returns pre-order).
  const interactive = all.filter((n) => {
    const role = str(n.role);
    return DOER_ROLES.has(role) || NAV_ROLES.has(role);
  });

  const shaped = interactive.map((n) => ({
    role: str(n.role),
    name: str(n.name).replace(/\s+/g, " ").trim(),
    raw: n,
  }));

  const ids = assignDisplayIds(shaped);

  const nodes: BehaviorNode[] = shaped.map((s, i) => {
    const value = str(s.raw.value);
    return {
      id: ids[i],
      axId: s.raw.nodeId,
      backendNodeId: s.raw.backendDOMNodeId,
      role: s.role,
      name: s.name,
      ...(value && { value }),
      state: stateOf(s.raw.properties),
      events: [],
    };
  });

  return { nodes, axNodeCount: all.length };
}
