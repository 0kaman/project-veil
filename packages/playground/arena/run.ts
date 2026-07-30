/**
 * The arena — Veil vs PinchTab, same model, same loop, same tasks.
 *
 * Design notes, because the methodology is the result:
 *
 *  · ONE agent loop drives both. The only variable is which stdio MCP server it
 *    is pointed at, so a difference in tokens or success is a difference in the
 *    tool surface rather than in the harness.
 *  · RUNS ARE INTERLEAVED (task→contender→repeat). A bad network minute or a
 *    slow model then lands on both contenders, not on whichever went second.
 *  · N runs per cell, reported as median and spread. One LLM run proves nothing:
 *    the fare task took seven attempts for one success. Any gap smaller than the
 *    spread is reported as no result.
 *  · Success comes from the task's CHECKER, never the agent's self-report.
 *  · The tool-schema cost is measured separately. PinchTab ships 38 tools to
 *    Veil's 8, and every schema is re-sent on every request — that is a real,
 *    unavoidable token cost and it belongs in the table rather than in a
 *    footnote.
 *
 * Usage:  pnpm --filter @veil/playground arena [--runs 5] [--tasks form,spa] [--budget 15000000]
 */
import { writeFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { Tracer } from "../src/trace.js";
import { VeilMcp } from "../src/mcp.js";
import { Mistral } from "../src/mistral.js";
import { AgentSession, type SessionDeps } from "../src/agent.js";
import { TASKS, type Task } from "./tasks.js";

interface Contender {
  name: string;
  spawn: { command: string; args: string[] };
}

const CONTENDERS: Contender[] = [
  {
    name: "veil",
    spawn: {
      command: "docker",
      args: ["exec", "-i", "arena-veil", "node", "/app/packages/mcp/dist/server.js"],
    },
  },
  {
    name: "pinchtab",
    spawn: { command: "docker", args: ["exec", "-i", "arena-pinchtab", "pinchtab", "mcp"] },
  },
];

interface RunResult {
  contender: string;
  task: string;
  run: number;
  ok: boolean;
  ms: number;
  promptTokens: number;
  completionTokens: number;
  llmCalls: number;
  toolCalls: number;
  schemaTokens: number;
  answer: string;
  error?: string;
}

const arg = (name: string, d: string): string => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1]! : d;
};

const RUNS = Number(arg("runs", "5"));
const BUDGET = Number(arg("budget", "15000000"));
const ONLY = arg("tasks", "").split(",").filter(Boolean);
const OUT = resolve(import.meta.dirname, "../../../traces/arena");

/** Roughly what the tool schemas cost on EVERY request. 4 chars ≈ 1 token. */
const schemaCost = (tools: Array<{ name: string; description: string; parameters: unknown }>) =>
  Math.ceil(
    tools.reduce(
      (n, t) => n + t.name.length + t.description.length + JSON.stringify(t.parameters).length,
      0,
    ) / 4,
  );

async function runOnce(c: Contender, task: Task, run: number, apiKey: string): Promise<RunResult> {
  const tracer = new Tracer(OUT);
  const mcp = new VeilMcp(c.spawn, tracer);
  const base: RunResult = {
    contender: c.name,
    task: task.id,
    run,
    ok: false,
    ms: 0,
    promptTokens: 0,
    completionTokens: 0,
    llmCalls: 0,
    toolCalls: 0,
    schemaTokens: 0,
    answer: "",
  };

  let answer = "";
  let llmCalls = 0;
  let toolCalls = 0;
  let promptTokens = 0;
  let completionTokens = 0;

  tracer.subscribe((e) => {
    const ev = e as unknown as Record<string, unknown>;
    if (ev.kind === "llm.response") {
      llmCalls++;
      promptTokens += Number(ev.promptTokens ?? 0);
      completionTokens += Number(ev.completionTokens ?? 0);
    }
    if (ev.kind === "tool.call") toolCalls++;
  });

  const t0 = Date.now();
  try {
    const tools = await mcp.connect();
    base.schemaTokens = schemaCost(tools);

    const deps: SessionDeps = {
      tracer,
      mcp,
      llm: new Mistral(apiKey, process.env.MISTRAL_MODEL ?? "mistral-medium-latest", tracer),
      gate: async () => "go",
      ui: {
        textDelta: () => {},
        assistantDone: (t: string) => {
          if (t.trim()) answer = t;
        },
        toolStart: () => {},
        toolEnd: () => {},
        note: () => {},
        error: () => {},
      },
      maxSteps: task.maxSteps,
      prune: true,
    };
    await new AgentSession(deps).send(task.prompt);
  } catch (err) {
    base.error = err instanceof Error ? err.message : String(err);
  } finally {
    await mcp.close().catch(() => {});
    tracer.close();
  }

  return {
    ...base,
    ms: Date.now() - t0,
    ok: task.check(answer),
    answer: answer.slice(0, 400),
    llmCalls,
    toolCalls,
    promptTokens,
    completionTokens,
  };
}

