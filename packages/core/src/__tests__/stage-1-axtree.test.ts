import { describe, it, expect } from "vitest";
import { shouldKeep, extractState, buildGraphFromAXTree, patchGraphFromDiff } from "../pipeline/stage-1-axtree.js";
import type { AXNode } from "../browser/page.js";
import type { GraphDiff } from "../graph/model.js";
import { makeAXNode, makeGraph, makeNode } from "./helpers.js";

describe("shouldKeep", () => {
  it("returns true for interactive roles", () => {
    const roles = ["button", "link", "textbox", "checkbox", "radio", "combobox", "select", "listbox", "slider", "spinbutton", "switch", "tab", "menuitem", "searchbox", "option", "treeitem"];
    for (const role of roles) {
      const node = makeAXNode({ nodeId: "1", role: { type: "role", value: role } });
      expect(shouldKeep(node), `role=${role}`).toBe(true);
    }
  });

  it("returns true for container roles", () => {
    const roles = ["form", "navigation", "main", "dialog", "alertdialog", "banner", "complementary", "contentinfo", "region", "toolbar", "list", "menu", "menubar", "tablist", "tabpanel", "tree", "grid", "table", "group", "radiogroup", "article", "search"];
    for (const role of roles) {
      const node = makeAXNode({ nodeId: "1", role: { type: "role", value: role } });
      expect(shouldKeep(node), `role=${role}`).toBe(true);
    }
  });

  it("returns true for heading role", () => {
    const node = makeAXNode({ nodeId: "1", role: { type: "role", value: "heading" } });
    expect(shouldKeep(node)).toBe(true);
  });

  it("returns true for image with name", () => {
    const node = makeAXNode({
      nodeId: "1",
      role: { type: "role", value: "image" },
      name: { type: "computedString", value: "Logo" },
    });
    expect(shouldKeep(node)).toBe(true);
  });

  it("returns false for ignored nodes", () => {
    const node = makeAXNode({ nodeId: "1", ignored: true, role: { type: "role", value: "button" } });
    expect(shouldKeep(node)).toBe(false);
  });

  it("returns false for skip roles", () => {
    const roles = ["StaticText", "InlineTextBox", "LineBreak", "generic", "none", "presentation"];
    for (const role of roles) {
      const node = makeAXNode({ nodeId: "1", role: { type: "role", value: role } });
      expect(shouldKeep(node), `role=${role}`).toBe(false);
    }
  });

  it("returns false for unnamed non-interactive nodes", () => {
    const node = makeAXNode({ nodeId: "1", role: { type: "role", value: "paragraph" } });
    expect(shouldKeep(node)).toBe(false);
  });

  it("returns false for image without name", () => {
    const node = makeAXNode({ nodeId: "1", role: { type: "role", value: "image" } });
    expect(shouldKeep(node)).toBe(false);
  });

  it("returns true for a named non-interactive, non-skip role", () => {
    const node = makeAXNode({
      nodeId: "1",
      role: { type: "role", value: "paragraph" },
      name: { type: "computedString", value: "Description" },
    });
    expect(shouldKeep(node)).toBe(true);
  });

  it("returns false when role is empty string and no name", () => {
    const node = makeAXNode({ nodeId: "1", role: { type: "role", value: "" } });
    expect(shouldKeep(node)).toBe(false);
  });
});

