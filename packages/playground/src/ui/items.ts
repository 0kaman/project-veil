/** The transcript model + presentation helpers. */

export type ItemBody =
  | { kind: "user"; text: string }
  | { kind: "assistant"; text: string }
  | { kind: "tool"; name: string; args: unknown; result: string; ok: boolean; ms: number; via: string | null }
  | { kind: "note"; text: string }
  | { kind: "error"; text: string }
  | { kind: "banner"; model: string; tools: string[]; trace: string };

export type Item = ItemBody & { id: string };

export function num(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

export function ms(n: number): string {
  return n < 1000 ? `${n}ms` : `${(n / 1000).toFixed(1)}s`;
}

/** Claude-Code-style arg rendering: name(k: v, …), values shortened. */
export function formatArgs(args: unknown): string {
  if (!args || typeof args !== "object") return "";
  return Object.entries(args as Record<string, unknown>)
    .map(([k, v]) => {
      const s = typeof v === "string" ? v : JSON.stringify(v);
      return `${k}: ${s.length > 52 ? s.slice(0, 51) + "…" : s}`;
    })
    .join(", ");
}

/** The one-line summary under ⎿ — the receipt if present, else the first line. */
export function toolSummary(item: Extract<Item, { kind: "tool" }>): string {
  if (item.via) return item.via.replace(/^via:\s*/, "");
  const first = item.result.split("\n").find((l) => l.trim()) ?? "";
  return first.slice(0, 100);
}

/** Body lines to preview under a tool result (past the receipt line). */
export function bodyLines(item: Extract<Item, { kind: "tool" }>): string[] {
  const lines = item.result.split("\n").filter((l) => l.trim());
  // drop the receipt line itself; it's already the summary
  return lines.filter((l) => !l.startsWith("via:"));
}
