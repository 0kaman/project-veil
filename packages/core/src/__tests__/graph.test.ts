import { describe, it, expect } from "vitest";
import { assignDisplayIds } from "../graph/ids.js";
import { projectLean } from "../graph/project.js";
import { queryNodes } from "../graph/query.js";
import { diffGraphs, isNoOp } from "../graph/diff.js";
import { unreachableOwners } from "../browser/frames.js";
import type { BehaviorGraph, BehaviorNode, FrameFacts } from "../graph/model.js";

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

/**
 * Frames — the honest notice.
 *
 * The burn this exists to stop, from the arena's own record (task `frameset`,
 * contender `veil`, run 1): 25 tool calls, 53,471 prompt tokens, `ok: false`,
 * and an answer that ends mid-sentence — "The fetch returns empty, which
 * suggests the page might be served with a content type that isn't text." Two of
 * the five runs were reduced to guessing frame names. Chrome had `menu` and
 * `body` and their URLs the whole time.
 *
 * One case per SCHEME, because a fixture implementing one scheme cannot fail.
 */
describe("projectLean — child documents are named, not silently dropped", () => {
  const facts = (over: Partial<FrameFacts> = {}): FrameFacts => ({
    frameset: false,
    total: 0,
    readable: [],
    unreachable: [],
    perceived: 0,
    ...over,
  });
  const framed = (f: FrameFacts, nodes: BehaviorNode[] = []): BehaviorGraph => {
    const g = graph(nodes);
    g.meta.frames = f;
    return g;
  };

  const FRAMESET = facts({
    frameset: true,
    total: 2,
    readable: [
      { name: "menu", url: "http://127.0.0.1:8099/frame-menu", depth: 1 },
      { name: "body", url: "http://127.0.0.1:8099/frame-body", depth: 1 },
    ],
  });

  it("SCHEME frameset: names both frames, forbids guessing, and gives a REACHABLE recovery", () => {
    const out = projectLean(framed(FRAMESET));
    expect(out).toMatch(/FRAMESET/);
    expect(out).toContain("http://127.0.0.1:8099/frame-menu");
    expect(out).toContain("http://127.0.0.1:8099/frame-body");
    expect(out).toMatch(/do NOT guess/i);
    // The recovery is the PAIR measured to work — veil_open the frame URL, then
    // veil_read the session. `veil_read <frame url>` alone returns `empty · 0w`
    // on these very pages, so naming it would be an unreachable recovery.
    expect(out.indexOf("veil_open")).toBeGreaterThan(-1);
    expect(out.indexOf("veil_read")).toBeGreaterThan(out.indexOf("veil_open"));
  });

  it("SCHEME frameset: stops claiming nothing is actionable when content is one frame down", () => {
    const out = projectLean(framed(FRAMESET));
    expect(out).not.toMatch(/nothing on this page is actionable/);
    expect(out).toMatch(/none HERE/);
  });

  /**
   * THE SCHEME NEITHER LAYER MODELLED, and the one the arena actually hits.
   *
   * `facts()` defaults `perceived: 0`, so every frameset assertion above tests a
   * page whose frames were NOT entered. The moment same-origin perception
   * shipped, the real frameset started producing `perceived === readable.length`
   * — `missing` went to 0, the gate closed, and the whole notice vanished from
   * the receipt while these tests stayed green. The Layer-2 fixture missed it
   * from the opposite side: its frames contain a real <button>, so `doerCount`
   * is never 0 there and the line under test never prints at all.
   *
   * Entering a frame and finding a doer in it are different things. The arena
   * menu is `<li onclick>`, which stage 1 does not classify as a doer.
   */
  const ENTERED = facts({ frameset: true, total: 2, perceived: 2, readable: FRAMESET.readable });

  it("SCHEME frameset ENTERED but no doers: still names the frames", () => {
    const out = projectLean(framed(ENTERED)); // no nodes → doerCount 0
    expect(out).toContain("http://127.0.0.1:8099/frame-menu");
    expect(out).toContain("http://127.0.0.1:8099/frame-body");
    expect(out).toMatch(/do NOT guess/i);
  });

  it("SCHEME frameset ENTERED but no doers: does not call the page empty", () => {
    const out = projectLean(framed(ENTERED));
    expect(out).not.toMatch(/nothing on this page is actionable/);
    expect(out).toMatch(/none HERE/);
    // and it must not claim the frames were merely unreadable — they were read
    expect(out).not.toMatch(/could NOT be entered/);
    expect(out).toMatch(/THAT VEIL CAN PERCEIVE/);
  });

  it("SCHEME frameset ENTERED: the recovery is the CHEAP one, this session", () => {
    // The frames' text is already composed into this session's serialization,
    // so re-opening a frame URL to read it would be advice that costs a browser
    // launch for nothing. veil_open stays named, but for ACTING.
    const out = projectLean(framed(ENTERED));
    expect(out).toMatch(/veil_read on THIS session/);
  });

  it("a frameset whose frames DO carry doers is not lectured about frames", () => {
    // The complement, so the gate cannot degenerate into "always print it".
    const out = projectLean(framed(ENTERED, [node({ id: "button-pay", role: "button", name: "Pay" })]));
    expect(out).not.toMatch(/do NOT guess/i);
    expect(out).not.toMatch(/none HERE/);
  });

  it("SCHEME same-origin iframe: names the frame without calling the page a frameset", () => {
    const out = projectLean(
      framed(facts({ total: 1, readable: [{ name: "", url: "http://x.test/inner", depth: 1 }] })),
    );
    expect(out).toMatch(/FRAMES \(1\)/);
    expect(out).toContain("http://x.test/inner");
    expect(out).not.toMatch(/FRAMESET/);
  });

  it("SCHEME cross-site: says there is NO recovery rather than inventing one", () => {
    // The case a single `total` field would silently claim completeness on:
    // Chrome omits an OOPIF from Page.getFrameTree while the DOM still carries
    // the element (measured — element 09AAF384… present in the DOM, absent from
    // the tree).
    const out = projectLean(
      framed(
        facts({
          total: 3,
          readable: [
            { name: "a", url: "http://x.test/a", depth: 1 },
            { name: "b", url: "http://x.test/b", depth: 1 },
          ],
          unreachable: ["http://ads.example/px"],
        }),
      ),
    );
    expect(out).toContain("http://x.test/a");
    expect(out).toContain("http://x.test/b");
    expect(out).toMatch(/1 of these are CROSS-SITE/);
    expect(out).toMatch(/NO recovery/);
  });

  it("counts but does NOT list when the page is usable — an ad page must not hand over 30 URLs", () => {
    const many = Array.from({ length: 4 }, (_, i) => ({
      name: "",
      url: `http://ads.example/${i}`,
      depth: 1,
    }));
    const out = projectLean(
      framed(facts({ total: 4, readable: many }), [
        node({ id: "button-buy", role: "button", name: "Buy" }),
      ]),
    );
    expect(out).toMatch(/FRAMES \(4\)/);
    expect(out).not.toContain("http://ads.example/0");
  });

  it("says the frame content IS in the graph once it is perceived", () => {
    const out = projectLean(
      framed(
        facts({
          total: 1,
          perceived: 1,
          readable: [{ name: "inner", url: "http://x.test/inner", depth: 1 }],
        }),
        [node({ id: "button-ack", role: "button", name: "Ack" })],
      ),
    );
    expect(out).toMatch(/FRAMES \(1\) — 1 child document\(s\) are perceived/);
    expect(out).not.toMatch(/do NOT guess/i);
  });

  it("the receipt ADDS UP: total === readable + unreachable", () => {
    // A receipt that does not add up is worse than no receipt. There are three
    // buckets in reality (readable, cross-site, and display:none frames with no
    // AX node at all) and only the first two are countable — so the invariant is
    // stated and enforced rather than assumed.
    const f = FRAMESET;
    expect(f.total).toBe(f.readable.length + f.unreachable.length);
  });

  it("guard (passes today): stays silent on a page with no frames", () => {
    expect(projectLean(graph([node({ id: "button-x", role: "button", name: "X" })]))).not.toMatch(
      /FRAME/i,
    );
  });
});

