import { describe, it, expect } from "vitest";
import { makeDisplayId, buildDisplayIdRegistry } from "../graph/display-ids.js";
import { makeGraph, makeNode } from "./helpers.js";

describe("makeDisplayId", () => {
  it("creates id from role-name (lowercased, special chars replaced)", () => {
    const node = makeNode({ id: "ax-1", role: "button", name: "Submit Form" });
    expect(makeDisplayId(node)).toBe("button-submit-form");
  });

  it("truncates name to 30 chars", () => {
    const longName = "A".repeat(50);
    const node = makeNode({ id: "ax-1", role: "link", name: longName });
    const displayId = makeDisplayId(node);
    // role- prefix + up to 30 chars of processed name
    const namePart = displayId.replace("link-", "");
    expect(namePart.length).toBeLessThanOrEqual(30);
  });

  it("falls back to role-nodeId when no name", () => {
    const node = makeNode({ id: "ax-42", role: "button", name: "" });
    expect(makeDisplayId(node)).toBe("button-ax-42");
  });

  it("handles special characters in name", () => {
    const node = makeNode({ id: "ax-1", role: "button", name: "Add to Cart! (50% off)" });
    const displayId = makeDisplayId(node);
    expect(displayId).toBe("button-add-to-cart-50-off");
    expect(displayId).not.toMatch(/[^a-z0-9-]/);
  });

  it("strips leading and trailing hyphens from name part", () => {
    const node = makeNode({ id: "ax-1", role: "link", name: "---hello---" });
    expect(makeDisplayId(node)).toBe("link-hello");
  });
});

describe("buildDisplayIdRegistry", () => {
  it("creates bidirectional mapping", () => {
    const nodes = new Map([
      ["ax1", makeNode({ id: "ax1", role: "button", name: "OK" })],
      ["ax2", makeNode({ id: "ax2", role: "link", name: "Home" })],
    ]);
    const graph = makeGraph({ nodes });
    const registry = buildDisplayIdRegistry(graph);

    expect(registry.toDisplay.get("ax1")).toBe("button-ok");
    expect(registry.toDisplay.get("ax2")).toBe("link-home");
    expect(registry.toInternal.get("button-ok")).toBe("ax1");
    expect(registry.toInternal.get("link-home")).toBe("ax2");
  });

  it("handles duplicate display IDs (appends -2, -3 etc.)", () => {
    const nodes = new Map([
      ["ax1", makeNode({ id: "ax1", role: "button", name: "OK" })],
      ["ax2", makeNode({ id: "ax2", role: "button", name: "OK" })],
      ["ax3", makeNode({ id: "ax3", role: "button", name: "OK" })],
    ]);
    const graph = makeGraph({ nodes });
    const registry = buildDisplayIdRegistry(graph);

    const displayIds = [...registry.toDisplay.values()];
    expect(displayIds).toContain("button-ok");
    expect(displayIds).toContain("button-ok-2");
    expect(displayIds).toContain("button-ok-3");
  });

  it("works with empty graph", () => {
    const graph = makeGraph();
    const registry = buildDisplayIdRegistry(graph);
    expect(registry.toDisplay.size).toBe(0);
    expect(registry.toInternal.size).toBe(0);
  });

  it("all mappings are consistent (round-trip)", () => {
    const nodes = new Map([
      ["ax1", makeNode({ id: "ax1", role: "button", name: "Save" })],
      ["ax2", makeNode({ id: "ax2", role: "textbox", name: "Email" })],
    ]);
    const graph = makeGraph({ nodes });
    const registry = buildDisplayIdRegistry(graph);

    for (const [axId, displayId] of registry.toDisplay) {
      expect(registry.toInternal.get(displayId)).toBe(axId);
    }
  });
});
