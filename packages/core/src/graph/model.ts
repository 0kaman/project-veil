/**
 * The behavior graph — what a page DOES, not what it looks like.
 *
 * Two things distinguish this from an accessibility snapshot, and they're the
 * whole point (DECISIONS 2026-07-25, "the moat"):
 *   - every node carries the events bound to it (delegated handlers included)
 *   - and, once observed, the network request those events fire
 *
 * The graph is built host-side and QUERIED. It is never serialized wholesale to
 * an agent — v1 dumped 18k tokens per open and the model drowned before it acted.
 * See project.ts for the lean view that actually crosses the wire.
 */

/** AX roles that a user can act ON — "doers". Deliberately excludes `link`:
 * a link is navigation, and navigation is what veil_search/veil_read are for.
 * Measured: on wikipedia this is the difference between 1,031 nodes and 23. */
/** Roles you act on by CLICKING. If one of these already reaches a target, the
 * fields feeding it need no "press Enter" advice — the button is the obvious move. */
export const CLICKABLE = new Set(["button", "menuitem", "tab", "link"]);

export const DOER_ROLES = new Set([
  "button",
  "textbox",
  "searchbox",
  "checkbox",
  "radio",
  "combobox",
  "listbox",
  "menuitem",
  "menuitemcheckbox",
  "menuitemradio",
  "tab",
  "switch",
  "slider",
  "spinbutton",
  "textarea",
]);

/** Roles that are interactive but navigational — counted, not listed. */
export const NAV_ROLES = new Set(["link", "option"]);

/** Actionability state worth surfacing. Measured at 2% token overhead — free. */
export interface NodeState {
  disabled?: boolean;
  required?: boolean;
  checked?: boolean | string;
  expanded?: boolean;
  invalid?: boolean;
  focused?: boolean;
  readonly?: boolean;
}

export type EventCategory = "navigation" | "form_submit" | "api_call" | "dom_mutation" | "unknown";

export interface EventBinding {
  /** DOM event type: click, submit, change, input… */
  type: string;
  /** What we believe it does, inferred from handler source / element semantics. */
  category: EventCategory;
  /** Human-readable effect when known: "GET /login", "navigates to /reset". */
  effect?: string;
  /** True when the handler is on an ancestor (React-style delegation). */
  delegated?: boolean;
}

export interface BehaviorNode {
  /** Content-derived STABLE id — what an agent names. `button-sign-in`. */
  id: string;
  /** Chrome's AX node id. Reassigned every run; never shown to an agent. */
  axId: string;
  /** Bridge to the live DOM node — survives within a document. */
  backendNodeId?: number;
  role: string;
  name: string;
  value?: string;
  state: NodeState;
  events: EventBinding[];
  /** Set once a request has been correlated to this node (stage 3). */
  fires?: string;
  /** True when a replayable request template exists for this node. */
  replayable?: boolean;
  /** This node submits a form and NOTHING clickable reaches the same target —
   * so pressing Enter (`veil_do action:"submit"`) is the only way to send it.
   * Carried on the node because an agent decides what to do from the GRAPH, not
   * from the tool schema (DECISIONS 2026-07-26). */
  submitOnly?: boolean;
}

export interface GraphMeta {
  url: string;
  title: string;
  route: string;
  /** Total non-ignored AX nodes considered — the denominator for honesty. */
  axNodes: number;
  builtInMs: number;
}

export interface BehaviorGraph {
  meta: GraphMeta;
  /** Every actionable node, keyed by stable display id. */
  nodes: Map<string, BehaviorNode>;
  /** Display ids of doers, in document order. */
  doers: string[];
  /** Display ids of navigational nodes — counted in the lean view, not listed. */
  links: string[];
}

/** Path portion of a URL, for the `route:` line. */
export function routeOf(url: string): string {
  try {
    const u = new URL(url);
    return u.pathname + (u.search || "");
  } catch {
    return url;
  }
}
