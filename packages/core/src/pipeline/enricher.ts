/**
 * Semantic enricher — the pluggable LLM stage.
 *
 * Stage 5's heuristics label the obvious cases (a password field, a search box).
 * What they can't do is read INTENT from an ambiguous button ("Apply", "Continue",
 * a lone icon). That's a job for a language model — and Veil is designed so the
 * model is pluggable, not hardwired to one vendor.
 *
 * The default enricher speaks the OpenAI chat-completions protocol, which is
 * exactly the socket Walter's brain exposes: point VEIL_ENRICH_BASE_URL at it and
 * Walter labels his own eyes' perceptions. Off unless configured — the heuristics
 * alone are a complete, offline Stage 5.
 */
import type { BehaviorGraph, BehaviorNode, SemanticLabel } from "../graph/model.js";
import { debugLog } from "../debug.js";

/** A node the heuristics couldn't confidently label, handed to the enricher. */
export interface EnrichCandidate {
  id: string;
  role: string;
  name: string;
  /** Effects the node triggers (e.g. "POST /api/apply", "navigation") — the
   * behavioral context an LLM needs to guess intent. */
  effects: string[];
  currentLabel?: SemanticLabel;
}

export interface EnricherResult {
  id: string;
  category: string;
  action: string;
  confidence: number;
}

/** Pluggable contract: given ambiguous nodes, return labels for the ones it can
 * classify. Implementations MUST be side-effect free and tolerant of failure. */
export interface SemanticEnricher {
  enrich(candidates: EnrichCandidate[]): Promise<EnricherResult[]>;
}

/** Below this heuristic confidence a node is considered "ambiguous" and offered
 * to the enricher. */
export const ENRICH_CONFIDENCE_FLOOR = 0.6;
const MAX_CANDIDATES = 20;

export function collectCandidates(graph: BehaviorGraph): EnrichCandidate[] {
  const out: EnrichCandidate[] = [];
  for (const node of graph.nodes.values()) {
    if (!isActionable(node)) continue;
    const conf = node.semanticLabel?.confidence ?? 0;
    if (node.semanticLabel && conf >= ENRICH_CONFIDENCE_FLOOR) continue;
    out.push({
      id: node.id,
      role: node.role,
      name: node.name,
      effects: node.events
        .map((e) => e.estimatedEffect ?? e.category)
        .filter(Boolean),
      currentLabel: node.semanticLabel,
    });
    if (out.length >= MAX_CANDIDATES) break;
  }
  return out;
}

function isActionable(node: BehaviorNode): boolean {
  return (
    node.events.length > 0 ||
    ["button", "link", "textbox", "combobox", "checkbox"].includes(node.role)
  );
}

/** Apply enricher results back onto the graph as source:'llm' labels. Only
 * overrides when the enricher is at least as confident as the heuristic. */
export function applyEnrichment(graph: BehaviorGraph, results: EnricherResult[]): void {
  for (const r of results) {
    const node = graph.nodes.get(r.id);
    if (!node) continue;
    const existing = node.semanticLabel?.confidence ?? 0;
    if (r.confidence < existing) continue;
    node.semanticLabel = {
      category: r.category,
      action: r.action,
      confidence: Math.max(0, Math.min(1, r.confidence)),
      source: "llm",
    };
  }
}

/**
 * OpenAI-compatible enricher. Reads:
 *   VEIL_ENRICH_BASE_URL   e.g. http://localhost:11434/v1 or Walter's brain socket
 *   VEIL_ENRICH_MODEL      model id (default "gpt-4o-mini")
 *   VEIL_ENRICH_API_KEY    optional bearer token
 * Returns [] on any failure — enrichment is best-effort, never blocks a build.
 */
export class OpenAICompatEnricher implements SemanticEnricher {
  constructor(
    private baseUrl: string,
    private model: string,
    private apiKey?: string,
  ) {}

  static fromEnv(): OpenAICompatEnricher | null {
    const baseUrl = process.env.VEIL_ENRICH_BASE_URL;
    if (!baseUrl) return null;
    return new OpenAICompatEnricher(
      baseUrl.replace(/\/$/, ""),
      process.env.VEIL_ENRICH_MODEL ?? "gpt-4o-mini",
      process.env.VEIL_ENRICH_API_KEY,
    );
  }

  async enrich(candidates: EnrichCandidate[]): Promise<EnricherResult[]> {
    if (candidates.length === 0) return [];
    const prompt = buildPrompt(candidates);
    try {
      const res = await fetch(`${this.baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(this.apiKey ? { authorization: `Bearer ${this.apiKey}` } : {}),
        },
        body: JSON.stringify({
          model: this.model,
          temperature: 0,
          messages: [
            { role: "system", content: SYSTEM_PROMPT },
            { role: "user", content: prompt },
          ],
          response_format: { type: "json_object" },
        }),
      });
      if (!res.ok) {
        debugLog("enricher: HTTP", res.status);
        return [];
      }
      const data = (await res.json()) as {
        choices?: { message?: { content?: string } }[];
      };
      const content = data.choices?.[0]?.message?.content;
      if (!content) return [];
      const parsed = JSON.parse(content) as { labels?: EnricherResult[] };
      return Array.isArray(parsed.labels)
        ? parsed.labels.filter(
            (l) =>
              typeof l.id === "string" &&
              typeof l.category === "string" &&
              typeof l.action === "string" &&
              typeof l.confidence === "number",
          )
        : [];
    } catch (err) {
      debugLog("enricher: failed", err);
      return [];
    }
  }
}

const SYSTEM_PROMPT =
  "You label UI elements with their semantic purpose for an AI web agent. " +
  "Given a list of ambiguous elements (id, role, accessible name, and the effects " +
  "they trigger), return JSON {\"labels\":[{id, category, action, confidence}]}. " +
  "category is a broad domain (auth, search, navigation, commerce, content, media, " +
  "social, settings, form, interactive). action is a specific verb (login, submit, " +
  "add-to-cart, play, share, filter, apply, next-step...). confidence 0-1. Only " +
  "include elements you can classify with real confidence; omit the rest.";

function buildPrompt(candidates: EnrichCandidate[]): string {
  const lines = candidates.map(
    (c) =>
      `- id=${c.id} role=${c.role} name=${JSON.stringify(c.name)} effects=[${c.effects.join(", ")}]`,
  );
  return `Elements:\n${lines.join("\n")}`;
}
