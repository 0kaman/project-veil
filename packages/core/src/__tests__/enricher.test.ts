import { describe, it, expect } from "vitest";
import type { BehaviorGraph, BehaviorNode } from "../graph/model.js";
import { inferSemantics } from "../pipeline/stage-5-semantics.js";
import {
  collectCandidates,
  applyEnrichment,
  type SemanticEnricher,
  type EnricherResult,
} from "../pipeline/enricher.js";

function node(id: string, role: string, name: string, partial: Partial<BehaviorNode> = {}): BehaviorNode {
  return {
    id,
    role,
    name,
    description: "",
    state: {},
    value: "",
    backendDOMNodeId: 1,
    children: [],
    events: [],
    ...partial,
  };
}

function graphOf(nodes: BehaviorNode[]): BehaviorGraph {
  return {
    metadata: { url: "https://x.com", title: "X", route: "/", timestamp: 0 },
    version: 1,
    nodes: new Map(nodes.map((n) => [n.id, n])),
    roots: nodes.map((n) => n.id),
    networkEdges: [],
    apiEndpoints: [],
    componentGroups: [],
  };
}

describe("Stage 5 — pluggable LLM enricher", () => {
  it("offers only ambiguous (low-confidence / unlabeled) actionable nodes", () => {
    const graph = graphOf([
      node("a", "button", "Apply now", { events: [{ eventType: "click", category: "api_call", estimatedEffect: "POST /apply" }] }),
      node("b", "textbox", "Password", { semanticLabel: { category: "auth", action: "password-input", confidence: 0.9, source: "heuristic" } }),
      node("c", "generic", "wrapper"),
    ]);
    const candidates = collectCandidates(graph);
    const ids = candidates.map((c) => c.id);
    expect(ids).toContain("a"); // ambiguous actionable button → offered
    expect(ids).not.toContain("b"); // confidently labeled → skipped
    expect(ids).not.toContain("c"); // not actionable → skipped
    expect(candidates[0].effects).toContain("POST /apply"); // behavioral context passed
  });

  it("a supplied enricher labels ambiguous nodes with source:'llm'", async () => {
    const fake: SemanticEnricher = {
      async enrich(cands): Promise<EnricherResult[]> {
        return cands.map((c) => ({ id: c.id, category: "jobs", action: "apply", confidence: 0.88 }));
      },
    };
    const graph = graphOf([
      node("a", "button", "Apply now", { events: [{ eventType: "click", category: "api_call", estimatedEffect: "POST /apply" }] }),
    ]);
    await inferSemantics(graph, fake);
    const label = graph.nodes.get("a")!.semanticLabel;
    expect(label).toEqual({ category: "jobs", action: "apply", confidence: 0.88, source: "llm" });
  });

  it("enricher never lowers a more-confident heuristic label", () => {
    const graph = graphOf([
      node("a", "searchbox", "Search", { semanticLabel: { category: "search", action: "input", confidence: 0.95, source: "heuristic" } }),
    ]);
    applyEnrichment(graph, [{ id: "a", category: "wrong", action: "x", confidence: 0.5 }]);
    expect(graph.nodes.get("a")!.semanticLabel!.source).toBe("heuristic");
    expect(graph.nodes.get("a")!.semanticLabel!.category).toBe("search");
  });

  it("heuristics alone are complete when no enricher is configured", async () => {
    const graph = graphOf([
      node("p", "textbox", "Password field"),
    ]);
    await inferSemantics(graph); // no enricher, no env
    expect(graph.nodes.get("p")!.semanticLabel?.action).toBe("password-input");
  });
});
