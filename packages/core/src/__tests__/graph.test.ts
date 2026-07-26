import { describe, it, expect } from "vitest";
import { assignDisplayIds } from "../graph/ids.js";
import { projectLean } from "../graph/project.js";
import { queryNodes } from "../graph/query.js";
import { diffGraphs } from "../graph/diff.js";
import type { BehaviorGraph, BehaviorNode } from "../graph/model.js";

const node = (over: Partial<BehaviorNode> & { id: string; role: string }): BehaviorNode => ({
  axId: "ax" + over.id,
  name: "",
  state: {},
  events: [],
  ...over,
});

function graph(nodes: BehaviorNode[]): BehaviorGraph {
  const doers = nodes.filter((n) => n.role !== "link").map((n) => n.id);
  const links = nodes.filter((n) => n.role === "link").map((n) => n.id);
  return {
    meta: { url: "https://x.test/login", title: "T", route: "/login", axNodes: 100, builtInMs: 5 },
    nodes: new Map(nodes.map((n) => [n.id, n])),
    doers,
    links,
  };
}

describe("assignDisplayIds", () => {
  it("derives ids from role + accessible name", () => {
    expect(assignDisplayIds([{ role: "button", name: "Sign in" }])).toEqual(["button-sign-in"]);
  });

  it("disambiguates collisions in document order, leaving the first unsuffixed", () => {
    const ids = assignDisplayIds([
      { role: "button", name: "Delete" },
      { role: "button", name: "Delete" },
      { role: "button", name: "Delete" },
    ]);
    expect(ids).toEqual(["button-delete", "button-delete-2", "button-delete-3"]);
  });

  it("is stable for the same content — the whole point", () => {
    const input = [{ role: "button", name: "Sign in" }, { role: "textbox", name: "Password" }];
    expect(assignDisplayIds(input)).toEqual(assignDisplayIds(input));
  });

  it("falls back to role when a node has no name", () => {
    expect(assignDisplayIds([{ role: "textbox", name: "" }])).toEqual(["textbox"]);
  });
});

