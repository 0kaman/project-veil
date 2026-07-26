/**
 * What does history pruning actually save?
 *
 * Comparing two LIVE runs cannot answer this: the agent is non-deterministic,
 * so a token difference between runs is mostly a different path taken, not the
 * pruner working. So replay a RECORDED conversation instead — same messages,
 * same order, the only variable is whether the pruner ran. Deterministic, free,
 * and it isolates exactly the effect being claimed.
 *
 *   pnpm --filter @veil/playground bench:prune [trace.jsonl ...]
 *
 * Defaults to every trace with a real task in it.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { pruneHistory, approxTokens } from "../src/prune.js";

const TRACES = resolve(import.meta.dirname, "../../../traces");

/** Rebuild the message list the agent would have held, turn by turn. */
function reconstruct(file: string) {
  const rows = readFileSync(file, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as any);

  const messages: any[] = [{ role: "system", content: "(system prompt)" }];
  const user = rows.find((r) => r.kind === "user");
  if (user) messages.push({ role: "user", content: user.text });

  // Each turn: the assistant's reply, then the results of its tool calls.
  const turns: any[] = [];
  const resultsById = new Map<string, any>();
  for (const r of rows) if (r.kind === "tool.result") resultsById.set(r.id, r);

  for (const r of rows) {
    if (r.kind !== "llm.response") continue;
    const calls = (r.toolCalls ?? []).map((c: any) => ({
      id: c.id,
      function: { name: c.name, arguments: c.args ?? "{}" },
    }));
    turns.push({
      assistant: { role: "assistant", content: r.content ?? null, ...(calls.length && { tool_calls: calls }) },
      tools: (r.toolCalls ?? []).map((c: any) => ({
        role: "tool",
        name: c.name,
        tool_call_id: c.id,
        content: resultsById.get(c.id)?.text ?? "(no result recorded)",
      })),
      billed: r.promptTokens ?? 0,
    });
  }
  return { messages, turns };
}

/** Replay the conversation, billing the context at every turn as the API does. */
function simulate(file: string, prune: boolean) {
  const { messages, turns } = reconstruct(file);
  const history = [...messages];
  let billed = 0;
  let peak = 0;
  for (const t of turns) {
    const sent = prune ? pruneHistory(history) : history;
    const size = approxTokens(sent);
    billed += size;
    peak = Math.max(peak, size);
    history.push(t.assistant, ...t.tools);
  }
  return { billed, peak, turns: turns.length, realBilled: turns.reduce((a: number, t: any) => a + t.billed, 0) };
}

const files = process.argv.slice(2).length
  ? process.argv.slice(2)
  : readdirSync(TRACES)
      .filter((f) => f.endsWith(".trace.jsonl"))
      .map((f) => join(TRACES, f))
      .filter((f) => {
        const s = simulate(f, false);
        return s.turns >= 15; // real tasks only, not smoke pokes
      });

console.log("Replaying recorded conversations. Only the pruner varies.\n");
const w = (n: number) => n.toLocaleString().padStart(11);
console.log("  turns │      no prune │       pruned │      saved │   %   │ peak ctx");
console.log("  ──────┼───────────────┼──────────────┼────────────┼───────┼─────────");
let tOff = 0,
  tOn = 0;
for (const f of files) {
  const off = simulate(f, false);
  const on = simulate(f, true);
  tOff += off.billed;
  tOn += on.billed;
  const pct = off.billed ? ((1 - on.billed / off.billed) * 100).toFixed(1) : "0.0";
  console.log(
    `  ${String(off.turns).padStart(5)} │ ${w(off.billed)} │ ${w(on.billed)} │ ${w(off.billed - on.billed)} │ ${pct.padStart(5)} │ ${String(off.peak).padStart(7)} → ${on.peak}`,
  );
}
console.log("  ──────┴───────────────┴──────────────┴────────────┴───────┴─────────");
const pct = tOff ? ((1 - tOn / tOff) * 100).toFixed(1) : "0.0";
console.log(`  TOTAL   ${w(tOff)}   ${w(tOn)}   ${w(tOff - tOn)}   ${pct.padStart(5)}%`);

// Sanity: the estimate must track what the API really billed, or the
// percentage above is a story about a bad token model rather than about pruning.
const est = files.reduce((a, f) => a + simulate(f, false).billed, 0);
const real = files.reduce((a, f) => a + simulate(f, false).realBilled, 0);
console.log(
  `\n  estimator check: ${est.toLocaleString()} estimated vs ${real.toLocaleString()} actually billed ` +
    `(${((est / real - 1) * 100).toFixed(0)}% off) — a rough count, used only to compare two histories.`,
);
