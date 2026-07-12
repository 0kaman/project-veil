import { describe, it, expect } from "vitest";
import { inferSemantics, reinferSemantics } from "../pipeline/stage-5-semantics.js";
import type {
  BehaviorGraph,
  BehaviorNode,
  NetworkEdge,
  SemanticLabel,
  ComponentGroup,
} from "../graph/model.js";

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
  componentGroups: ComponentGroup[] = [],
): BehaviorGraph {
  const nodeMap = new Map(nodes.map((n) => [n.id, n]));
  return {
    metadata: { url: "https://example.com", title: "Test", timestamp: Date.now(), route: "/" },
    version: 1,
    nodes: nodeMap,
    roots: nodes.filter((n) => !nodes.some((p) => p.children.includes(n.id))).map((n) => n.id),
    networkEdges,
    apiEndpoints: [],
    componentGroups,
  };
}

// --- Heuristic Rule Tests ---

describe("Stage 5 — inferSemantics", () => {
  describe("search input heuristics", () => {
    it("1. searchbox role -> search:input at 0.95", async () => {
      const node = makeNode("sb1", "searchbox", "Find items");
      const graph = makeGraph([node]);
      await inferSemantics(graph);
      expect(node.semanticLabel).toEqual({
        category: "search",
        action: "input",
        confidence: 0.95,
        source: "heuristic",
      });
    });

    it("2. textbox with 'search' in name -> search:input at 0.80", async () => {
      const node = makeNode("tb1", "textbox", "Search products");
      const graph = makeGraph([node]);
      await inferSemantics(graph);
      expect(node.semanticLabel).toEqual({
        category: "search",
        action: "input",
        confidence: 0.80,
        source: "heuristic",
      });
    });
  });

  describe("navigation landmark heuristics", () => {
    it("3. navigation role -> navigation:primary at 0.90", async () => {
      const node = makeNode("nav1", "navigation", "Main menu", { children: [] });
      const graph = makeGraph([node]);
      await inferSemantics(graph);
      expect(node.semanticLabel).toEqual({
        category: "navigation",
        action: "primary",
        confidence: 0.90,
        source: "heuristic",
      });
    });

    it("4. navigation with 'footer' in name -> navigation:secondary at 0.90", async () => {
      const node = makeNode("nav2", "navigation", "Footer Navigation");
      const graph = makeGraph([node]);
      await inferSemantics(graph);
      expect(node.semanticLabel).toEqual({
        category: "navigation",
        action: "secondary",
        confidence: 0.90,
        source: "heuristic",
      });
    });
  });

  describe("dynamic live region heuristics", () => {
    it("5. alert role -> dynamic:live-region at 0.90", async () => {
      const node = makeNode("a1", "alert", "Error message");
      const graph = makeGraph([node]);
      await inferSemantics(graph);
      expect(node.semanticLabel).toEqual({
        category: "dynamic",
        action: "live-region",
        confidence: 0.90,
        source: "heuristic",
      });
    });

    it("6. status role -> dynamic:live-region", async () => {
      const node = makeNode("s1", "status", "Loading...");
      const graph = makeGraph([node]);
      await inferSemantics(graph);
      expect(node.semanticLabel?.category).toBe("dynamic");
      expect(node.semanticLabel?.action).toBe("live-region");
    });
  });

  describe("commerce heuristics", () => {
    it("7. button named 'Add to Cart' -> commerce:add-to-cart at 0.90", async () => {
      const node = makeNode("btn1", "button", "Add to Cart");
      const graph = makeGraph([node]);
      await inferSemantics(graph);
      expect(node.semanticLabel).toEqual({
        category: "commerce",
        action: "add-to-cart",
        confidence: 0.90,
        source: "heuristic",
      });
    });

    it("8. button named 'Checkout' -> commerce:checkout at 0.85", async () => {
      const node = makeNode("btn2", "button", "Checkout");
      const graph = makeGraph([node]);
      await inferSemantics(graph);
      expect(node.semanticLabel).toEqual({
        category: "commerce",
        action: "checkout",
        confidence: 0.85,
        source: "heuristic",
      });
    });

    it("9. button named 'Buy Now' -> commerce:checkout", async () => {
      const node = makeNode("btn3", "button", "Buy Now");
      const graph = makeGraph([node]);
      await inferSemantics(graph);
      expect(node.semanticLabel?.category).toBe("commerce");
      expect(node.semanticLabel?.action).toBe("checkout");
    });
  });

  describe("auth form heuristics", () => {
    it("10. form with password + 1-2 inputs -> auth:login at 0.85", async () => {
      const emailField = makeNode("email", "textbox", "Email");
      const passField = makeNode("pass", "textbox", "Password");
      const form = makeNode("form1", "form", "Login", {
        children: ["email", "pass"],
      });
      const graph = makeGraph([form, emailField, passField]);
      await inferSemantics(graph);
      expect(form.semanticLabel).toEqual({
        category: "auth",
        action: "login",
        confidence: 0.85,
        source: "heuristic",
      });
    });

    it("11. form with password + 3+ inputs -> auth:signup at 0.85", async () => {
      const nameField = makeNode("name", "textbox", "Full Name");
      const emailField = makeNode("email", "textbox", "Email");
      const passField = makeNode("pass", "textbox", "Password");
      const form = makeNode("form2", "form", "Register", {
        children: ["name", "email", "pass"],
      });
      const graph = makeGraph([form, nameField, emailField, passField]);
      await inferSemantics(graph);
      expect(form.semanticLabel).toEqual({
        category: "auth",
        action: "signup",
        confidence: 0.85,
        source: "heuristic",
      });
    });
  });

  describe("form submit heuristics", () => {
    it("12. button with form_submit event -> form:submit at 0.80", async () => {
      const node = makeNode("btn4", "button", "Go", {
        events: [
          {
            eventType: "submit",
            category: "form_submit",
            source: { scriptUrl: "app.js", lineNumber: 10, columnNumber: 0, functionName: "handleSubmit" },
          },
        ],
      });
      const graph = makeGraph([node]);
      await inferSemantics(graph);
      expect(node.semanticLabel).toEqual({
        category: "form",
        action: "submit",
        confidence: 0.80,
        source: "heuristic",
      });
    });

    it("13. button named 'Sign In' -> form:submit at 0.75", async () => {
      const node = makeNode("btn5", "button", "Sign In");
      const graph = makeGraph([node]);
      await inferSemantics(graph);
      expect(node.semanticLabel).toEqual({
        category: "form",
        action: "submit",
        confidence: 0.75,
        source: "heuristic",
      });
    });
  });

  describe("content list heuristics", () => {
    it("14. list with 3+ link children -> content:list at 0.75", async () => {
      const link1 = makeNode("l1", "link", "Item 1");
      const link2 = makeNode("l2", "link", "Item 2");
      const link3 = makeNode("l3", "link", "Item 3");
      const list = makeNode("list1", "list", "Results", {
        children: ["l1", "l2", "l3"],
      });
      const graph = makeGraph([list, link1, link2, link3]);
      await inferSemantics(graph);
      expect(list.semanticLabel).toEqual({
        category: "content",
        action: "list",
        confidence: 0.75,
        source: "heuristic",
      });
    });

    it("15. list with 1 link -> no label", async () => {
      const link1 = makeNode("l1", "link", "Only item");
      const list = makeNode("list2", "list", "Short list", {
        children: ["l1"],
      });
      const graph = makeGraph([list, link1]);
      await inferSemantics(graph);
      expect(list.semanticLabel).toBeUndefined();
    });
  });

  describe("API trigger heuristic", () => {
    it("16. node with events + matching networkEdge -> interactive:api-trigger at 0.55", async () => {
      const node = makeNode("btn6", "button", "Load Data", {
        events: [
          {
            eventType: "click",
            category: "api_call",
            source: { scriptUrl: "app.js", lineNumber: 20, columnNumber: 0, functionName: "fetchData" },
          },
        ],
      });
      const networkEdge: NetworkEdge = {
        triggerNodeId: "btn6",
        triggerEvent: "click",
        request: { method: "GET", url: "https://api.example.com/data" },
      };
      const graph = makeGraph([node], [networkEdge]);
      await inferSemantics(graph);
      // api-trigger is its OWN category (not "form" — a Refresh/Load-more button
      // that fires a fetch is not a form). Fixed 2026-07.
      expect(node.semanticLabel?.category).toBe("interactive");
      expect(node.semanticLabel?.action).toBe("api-trigger");
      expect(node.semanticLabel?.confidence).toBe(0.55);
    });
  });

  describe("edge cases", () => {
    it("17. generic button with no matching patterns -> no semanticLabel", async () => {
      const node = makeNode("btn7", "button", "OK");
      const graph = makeGraph([node]);
      await inferSemantics(graph);
      expect(node.semanticLabel).toBeUndefined();
    });

    it("18. highest confidence wins — searchbox gets 0.95 over other rules", async () => {
      // A searchbox that also has events — search:input (0.95) should win over api-trigger (0.50)
      const node = makeNode("sb2", "searchbox", "Search", {
        events: [
          {
            eventType: "input",
            category: "api_call",
            source: { scriptUrl: "app.js", lineNumber: 5, columnNumber: 0, functionName: "onSearch" },
          },
        ],
      });
      const networkEdge: NetworkEdge = {
        triggerNodeId: "sb2",
        triggerEvent: "input",
        request: { method: "GET", url: "https://api.example.com/search" },
      };
      const graph = makeGraph([node], [networkEdge]);
      await inferSemantics(graph);
      expect(node.semanticLabel?.category).toBe("search");
      expect(node.semanticLabel?.action).toBe("input");
      expect(node.semanticLabel?.confidence).toBe(0.95);
    });
  });
});

