/** The transcript model + presentation helpers. */

/** The payload callers construct. Kept separate from the id because
 * `Omit<Union, k>` collapses a discriminated union to its shared keys. */
export type ItemBody =
  | { kind: "user"; text: string }
  | { kind: "assistant"; text: string }
  | { kind: "tool"; name: string; args: unknown; result: string; ok: boolean; ms: number; nodes: number | null }
  | { kind: "note"; text: string }
  | { kind: "error"; text: string }
  | { kind: "banner"; model: string; tools: number; trace: string };

export type Item = ItemBody & { id: string };

export function num(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

export function ms(n: number): string {
  return n < 1000 ? `${n}ms` : `${(n / 1000).toFixed(1)}s`;
}

/**
 * Render tool args the way Claude Code shows them: `name(k: v, k2: v2)`,
 * values shortened so a 70KB graph body never lands in the header line.
 */
export function formatArgs(args: unknown): string {
  if (!args || typeof args !== "object") return "";
  return Object.entries(args as Record<string, unknown>)
    .map(([k, v]) => {
      const s = typeof v === "string" ? v : JSON.stringify(v);
      const short = s.length > 48 ? s.slice(0, 47) + "…" : s;
      return `${k}: ${short}`;
    })
    .join(", ");
}

/** First meaningful line of a tool result — the one-line gist under `⎿`. */
export function resultSummary(item: Extract<Item, { kind: "tool" }>): string {
  if (!item.ok) return item.result.split("\n")[0]?.slice(0, 100) ?? "failed";
  if (item.nodes !== null) {
    const session = item.result.match(/^session:\s*(\S+)/m)?.[1];
    const page = item.result.match(/^PAGE\s+(\S+)/m)?.[1];
    const bits = [`${item.nodes} nodes`];
    if (session) bits.unshift(`session ${session}`);
    if (page) bits.push(page.length > 40 ? page.slice(0, 39) + "…" : page);
    return bits.join(" · ");
  }
  const first = item.result.split("\n").find((l) => l.trim()) ?? "";
  return first.slice(0, 100);
}

export function bodyLines(item: Extract<Item, { kind: "tool" }>): string[] {
  return item.result.split("\n").filter((l) => l.trim());
}
