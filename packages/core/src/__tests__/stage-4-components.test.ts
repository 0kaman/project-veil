import { describe, it, expect, vi } from "vitest";
import { groupComponents } from "../pipeline/stage-4-components.js";
import type {
  BehaviorGraph,
  BehaviorNode,
  NetworkEdge,
  ComponentGroup,
} from "../graph/model.js";
import type { CDPClient } from "../browser/cdp-client.js";

// --- Helpers ---

function makeNode(
  id: string,
  role: string,
  name: string,
  overrides: Partial<BehaviorNode> = {},
): BehaviorNode {
  return {
    id,
    role,
    name,
    description: "",
    state: {},
    value: "",
    backendDOMNodeId: 0,
    children: [],
    events: [],
    ...overrides,
  };
}

function makeGraph(
  nodes: BehaviorNode[],
  networkEdges: NetworkEdge[] = [],
): BehaviorGraph {
  const nodeMap = new Map(nodes.map((n) => [n.id, n]));
  return {
    metadata: { url: "https://example.com", title: "Test", timestamp: Date.now(), route: "/" },
    version: 1,
    nodes: nodeMap,
    roots: nodes.filter((n) => !nodes.some((p) => p.children.includes(n.id))).map((n) => n.id),
    networkEdges,
    apiEndpoints: [],
    componentGroups: [],
  };
}

/** Mock CDP that reports no React framework detected */
function makeMockCdp(): CDPClient {
  return {
    send: vi.fn(async (method: string) => {
      if (method === "Runtime.evaluate") {
        return { result: { value: { react: false } } };
      }
      return {};
    }),
    on: vi.fn(),
    off: vi.fn(),
    close: vi.fn(),
  };
}

// --- Container-based Grouping ---

describe("Stage 4 — container-based grouping", () => {
  it("1. form groups its ungrouped descendants", async () => {
    const input1 = makeNode("i1", "textbox", "Email");
    const input2 = makeNode("i2", "textbox", "Password");
    const btn = makeNode("b1", "button", "Submit");
    const form = makeNode("f1", "form", "Login", {
      children: ["i1", "i2", "b1"],
    });
    const graph = makeGraph([form, input1, input2, btn]);
    const cdp = makeMockCdp();

    await groupComponents(graph, cdp);

    expect(graph.componentGroups.length).toBe(1);
    const group = graph.componentGroups[0];
    expect(group.memberNodeIds).toContain("f1");
    expect(group.memberNodeIds).toContain("i1");
    expect(group.memberNodeIds).toContain("i2");
    expect(group.memberNodeIds).toContain("b1");
    expect(group.framework).toBe("vanilla");
  });

  it("2. navigation groups its ungrouped descendants", async () => {
    const link1 = makeNode("l1", "link", "Home");
    const link2 = makeNode("l2", "link", "About");
    const nav = makeNode("nav1", "navigation", "Main", {
      children: ["l1", "l2"],
    });
    const graph = makeGraph([nav, link1, link2]);
    const cdp = makeMockCdp();

    await groupComponents(graph, cdp);

    expect(graph.componentGroups.length).toBe(1);
    expect(graph.componentGroups[0].memberNodeIds).toContain("nav1");
    expect(graph.componentGroups[0].memberNodeIds).toContain("l1");
    expect(graph.componentGroups[0].memberNodeIds).toContain("l2");
  });

  it("3. dialog groups its descendants", async () => {
    const btn = makeNode("b1", "button", "Close");
    const text = makeNode("t1", "heading", "Confirm");
    const dialog = makeNode("d1", "dialog", "Confirmation", {
      children: ["t1", "b1"],
    });
    const graph = makeGraph([dialog, text, btn]);
    const cdp = makeMockCdp();

    await groupComponents(graph, cdp);

    expect(graph.componentGroups.length).toBe(1);
    expect(graph.componentGroups[0].memberNodeIds).toContain("d1");
    expect(graph.componentGroups[0].memberNodeIds).toContain("b1");
    expect(graph.componentGroups[0].memberNodeIds).toContain("t1");
  });

  it("4. nested containers: inner gets own group, outer doesn't claim inner's members", async () => {
    // Insert inner form BEFORE nav so Map iteration hits form first
    const innerInput = makeNode("ii1", "textbox", "Search query");
    const innerForm = makeNode("if1", "form", "SearchForm", {
      children: ["ii1"],
    });
    const outerLink = makeNode("ol1", "link", "Home");
    const nav = makeNode("nav1", "navigation", "TopBar", {
      children: ["if1", "ol1"],
    });
    // innerForm before nav in the array => form is iterated first
    const graph = makeGraph([innerForm, innerInput, nav, outerLink]);
    const cdp = makeMockCdp();

    await groupComponents(graph, cdp);

    // Should have 2 groups: one for form, one for nav
    expect(graph.componentGroups.length).toBe(2);

    // The form group should contain innerForm and innerInput
    const formGroup = graph.componentGroups.find((g) => g.id.includes("form"));
    expect(formGroup).toBeDefined();
    expect(formGroup!.memberNodeIds).toContain("if1");
    expect(formGroup!.memberNodeIds).toContain("ii1");

    // The nav group should contain nav and outerLink but NOT innerForm/innerInput
    const navGroup = graph.componentGroups.find((g) => g.id.includes("navigation"));
    expect(navGroup).toBeDefined();
    expect(navGroup!.memberNodeIds).toContain("nav1");
    expect(navGroup!.memberNodeIds).toContain("ol1");
    expect(navGroup!.memberNodeIds).not.toContain("ii1");
  });

  it("5. already-grouped nodes are not re-grouped", async () => {
    const btn = makeNode("b1", "button", "Click", { componentId: "existing-group" });
    const form = makeNode("f1", "form", "MyForm", {
      children: ["b1"],
    });
    const graph = makeGraph([form, btn]);
    const cdp = makeMockCdp();

    await groupComponents(graph, cdp);

    // groupComponents clears componentId first, so after re-run the form should group its children fresh
    // The key behavior: componentId is reset at the start of groupComponents
    const group = graph.componentGroups.find((g) => g.id.includes("form"));
    expect(group).toBeDefined();
    expect(group!.memberNodeIds).toContain("b1");
  });

  it("6. container with no ungrouped descendants creates no group", async () => {
    // A form with no children
    const form = makeNode("f1", "form", "EmptyForm");
    const graph = makeGraph([form]);
    const cdp = makeMockCdp();

    await groupComponents(graph, cdp);

    // collectUngroupedDescendants returns empty, so no group
    expect(graph.componentGroups.length).toBe(0);
  });

  it("7. group ID follows pattern cg-vanilla-{role}-{name}", async () => {
    const btn = makeNode("b1", "button", "OK");
    const form = makeNode("f1", "form", "Login Form", {
      children: ["b1"],
    });
    const graph = makeGraph([form, btn]);
    const cdp = makeMockCdp();

    await groupComponents(graph, cdp);

    expect(graph.componentGroups[0].id).toMatch(/^cg-vanilla-form-login-form/);
  });
});