// --- reinferSemantics Tests ---

describe("Stage 5 — reinferSemantics", () => {
  it("19. preserves LLM labels after re-inference", async () => {
    const node = makeNode("n1", "button", "Custom Action");
    const graph = makeGraph([node]);
    const llmLabel: SemanticLabel = {
      category: "custom",
      action: "special",
      confidence: 0.92,
      source: "llm",
    };
    node.semanticLabel = llmLabel;

    reinferSemantics(graph);

    expect(node.semanticLabel).toEqual(llmLabel);
  });

  it("20. re-applies heuristic labels from scratch", async () => {
    const node = makeNode("n2", "searchbox", "Search");
    const graph = makeGraph([node]);

    // First inference
    await inferSemantics(graph);
    expect(node.semanticLabel?.confidence).toBe(0.95);

    // Manually corrupt the label
    node.semanticLabel = {
      category: "search",
      action: "input",
      confidence: 0.50,
      source: "heuristic",
    };

    // reinfer should recompute from scratch
    reinferSemantics(graph);
    expect(node.semanticLabel?.confidence).toBe(0.95);
  });

  it("21. restores LLM labels over heuristic labels", async () => {
    // Node that matches a heuristic rule AND has an LLM label
    const node = makeNode("n3", "searchbox", "Search");
    const graph = makeGraph([node]);

    const llmLabel: SemanticLabel = {
      category: "search",
      action: "autocomplete",
      confidence: 0.98,
      source: "llm",
    };
    node.semanticLabel = llmLabel;

    reinferSemantics(graph);

    // LLM label should override the heuristic label
    expect(node.semanticLabel).toEqual(llmLabel);
  });
});