const median = (xs: number[]): number =>
  xs.length ? [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]! : 0;
const spread = (xs: number[]): number => (xs.length < 2 ? 0 : Math.max(...xs) - Math.min(...xs));

async function main(): Promise<void> {
  const apiKey = (process.env.MISTRAL_API_KEY ?? "").trim();
  if (!apiKey) {
    process.stderr.write("\nMISTRAL_API_KEY is not set — add it to .env\n\n");
    process.exit(1);
  }
  mkdirSync(OUT, { recursive: true });
  const tasks = ONLY.length ? TASKS.filter((t) => ONLY.includes(t.id)) : TASKS;

  process.stdout.write(
    `\n  ARENA · ${tasks.length} tasks × ${RUNS} runs × ${CONTENDERS.length} contenders` +
      `\n  budget ${BUDGET.toLocaleString()} prompt tokens\n\n`,
  );

  const results: RunResult[] = [];
  let spent = 0;

  // Interleaved: every contender sees the same conditions for a given task+run.
  outer: for (let run = 1; run <= RUNS; run++) {
    for (const task of tasks) {
      for (const c of CONTENDERS) {
        if (spent >= BUDGET) {
          process.stdout.write(`  ! budget reached (${spent.toLocaleString()}) — stopping\n`);
          break outer;
        }
        const r = await runOnce(c, task, run, apiKey);
        spent += r.promptTokens;
        results.push(r);
        process.stdout.write(
          `  ${r.ok ? "PASS" : "fail"}  ${c.name.padEnd(9)} ${task.id.padEnd(9)} run${run}  ` +
            `${String(r.ms).padStart(6)}ms  ${r.promptTokens.toLocaleString().padStart(9)} tok` +
            `${r.error ? `  [${r.error.slice(0, 48)}]` : ""}\n`,
        );
        writeFileSync(resolve(OUT, "results.json"), JSON.stringify(results, null, 2));
      }
    }
  }

  // ── report ───────────────────────────────────────────────────────────────
  process.stdout.write("\n  ── by task ──\n");
  process.stdout.write(
    "  task      probes                          veil                pinchtab            expected\n",
  );
  for (const t of tasks) {
    const cell = (name: string) => {
      const rs = results.filter((r) => r.task === t.id && r.contender === name);
      if (!rs.length) return "—".padEnd(19);
      const pass = rs.filter((r) => r.ok).length;
      return `${pass}/${rs.length} ${median(rs.map((r) => r.promptTokens)).toLocaleString()}tok`.padEnd(19);
    };
    process.stdout.write(
      `  ${t.id.padEnd(9)} ${t.probes.slice(0, 30).padEnd(31)} ${cell("veil")} ${cell("pinchtab")} ${t.veilExpected}\n`,
    );
  }

  process.stdout.write("\n  ── totals ──\n");
  for (const c of CONTENDERS) {
    const rs = results.filter((r) => r.contender === c.name);
    if (!rs.length) continue;
    const toks = rs.map((r) => r.promptTokens);
    process.stdout.write(
      `  ${c.name.padEnd(9)} pass ${rs.filter((r) => r.ok).length}/${rs.length}` +
        `  · median ${median(toks).toLocaleString()} tok (spread ${spread(toks).toLocaleString()})` +
        `  · median ${median(rs.map((r) => r.ms)).toLocaleString()}ms` +
        `  · schema ${median(rs.map((r) => r.schemaTokens)).toLocaleString()} tok/request\n`,
    );
  }
  process.stdout.write(`\n  total prompt tokens spent: ${spent.toLocaleString()}\n`);
  process.stdout.write(`  raw results: ${resolve(OUT, "results.json")}\n\n`);
}

void main();