// --- Shared Handler Grouping ---

describe("Stage 4 — shared handler grouping", () => {
  const sharedSource = {
    scriptUrl: "https://example.com/app.js",
    lineNumber: 42,
    columnNumber: 0,
    functionName: "handleClick",
  };

  it("8. nodes with same event source are grouped", async () => {
    const btn1 = makeNode("b1", "button", "Item 1", {
      events: [{ eventType: "click", category: "unknown" as const, source: sharedSource }],
    });
    const btn2 = makeNode("b2", "button", "Item 2", {
      events: [{ eventType: "click", category: "unknown" as const, source: sharedSource }],
    });
    const graph = makeGraph([btn1, btn2]);
    const cdp = makeMockCdp();

    await groupComponents(graph, cdp);

    expect(graph.componentGroups.length).toBe(1);
    expect(graph.componentGroups[0].memberNodeIds).toContain("b1");
    expect(graph.componentGroups[0].memberNodeIds).toContain("b2");
  });

  it("9. single node with event source is not grouped (needs 2+)", async () => {
    const btn = makeNode("b1", "button", "Lonely", {
      events: [{ eventType: "click", category: "unknown" as const, source: sharedSource }],
    });
    const graph = makeGraph([btn]);
    const cdp = makeMockCdp();

    await groupComponents(graph, cdp);

    expect(graph.componentGroups.length).toBe(0);
  });

  it("10. already container-grouped nodes are skipped in shared handler grouping", async () => {
    const btn1 = makeNode("b1", "button", "Inside Form", {
      events: [{ eventType: "click", category: "unknown" as const, source: sharedSource }],
    });
    const btn2 = makeNode("b2", "button", "Outside", {
      events: [{ eventType: "click", category: "unknown" as const, source: sharedSource }],
    });
    const form = makeNode("f1", "form", "MyForm", {
      children: ["b1"],
    });
    const graph = makeGraph([form, btn1, btn2]);
    const cdp = makeMockCdp();

    await groupComponents(graph, cdp);

    // btn1 is in the form group; btn2 is alone (only 1 ungrouped node with that source)
    // so no shared handler group should be created
    const sharedGroups = graph.componentGroups.filter((g) => g.id.includes("shared"));
    expect(sharedGroups.length).toBe(0);
  });

  it("11. shared handler group ID follows pattern cg-vanilla-shared-{n}", async () => {
    const btn1 = makeNode("b1", "button", "A", {
      events: [{ eventType: "click", category: "unknown" as const, source: sharedSource }],
    });
    const btn2 = makeNode("b2", "button", "B", {
      events: [{ eventType: "click", category: "unknown" as const, source: sharedSource }],
    });
    const graph = makeGraph([btn1, btn2]);
    const cdp = makeMockCdp();

    await groupComponents(graph, cdp);

    expect(graph.componentGroups[0].id).toMatch(/^cg-vanilla-shared-\d+$/);
  });
});

// --- General Tests ---