// --- Group Heuristic Tests ---

describe("Stage 5 — group heuristics", () => {
  function makeGroup(id: string, componentName: string, memberNodeIds: string[]): ComponentGroup {
    return {
      id,
      framework: "vanilla",
      componentName,
      memberNodeIds,
    };
  }

  it("22. group named 'LoginForm' -> auth:login", async () => {
    const node = makeNode("n1", "button", "Submit");
    const group = makeGroup("cg1", "LoginForm", ["n1"]);
    const graph = makeGraph([node], [], [group]);
    await inferSemantics(graph);
    expect(group.semanticLabel?.category).toBe("auth");
    expect(group.semanticLabel?.action).toBe("login");
  });

  it("23. group named 'SignupForm' -> auth:signup", async () => {
    const node = makeNode("n1", "button", "Register");
    const group = makeGroup("cg2", "SignupForm", ["n1"]);
    const graph = makeGraph([node], [], [group]);
    await inferSemantics(graph);
    expect(group.semanticLabel?.category).toBe("auth");
    expect(group.semanticLabel?.action).toBe("signup");
  });

  it("24. group named 'SearchBar' -> search:input", async () => {
    const node = makeNode("n1", "textbox", "Query");
    const group = makeGroup("cg3", "SearchBar", ["n1"]);
    const graph = makeGraph([node], [], [group]);
    await inferSemantics(graph);
    expect(group.semanticLabel?.category).toBe("search");
    expect(group.semanticLabel?.action).toBe("input");
  });

  it("25. group named 'NavMenu' -> navigation:primary", async () => {
    const node = makeNode("n1", "link", "Home");
    const group = makeGroup("cg4", "NavMenu", ["n1"]);
    const graph = makeGraph([node], [], [group]);
    await inferSemantics(graph);
    expect(group.semanticLabel?.category).toBe("navigation");
    expect(group.semanticLabel?.action).toBe("primary");
  });

  it("26. group named 'CartWidget' -> commerce:checkout", async () => {
    const node = makeNode("n1", "button", "View Cart");
    const group = makeGroup("cg5", "CartWidget", ["n1"]);
    const graph = makeGraph([node], [], [group]);
    await inferSemantics(graph);
    expect(group.semanticLabel?.category).toBe("commerce");
    expect(group.semanticLabel?.action).toBe("checkout");
  });

  it("27. group named 'ContactForm' -> form:submit", async () => {
    const node = makeNode("n1", "textbox", "Message");
    const group = makeGroup("cg6", "ContactForm", ["n1"]);
    const graph = makeGraph([node], [], [group]);
    await inferSemantics(graph);
    expect(group.semanticLabel?.category).toBe("form");
    expect(group.semanticLabel?.action).toBe("submit");
  });

  it("28. group with no matching name -> no semanticLabel", async () => {
    const node = makeNode("n1", "button", "Click");
    const group = makeGroup("cg7", "RandomWidget", ["n1"]);
    const graph = makeGraph([node], [], [group]);
    await inferSemantics(graph);
    expect(group.semanticLabel).toBeUndefined();
  });
});