describe("extractState", () => {
  it("extracts truthy boolean properties", () => {
    const node = makeAXNode({
      nodeId: "1",
      properties: [
        { name: "disabled", value: { type: "boolean", value: true } },
        { name: "expanded", value: { type: "boolean", value: true } },
        { name: "checked", value: { type: "tristate", value: true } },
      ],
    });
    const state = extractState(node);
    expect(state).toEqual({ disabled: true, expanded: true, checked: true });
  });

  it("skips false/falsy boolean properties", () => {
    const node = makeAXNode({
      nodeId: "1",
      properties: [
        { name: "disabled", value: { type: "boolean", value: false } },
        { name: "expanded", value: { type: "boolean", value: "false" } },
      ],
    });
    const state = extractState(node);
    expect(state).toEqual({});
  });

  it("converts non-boolean values to strings", () => {
    const node = makeAXNode({
      nodeId: "1",
      properties: [
        { name: "level", value: { type: "integer", value: 3 } },
        { name: "autocomplete", value: { type: "token", value: "inline" } },
        { name: "orientation", value: { type: "token", value: "horizontal" } },
      ],
    });
    const state = extractState(node);
    expect(state).toEqual({ level: "3", autocomplete: "inline", orientation: "horizontal" });
  });

  it("returns empty object when no properties", () => {
    const node = makeAXNode({ nodeId: "1" });
    const state = extractState(node);
    expect(state).toEqual({});
  });

  it("returns empty object when no matching state properties", () => {
    const node = makeAXNode({
      nodeId: "1",
      properties: [
        { name: "describedby", value: { type: "idref", value: "desc-1" } },
        { name: "labelledby", value: { type: "idref", value: "label-1" } },
      ],
    });
    const state = extractState(node);
    expect(state).toEqual({});
  });

  it("handles string 'true' as truthy boolean", () => {
    const node = makeAXNode({
      nodeId: "1",
      properties: [
        { name: "required", value: { type: "boolean", value: "true" as unknown as boolean } },
      ],
    });
    const state = extractState(node);
    expect(state).toEqual({ required: true });
  });

  it("skips null and undefined values", () => {
    const node = makeAXNode({
      nodeId: "1",
      properties: [
        { name: "haspopup", value: { type: "token", value: null as unknown } },
      ],
    });
    const state = extractState(node);
    expect(state).toEqual({});
  });
});

describe("buildGraphFromAXTree", () => {
  it("builds graph from simple AXTree with root and children", () => {
    const axNodes: AXNode[] = [
      makeAXNode({ nodeId: "root", role: { type: "role", value: "main" }, childIds: ["btn1", "btn2"] }),
      makeAXNode({ nodeId: "btn1", role: { type: "role", value: "button" }, name: { type: "computedString", value: "Submit" }, parentId: "root" }),
      makeAXNode({ nodeId: "btn2", role: { type: "role", value: "link" }, name: { type: "computedString", value: "Home" }, parentId: "root" }),
    ];

    const graph = buildGraphFromAXTree(axNodes, "https://example.com/page", "Test Page");
    expect(graph.nodes.size).toBe(3);
    expect(graph.nodes.get("btn1")?.role).toBe("button");
    expect(graph.nodes.get("btn1")?.name).toBe("Submit");
    expect(graph.nodes.get("btn2")?.role).toBe("link");
  });

  it("computes correct roots (nodes without kept ancestors)", () => {
    const axNodes: AXNode[] = [
      makeAXNode({ nodeId: "root", role: { type: "role", value: "main" }, childIds: ["btn1"] }),
      makeAXNode({ nodeId: "btn1", role: { type: "role", value: "button" }, name: { type: "computedString", value: "OK" }, parentId: "root" }),
    ];

    const graph = buildGraphFromAXTree(axNodes, "https://example.com", "Test");
    expect(graph.roots).toContain("root");
    expect(graph.roots).not.toContain("btn1");
  });

  it("filters out non-kept nodes but re-links children", () => {
    const axNodes: AXNode[] = [
      makeAXNode({ nodeId: "nav", role: { type: "role", value: "navigation" }, childIds: ["generic1"] }),
      makeAXNode({ nodeId: "generic1", role: { type: "role", value: "generic" }, childIds: ["link1"], parentId: "nav" }),
      makeAXNode({ nodeId: "link1", role: { type: "role", value: "link" }, name: { type: "computedString", value: "About" }, parentId: "generic1" }),
    ];

    const graph = buildGraphFromAXTree(axNodes, "https://example.com", "Test");
    expect(graph.nodes.has("generic1")).toBe(false);
    expect(graph.nodes.get("nav")?.children).toContain("link1");
  });

  it("sets metadata correctly", () => {
    const graph = buildGraphFromAXTree([], "https://example.com/search?q=test", "Search Results");
    expect(graph.metadata.url).toBe("https://example.com/search?q=test");
    expect(graph.metadata.title).toBe("Search Results");
    expect(graph.metadata.route).toBe("/search?q=test");
  });

  it("handles empty AXTree", () => {
    const graph = buildGraphFromAXTree([], "https://example.com", "Empty");
    expect(graph.nodes.size).toBe(0);
    expect(graph.roots).toEqual([]);
  });

  it("sets version to 1", () => {
    const graph = buildGraphFromAXTree([], "https://example.com", "Test");
    expect(graph.version).toBe(1);
  });

  it("children array contains only kept descendants", () => {
    const axNodes: AXNode[] = [
      makeAXNode({ nodeId: "form1", role: { type: "role", value: "form" }, childIds: ["div1", "btn1"] }),
      makeAXNode({ nodeId: "div1", role: { type: "role", value: "generic" }, childIds: ["txt1"], parentId: "form1" }),
      makeAXNode({ nodeId: "txt1", role: { type: "role", value: "textbox" }, name: { type: "computedString", value: "Email" }, parentId: "div1" }),
      makeAXNode({ nodeId: "btn1", role: { type: "role", value: "button" }, name: { type: "computedString", value: "Send" }, parentId: "form1" }),
    ];

    const graph = buildGraphFromAXTree(axNodes, "https://example.com", "Test");
    const formChildren = graph.nodes.get("form1")?.children ?? [];
    expect(formChildren).toContain("txt1");
    expect(formChildren).toContain("btn1");
    expect(formChildren).not.toContain("div1");
  });

  it("initializes networkEdges, apiEndpoints, componentGroups as empty", () => {
    const graph = buildGraphFromAXTree([], "https://example.com", "Test");
    expect(graph.networkEdges).toEqual([]);
    expect(graph.apiEndpoints).toEqual([]);
    expect(graph.componentGroups).toEqual([]);
  });
});

