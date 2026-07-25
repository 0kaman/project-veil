/**
 * Rendering tool results to the text an LLM reads.
 *
 * Every rendering LEADS with the receipt — path, cost, and what's missing —
 * before any content. That ordering is deliberate: the model should know how
 * much to trust what follows before it reads it. This is the receipt principle
 * at the surface the agent actually sees.
 */
import type { SearchResult } from "@veil/search";
import type { ReadResult } from "@veil/read";
import type { Pull } from "@veil/read";
import type { OpenResult, QueryResult, GoneReason, BehaviorNode, ActResult } from "@veil/core";

export function renderSearch(r: SearchResult): string {
  const c = r.receipt;
  const head = `via: ${c.via} · ${c.ms}ms · ${c.status}${c.status === "ok" ? ` · ${c.count} results` : ""}`;
  if (c.status !== "ok") {
    return `${head}${c.note ? `\n${c.note}` : ""}`;
  }
  const lines = r.results.map((x, i) => {
    const age = x.age ? ` (${x.age})` : "";
    return `${i + 1}. ${x.title}\n   ${x.url}\n   ${x.description}${age}`;
  });
  return `${head}\n\n${lines.join("\n\n")}`;
}

export function renderRead(r: ReadResult): string {
  const c = r.receipt;

  if (c.status !== "ok") {
    // Non-ok is the whole point of the receipt: say exactly why, and where next.
    const head = `via: ${c.via} · ${c.ms}ms · ${c.status.toUpperCase()}`;
    return `${head}${c.note ? `\n${c.note}` : ""}`;
  }

  const size = c.truncated ? `${c.words} of ${c.totalWords} words` : `${c.words} words`;
  const extractor = c.extractor === "fallback" ? " · fallback extractor" : "";
  // Status word present and consistent with search ("· ok ·"), so the receipt is
  // parseable by the escalation metric and legible to the model.
  const head = `via: ${c.via} · ${c.ms}ms · ok · ${size}${extractor}${r.handle ? ` · handle ${r.handle}` : ""}`;

  const parts = [head];
  if (r.title) parts.push(`title: ${r.title}`);
  if (r.outline.length > 0) parts.push(`outline: ${r.outline.join(" · ")}`);
  parts.push("");
  parts.push(r.text);
  if (c.truncated && r.handle) {
    parts.push("");
    parts.push(`[truncated — veil_read("${r.handle}", query: "…") to pull a specific part]`);
  }
  return parts.join("\n");
}

export function renderPull(pull: Pull, handle: string): string {
  const head =
    `via: handle ${handle} · ${pull.words} of ${pull.totalWords} words · ` +
    `${pull.matched} matching paragraph${pull.matched === 1 ? "" : "s"}`;
  const parts = [head];
  if (pull.note) parts.push(pull.note);
  parts.push("");
  parts.push(pull.text || "(no text)");
  return parts.join("\n");
}

// ── the act path ───────────────────────────────────────────────────────────

export function renderOpen(r: OpenResult): string {
  if (!r.ok) {
    return `via: engine · ${r.ms}ms · FAILED\n${r.error ?? "unknown error"}`;
  }
  const mem = r.memoryMb && r.memoryMb > 0 ? ` · browser ${r.memoryMb}MB` : "";
  const head = `via: engine · ${r.ms}ms · session ${r.sessionId}${mem}`;
  const parts = [head];
  // Eviction is never silent: if opening this page cost someone else their tab,
  // say so, because the agent may hold that handle.
  if (r.evicted && r.evicted.length > 0) {
    parts.push(`note: reclaimed ${r.evicted.join(", ")} to make room (memory pressure)`);
  }
  parts.push("");
  parts.push(r.lean ?? "");
  return parts.join("\n");
}

function nodeLine(n: BehaviorNode): string {
  const state = Object.entries(n.state);
  const st = state.length ? ` {${state.map(([k, v]) => (v === true ? k : `${k}:${v}`)).join(", ")}}` : "";
  return `  ${n.id} [${n.role}]${n.name ? ` "${n.name}"` : ""}${st}${n.fires ? `  → ${n.fires}` : ""}`;
}

export function renderQuery(session: string, res: QueryResult | { gone: GoneReason }): string {
  if ("gone" in res) {
    return (
      `via: engine · session ${session} is gone (${res.gone})\n` +
      `Re-open the page with veil_open — a reclaimed session cannot be resumed.`
    );
  }
  const head = `via: engine · ${res.matched} match${res.matched === 1 ? "" : "es"}`;
  const parts = [res.note ? `${head}\n${res.note}` : head, ""];
  if (res.returned.length === 0) parts.push("  (nothing matched — try a broader filter)");
  for (const n of res.returned) parts.push(nodeLine(n));
  return parts.join("\n");
}

export function renderSessions(
  list: Array<{ id: string; url: string; ageMs: number; idleMs: number; doers: number }>,
): string {
  if (list.length === 0) return "no open sessions";
  const s = (ms: number) => (ms < 1000 ? `${ms}ms` : `${Math.round(ms / 1000)}s`);
  return list
    .map((x) => `${x.id}  ${x.url}  ${x.doers} actions · ${s(x.ageMs)} old · idle ${s(x.idleMs)}`)
    .join("\n");
}

export function renderAct(node: string, action: string, r: ActResult): string {
  if (!r.ok) {
    // A refusal is information: name what blocked it so the agent can adapt
    // rather than retry the same thing.
    return (
      `via: engine · ${r.ms}ms · ${(r.failure ?? "failed").toUpperCase()}\n` +
      `could not ${action} ${node}: ${r.detail ?? "unknown reason"}`
    );
  }
  const s = r.settle;
  const settleNote = s ? ` · settled ${s.ms}ms (${s.reason}, ${s.changes} surface changes)` : "";
  const parts = [`via: engine · ${r.ms}ms · ${action} ${node} ok${settleNote}`];

  if (r.fired) {
    parts.push(
      `fired: ${r.fired.method} ${r.fired.url}${r.fired.status ? ` → ${r.fired.status}` : ""}` +
        (r.learnedReplay ? "  (learned — replayable)" : ""),
    );
  }

  const d = r.diff;
  if (d) {
    if (d.navigated) parts.push(`navigated: ${d.navigated.from} → ${d.navigated.to}`);
    const bits: string[] = [];
    if (d.added.length) bits.push(`+${d.added.length} actions (${d.added.slice(0, 5).join(", ")})`);
    if (d.removed.length) bits.push(`−${d.removed.length} actions`);
    for (const c of d.changed.slice(0, 5)) bits.push(`${c.id}: ${c.was} → ${c.now}`);
    if (d.linksBefore !== d.linksAfter) bits.push(`links ${d.linksBefore} → ${d.linksAfter}`);
    if (bits.length) parts.push(`changed: ${bits.join(" · ")}`);
  }

  if (r.noOp) {
    // Silence would let an agent believe it accomplished something.
    parts.push(
      "note: nothing observably changed — the click landed but the page did not react. " +
        "It may need different input, or the effect may be delayed.",
    );
  }
  return parts.join("\n");
}