// --- Label Propagation Tests ---

describe("Stage 5 — label propagation", () => {
  function makeGroup(id: string, componentName: string, memberNodeIds: string[]): ComponentGroup {
    return {
      id,
      framework: "vanilla",
      componentName,
      memberNodeIds,
    };
  }

  it("29. group label propagates only onto generic members, never over self-defining inputs", async () => {
    // Inputs are self-defining: a password field is auth:password-input, a username
    // field is auth:identifier-input — they must NOT inherit the group's "login"
    // (this was the 0.56 form:submit smear). A generic member DOES inherit.
    const username = makeNode("n1", "textbox", "Username");
    const password = makeNode("n2", "textbox", "Password field");
    const generic = makeNode("n3", "generic", "wrapper");
    const group = makeGroup("cg-login", "LoginForm", ["n1", "n2", "n3"]);
    const graph = makeGraph([username, password, generic], [], [group]);

    await inferSemantics(graph);

    expect(group.semanticLabel?.confidence).toBe(0.85);
    // inputs keep their OWN meaning
    expect(username.semanticLabel?.action).toBe("identifier-input");
    expect(password.semanticLabel?.action).toBe("password-input");
    // only the generic wrapper inherits the group context (0.85 * 0.7 = 0.60)
    expect(generic.semanticLabel?.category).toBe("auth");
    expect(generic.semanticLabel?.source).toBe("inherited");
    expect(generic.semanticLabel?.confidence).toBeCloseTo(0.60);
  });

  it("30. propagated labels don't override existing node labels", async () => {
    const searchBox = makeNode("sb", "searchbox", "Search");
    const textbox = makeNode("tb", "textbox", "Query");
    const group = makeGroup("cg-search", "SearchBar", ["sb", "tb"]);
    const graph = makeGraph([searchBox, textbox], [], [group]);

    await inferSemantics(graph);

    // searchBox gets its own heuristic label (search:input at 0.95) — should NOT be overridden
    expect(searchBox.semanticLabel?.confidence).toBe(0.95);
    // a plain textbox is self-defining: it does NOT inherit the group's search label
    // (prevents mislabeling distinct inputs). No rule matches "Query" -> unlabeled.
    expect(textbox.semanticLabel).toBeUndefined();
  });
});