describe("patchGraphFromDiff", () => {
  function buildTestGraph() {
    const axNodes: AXNode[] = [
      makeAXNode({ nodeId: "nav", role: { type: "role", value: "navigation" }, childIds: ["link1", "link2"] }),
      makeAXNode({ nodeId: "link1", role: { type: "role", value: "link" }, name: { type: "computedString", value: "Home" }, parentId: "nav" }),
      makeAXNode({ nodeId: "link2", role: { type: "role", value: "link" }, name: { type: "computedString", value: "About" }, parentId: "nav" }),
    ];
    return buildGraphFromAXTree(axNodes, "https://example.com", "Test");
  }

  it("adds new nodes from diff.added", () => {
    const graph = buildTestGraph();
    const newAXNodes: AXNode[] = [
      makeAXNode({ nodeId: "nav", role: { type: "role", value: "navigation" }, childIds: ["link1", "link2", "link3"] }),
      makeAXNode({ nodeId: "link1", role: { type: "role", value: "link" }, name: { type: "computedString", value: "Home" }, parentId: "nav" }),
      makeAXNode({ nodeId: "link2", role: { type: "role", value: "link" }, name: { type: "computedString", value: "About" }, parentId: "nav" }),
      makeAXNode({ nodeId: "link3", role: { type: "role", value: "link" }, name: { type: "computedString", value: "Contact" }, parentId: "nav" }),
    ];
    const diff: GraphDiff = { added: ["link3"], removed: [], modified: [] };
    patchGraphFromDiff(graph, newAXNodes, diff, "https://example.com", "Test");
    expect(graph.nodes.has("link3")).toBe(true);
    expect(graph.nodes.get("link3")?.name).toBe("Contact");
  });

  it("removes nodes from diff.removed", () => {
    const graph = buildTestGraph();
    const newAXNodes: AXNode[] = [
      makeAXNode({ nodeId: "nav", role: { type: "role", value: "navigation" }, childIds: ["link1"] }),
      makeAXNode({ nodeId: "link1", role: { type: "role", value: "link" }, name: { type: "computedString", value: "Home" }, parentId: "nav" }),
    ];
    const diff: GraphDiff = { added: [], removed: ["link2"], modified: [] };
    patchGraphFromDiff(graph, newAXNodes, diff, "https://example.com", "Test");
    expect(graph.nodes.has("link2")).toBe(false);
  });

  it("updates modified nodes (properties change, events preserved)", () => {
    const graph = buildTestGraph();
    const link1 = graph.nodes.get("link1")!;
    link1.events = [{ eventType: "click", category: "navigation" }];

    const newAXNodes: AXNode[] = [
      makeAXNode({ nodeId: "nav", role: { type: "role", value: "navigation" }, childIds: ["link1", "link2"] }),
      makeAXNode({ nodeId: "link1", role: { type: "role", value: "link" }, name: { type: "computedString", value: "Dashboard" }, parentId: "nav" }),
      makeAXNode({ nodeId: "link2", role: { type: "role", value: "link" }, name: { type: "computedString", value: "About" }, parentId: "nav" }),
    ];
    const diff: GraphDiff = { added: [], removed: [], modified: ["link1"] };
    patchGraphFromDiff(graph, newAXNodes, diff, "https://example.com", "Test");
    expect(graph.nodes.get("link1")?.name).toBe("Dashboard");
    expect(graph.nodes.get("link1")?.events).toHaveLength(1);
    expect(graph.nodes.get("link1")?.events[0].eventType).toBe("click");
  });

  it("recomputes roots after patch", () => {
    const graph = buildTestGraph();
    const newAXNodes: AXNode[] = [
      makeAXNode({ nodeId: "nav", role: { type: "role", value: "navigation" }, childIds: ["link1"] }),
      makeAXNode({ nodeId: "link1", role: { type: "role", value: "link" }, name: { type: "computedString", value: "Home" }, parentId: "nav" }),
      makeAXNode({ nodeId: "btn1", role: { type: "role", value: "button" }, name: { type: "computedString", value: "New" } }),
    ];
    const diff: GraphDiff = { added: ["btn1"], removed: ["link2"], modified: [] };
    patchGraphFromDiff(graph, newAXNodes, diff, "https://example.com", "Test");
    expect(graph.roots).toContain("nav");
    expect(graph.roots).toContain("btn1");
  });

  it("updates metadata (url, title, route)", () => {
    const graph = buildTestGraph();
    const newAXNodes: AXNode[] = [
      makeAXNode({ nodeId: "nav", role: { type: "role", value: "navigation" }, childIds: ["link1", "link2"] }),
      makeAXNode({ nodeId: "link1", role: { type: "role", value: "link" }, name: { type: "computedString", value: "Home" }, parentId: "nav" }),
      makeAXNode({ nodeId: "link2", role: { type: "role", value: "link" }, name: { type: "computedString", value: "About" }, parentId: "nav" }),
    ];
    const diff: GraphDiff = { added: [], removed: [], modified: [] };
    patchGraphFromDiff(graph, newAXNodes, diff, "https://example.com/new-page", "New Page");
    expect(graph.metadata.url).toBe("https://example.com/new-page");
    expect(graph.metadata.title).toBe("New Page");
    expect(graph.metadata.route).toBe("/new-page");
  });

  it("increments version", () => {
    const graph = buildTestGraph();
    expect(graph.version).toBe(1);
    const newAXNodes: AXNode[] = [
      makeAXNode({ nodeId: "nav", role: { type: "role", value: "navigation" }, childIds: ["link1", "link2"] }),
      makeAXNode({ nodeId: "link1", role: { type: "role", value: "link" }, name: { type: "computedString", value: "Home" }, parentId: "nav" }),
      makeAXNode({ nodeId: "link2", role: { type: "role", value: "link" }, name: { type: "computedString", value: "About" }, parentId: "nav" }),
    ];
    const diff: GraphDiff = { added: [], removed: [], modified: [] };
    patchGraphFromDiff(graph, newAXNodes, diff, "https://example.com", "Test");
    expect(graph.version).toBe(2);
  });

  it("cleans removed nodes from parent children arrays", () => {
    const graph = buildTestGraph();
    expect(graph.nodes.get("nav")?.children).toContain("link2");

    const newAXNodes: AXNode[] = [
      makeAXNode({ nodeId: "nav", role: { type: "role", value: "navigation" }, childIds: ["link1"] }),
      makeAXNode({ nodeId: "link1", role: { type: "role", value: "link" }, name: { type: "computedString", value: "Home" }, parentId: "nav" }),
    ];
    const diff: GraphDiff = { added: [], removed: ["link2"], modified: [] };
    patchGraphFromDiff(graph, newAXNodes, diff, "https://example.com", "Test");
    expect(graph.nodes.get("nav")?.children).not.toContain("link2");
  });

  it("filters networkEdges for removed nodes", () => {
    const graph = buildTestGraph();
    graph.networkEdges = [
      { triggerNodeId: "link1", triggerEvent: "click", request: { method: "GET", url: "https://api.example.com/home" } },
      { triggerNodeId: "link2", triggerEvent: "click", request: { method: "GET", url: "https://api.example.com/about" } },
    ];
    const newAXNodes: AXNode[] = [
      makeAXNode({ nodeId: "nav", role: { type: "role", value: "navigation" }, childIds: ["link1"] }),
      makeAXNode({ nodeId: "link1", role: { type: "role", value: "link" }, name: { type: "computedString", value: "Home" }, parentId: "nav" }),
    ];
    const diff: GraphDiff = { added: [], removed: ["link2"], modified: [] };
    patchGraphFromDiff(graph, newAXNodes, diff, "https://example.com", "Test");
    expect(graph.networkEdges).toHaveLength(1);
    expect(graph.networkEdges[0].triggerNodeId).toBe("link1");
  });
});