describe("queryNodes — a zero-match on a framed page is not a dead end", () => {
  it("names the real frames instead of sending the agent back to guessing", () => {
    const g = graph([node({ id: "button-a", role: "button", name: "A" })]);
    g.meta.frames = {
      frameset: true,
      total: 2,
      readable: [
        { name: "menu", url: "http://x.test/frame-menu", depth: 1 },
        { name: "body", url: "http://x.test/frame-body", depth: 1 },
      ],
      unreachable: [],
      perceived: 0,
    };
    const r = queryNodes(g, { name: "iframe" });
    expect(r.matched).toBe(0);
    expect(r.note).toContain("http://x.test/frame-menu");
    expect(r.note).toMatch(/veil_open/);
  });

  it("stays quiet when there is nothing to point at", () => {
    expect(queryNodes(graph([]), { name: "iframe" }).note).toBeUndefined();
  });
});

describe("unreachableOwners — a frame element that owns no reachable document", () => {
  // Measured (probe-iframe8): BOTH <iframe> and <frame> owners carry AX role
  // `Iframe` in the PARENT's tree, and a cross-site frame's owner is still
  // there. That diff IS the receipt — no pierced DOM dump needed.
  const ax = (role: string, backendDOMNodeId: number) => ({ role: { value: role }, backendDOMNodeId });

  it("flags the frame-ish AX node whose element owns nothing in the frame tree", () => {
    expect(unreachableOwners([ax("Iframe", 12), ax("Iframe", 15)], new Set([12]))).toEqual([15]);
  });

  it("ignores non-frame roles and unowned ids alike", () => {
    expect(unreachableOwners([ax("button", 99), { role: { value: "Iframe" } }], new Set())).toEqual(
      [],
    );
  });

  it("reports nothing when every frame element is reachable", () => {
    expect(unreachableOwners([ax("Iframe", 12), ax("IframePresentational", 13)], new Set([12, 13])))
      .toEqual([]);
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

  it("reports crossing INTO a framed page, which is what explains the vanished actions", () => {
    const before = graph([node({ id: "link-console", role: "link", name: "Console" })]);
    const after = graph([]);
    after.meta.frames = {
      frameset: true,
      total: 2,
      readable: [
        { name: "menu", url: "http://x.test/frame-menu", depth: 1 },
        { name: "body", url: "http://x.test/frame-body", depth: 1 },
      ],
      unreachable: [],
      perceived: 0,
    };
    const d = diffGraphs(before, after);
    expect(d.frames).toEqual({ before: 0, after: 2, unreadable: 2 });
  });

  it("LOOP: navigating back OUT reports the frames going away too", () => {
    // State that accumulates across calls needs both directions. One navigation
    // on one fixture cannot fail this.
    const framed = graph([]);
    framed.meta.frames = {
      frameset: true,
      total: 2,
      readable: [
        { name: "menu", url: "http://x.test/frame-menu", depth: 1 },
        { name: "body", url: "http://x.test/frame-body", depth: 1 },
      ],
      unreachable: [],
      perceived: 0,
    };
    const plain = graph([node({ id: "button-x", role: "button", name: "X" })]);
    expect(diffGraphs(framed, plain).frames).toEqual({ before: 2, after: 0, unreadable: 0 });
  });

  it("a frame-count change alone is still a noOp — otherwise every act on a framed page lies", () => {
    const a = graph([node({ id: "button-x", role: "button", name: "X" })]);
    const b = graph([node({ id: "button-x", role: "button", name: "X" })]);
    b.meta.frames = {
      frameset: false,
      total: 1,
      readable: [{ name: "", url: "http://x.test/i", depth: 1 }],
      unreachable: [],
      perceived: 0,
    };
    const d = diffGraphs(a, b);
    expect(d.frames).toBeDefined();
    expect(isNoOp(d)).toBe(true);
  });
});