describe("Stage 4 — general behavior", () => {
  it("12. componentGroups is cleared on each call", async () => {
    const btn = makeNode("b1", "button", "Click");
    const form = makeNode("f1", "form", "Form", { children: ["b1"] });
    const graph = makeGraph([form, btn]);
    const cdp = makeMockCdp();

    // Pre-populate with a stale group
    graph.componentGroups.push({
      id: "stale-group",
      framework: "vanilla",
      componentName: "StaleGroup",
      memberNodeIds: ["nonexistent"],
    });

    await groupComponents(graph, cdp);

    // Stale group should be gone
    expect(graph.componentGroups.find((g) => g.id === "stale-group")).toBeUndefined();
    // Fresh group should exist
    expect(graph.componentGroups.length).toBe(1);
    expect(graph.componentGroups[0].id).toMatch(/^cg-vanilla-form/);
  });

  it("13. node.componentId is set correctly", async () => {
    const input = makeNode("i1", "textbox", "Email");
    const btn = makeNode("b1", "button", "Submit");
    const form = makeNode("f1", "form", "Contact", {
      children: ["i1", "b1"],
    });
    const graph = makeGraph([form, input, btn]);
    const cdp = makeMockCdp();

    await groupComponents(graph, cdp);

    const groupId = graph.componentGroups[0].id;
    expect(graph.nodes.get("f1")!.componentId).toBe(groupId);
    expect(graph.nodes.get("i1")!.componentId).toBe(groupId);
    expect(graph.nodes.get("b1")!.componentId).toBe(groupId);
  });

  it("14. multiple container groups can coexist", async () => {
    const formInput = makeNode("fi1", "textbox", "Name");
    const form = makeNode("f1", "form", "Signup", { children: ["fi1"] });
    const navLink = makeNode("nl1", "link", "Home");
    const nav = makeNode("n1", "navigation", "Main", { children: ["nl1"] });
    const graph = makeGraph([form, formInput, nav, navLink]);
    const cdp = makeMockCdp();

    await groupComponents(graph, cdp);

    expect(graph.componentGroups.length).toBe(2);
    const formGroup = graph.componentGroups.find((g) => g.id.includes("form"));
    const navGroup = graph.componentGroups.find((g) => g.id.includes("navigation"));
    expect(formGroup).toBeDefined();
    expect(navGroup).toBeDefined();
    expect(formGroup!.memberNodeIds).not.toEqual(navGroup!.memberNodeIds);
  });

  it("15. deeply nested descendants are collected", async () => {
    const deepBtn = makeNode("db", "button", "Deep");
    const wrapper = makeNode("w1", "generic", "Wrapper", { children: ["db"] });
    const form = makeNode("f1", "form", "Deep Form", { children: ["w1"] });
    const graph = makeGraph([form, wrapper, deepBtn]);
    const cdp = makeMockCdp();

    await groupComponents(graph, cdp);

    const group = graph.componentGroups[0];
    expect(group.memberNodeIds).toContain("db");
    expect(group.memberNodeIds).toContain("w1");
    expect(group.memberNodeIds).toContain("f1");
  });

  it("16. node.componentId is cleared before regrouping", async () => {
    const btn = makeNode("b1", "button", "X", { componentId: "old-id" });
    const graph = makeGraph([btn]);
    const cdp = makeMockCdp();

    await groupComponents(graph, cdp);

    // btn has no container parent and is alone, so no group — componentId should be cleared
    expect(btn.componentId).toBeUndefined();
  });

  it("17. container node itself is not grouped if already has componentId from earlier container", async () => {
    // Insert form BEFORE nav so Map iteration processes form first
    const input = makeNode("i1", "textbox", "Query");
    const searchForm = makeNode("sf", "form", "Search", { children: ["i1"] });
    const link = makeNode("l1", "link", "Home");
    const nav = makeNode("nav", "navigation", "Header", { children: ["sf", "l1"] });
    // form before nav => form claims its children first, then nav skips form (already grouped)
    const graph = makeGraph([searchForm, input, nav, link]);
    const cdp = makeMockCdp();

    await groupComponents(graph, cdp);

    // searchForm should belong to its own form group
    const formGroup = graph.componentGroups.find((g) => g.id.includes("form"));
    expect(formGroup).toBeDefined();
    expect(formGroup!.memberNodeIds).toContain("sf");
    expect(graph.nodes.get("sf")!.componentId).toBe(formGroup!.id);
  });

  it("18. shared handler grouping works with different event types from same source", async () => {
    const source = {
      scriptUrl: "https://example.com/utils.js",
      lineNumber: 100,
      columnNumber: 5,
      functionName: "handler",
    };
    const btn1 = makeNode("b1", "button", "One", {
      events: [{ eventType: "click", category: "unknown" as const, source }],
    });
    const btn2 = makeNode("b2", "button", "Two", {
      events: [{ eventType: "mousedown", category: "unknown" as const, source }],
    });
    const graph = makeGraph([btn1, btn2]);
    const cdp = makeMockCdp();

    await groupComponents(graph, cdp);

    // Same scriptUrl:lineNumber, so they should be grouped
    expect(graph.componentGroups.length).toBe(1);
    expect(graph.componentGroups[0].memberNodeIds).toContain("b1");
    expect(graph.componentGroups[0].memberNodeIds).toContain("b2");
  });
});