describe("projectLean", () => {
  it("lists doers with role, name, state and what they fire", () => {
    const out = projectLean(
      graph([
        node({ id: "textbox-user", role: "textbox", name: "Username", state: { required: true }, fires: "POST /session" }),
        node({ id: "button-sign-in", role: "button", name: "Sign in", fires: "POST /session" }),
      ]),
    );
    expect(out).toMatch(/ACTIONS \(2\)/);
    expect(out).toMatch(/textbox-user \[textbox\] "Username" \{required\}\s+→ POST \/session/);
    expect(out).toMatch(/route: \/login/);
  });

  it("COUNTS links rather than listing them — the measured win", () => {
    const links = Array.from({ length: 1008 }, (_, i) =>
      node({ id: `link-${i}`, role: "link", name: `Link ${i}` }),
    );
    const out = projectLean(graph([node({ id: "button-edit", role: "button", name: "Edit" }), ...links]));
    expect(out).toMatch(/LINKS \(1008\)/);
    expect(out).not.toMatch(/link-500/); // not listed
    // 1,008 links must not blow the view up
    expect(Math.ceil(out.length / 4)).toBeLessThan(120);
  });

  it("declares withheld doers instead of silently truncating", () => {
    const many = Array.from({ length: 80 }, (_, i) =>
      node({ id: `button-${i}`, role: "button", name: `Btn ${i}` }),
    );
    const out = projectLean(graph(many), { maxDoers: 10 });
    expect(out).toMatch(/ACTIONS \(10 of 80 — 70 withheld/);
    expect(out).toMatch(/veil_query/);
  });

  it("says a DIALOG is holding the page, so missing nodes read as hidden not gone", () => {
    // Measured in all six recorded fare runs: typing into Google Flights' origin
    // opens `dialog "Enter your origin"`, aria-hides the rest of the page, and
    // `combobox-where-to` correctly leaves the graph. Every run read that as the
    // page breaking. The evidence was ours — a live `dialog` AX node — and we
    // were dropping it because `dialog` is not a doer role.
    const g = graph([node({ id: "combobox-where-else", role: "combobox", name: "Where else?" })]);
    g.meta.dialog = "Enter your origin";
    const out = projectLean(g);
    expect(out).toMatch(/DIALOG OPEN: "Enter your origin"/);
    expect(out).toMatch(/behind it, not gone/);
  });

  it("stays silent when no dialog is open", () => {
    expect(projectLean(graph([node({ id: "button-x", role: "button", name: "X" })]))).not.toMatch(
      /DIALOG/,
    );
  });

  it("says so when nothing is actionable", () => {
    const out = projectLean(graph([node({ id: "link-a", role: "link", name: "A" })]));
    expect(out).toMatch(/nothing on this page is actionable/);
  });

  it("names the VERB on a node that can only be sent with Enter", () => {
    // A live model was handed Hacker News' search box and reported "the missing
    // capability is a submit action on the textbox" — while action:"submit" sat
    // in the veil_do enum it had been given. It decides what to do from the
    // graph, not from the tool schema, so the affordance belongs on the node.
    const out = projectLean(
      graph([node({ id: "textbox", role: "textbox", fires: "GET //hn.algolia.com/", submitOnly: true })]),
    );
    expect(out).toMatch(/\(action:"submit"\)/);
  });

  it("stays quiet when a button already reaches the same target", () => {
    const out = projectLean(
      graph([
        node({ id: "textbox-user", role: "textbox", name: "User", fires: "POST /session" }),
        node({ id: "button-sign-in", role: "button", name: "Sign in", fires: "POST /session" }),
      ]),
    );
    expect(out).not.toMatch(/action:"submit"/);
  });

  it("marks a delegated handler when there is no known effect", () => {
    const out = projectLean(
      graph([node({ id: "button-x", role: "button", name: "X", events: [{ type: "click", category: "unknown", delegated: true }] })]),
    );
    expect(out).toMatch(/delegated handler/);
  });
});

describe("queryNodes", () => {
  const g = graph([
    node({ id: "button-save", role: "button", name: "Save", fires: "POST /save", events: [{ type: "click", category: "api_call" }] }),
    node({ id: "button-cancel", role: "button", name: "Cancel" }),
    node({ id: "link-help", role: "link", name: "Help centre", fires: "GET /help" }),
  ]);

  it("filters by role", () => {
    expect(queryNodes(g, { role: "link" }).returned.map((n) => n.id)).toEqual(["link-help"]);
  });

  it("filters by name substring, case-insensitively", () => {
    expect(queryNodes(g, { name: "canc" }).returned.map((n) => n.id)).toEqual(["button-cancel"]);
  });

  it("filters to nodes that fire something", () => {
    expect(queryNodes(g, { fires: true }).matched).toBe(2);
  });

  it("filters by event type", () => {
    expect(queryNodes(g, { hasEvent: "click" }).returned.map((n) => n.id)).toEqual(["button-save"]);
  });

  it("reports truncation rather than hiding it", () => {
    const r = queryNodes(g, { limit: 1 });
    expect(r.matched).toBe(3);
    expect(r.returned).toHaveLength(1);
    expect(r.note).toMatch(/returned 1 of 3/);
  });
});

describe("diffGraphs — a dialog opening is the receipt an agent actually reads", () => {
  const withDialog = (name?: string) => {
    const g = graph([node({ id: "button-a", role: "button", name: "A" })]);
    if (name) g.meta.dialog = name;
    return g;
  };

  it("reports a dialog OPENING, which is what explains the vanished nodes", () => {
    const d = diffGraphs(withDialog(), withDialog("Enter your origin"));
    expect(d.dialog?.opened).toBe("Enter your origin");
    expect(d.dialog?.closed).toBeUndefined();
  });

  it("reports a dialog CLOSING, so the agent knows the page is reachable again", () => {
    const d = diffGraphs(withDialog("Enter your origin"), withDialog());
    expect(d.dialog?.closed).toBe("Enter your origin");
    expect(d.dialog?.opened).toBeUndefined();
  });

  it("says nothing when the same dialog stayed open — that is not news", () => {
    expect(diffGraphs(withDialog("Pick a date"), withDialog("Pick a date")).dialog).toBeUndefined();
  });

  it("says nothing when there was never a dialog", () => {
    expect(diffGraphs(withDialog(), withDialog()).dialog).toBeUndefined();
  });
});
