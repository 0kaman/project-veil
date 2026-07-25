/**
 * Config + .env loading. A debug harness fails loud and early on
 * misconfiguration rather than half-starting and confusing the person trying to
 * diagnose something else.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

function findUp(name: string, from: string): string | null {
  let dir = from;
  for (let i = 0; i < 10; i++) {
    const candidate = resolve(dir, name);
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

export function repoRoot(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const marker =
    findUp("pnpm-workspace.yaml", here) ?? findUp("pnpm-workspace.yaml", process.cwd());
  return marker ? dirname(marker) : process.cwd();
}

/** Load .env from the repo root. Real env vars always win. */
export function loadEnv(): void {
  const envPath = resolve(repoRoot(), ".env");
  if (!existsSync(envPath)) return;
  try {
    process.loadEnvFile(envPath);
  } catch {
    /* optional */
  }
}

export interface Config {
  apiKey: string;
  model: string;
  mcpServerPath: string;
  maxSteps: number;
  traceDir: string;
  auto: boolean;
  goal: string | null;
}

export function loadConfig(argv: string[]): Config {
  loadEnv();
  const root = repoRoot();

  const apiKey = process.env.MISTRAL_API_KEY?.trim();
  if (!apiKey) {
    throw new Error(
      `MISTRAL_API_KEY is not set.\nAdd it to ${resolve(root, ".env")} (see .env.example).`,
    );
  }

  const mcpServerPath = resolve(root, "packages/mcp/dist/server.js");
  if (!existsSync(mcpServerPath)) {
    throw new Error(`Veil MCP server not built at ${mcpServerPath}\nRun: pnpm build`);
  }

  const flag = (name: string): string | undefined => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 ? argv[i + 1] : undefined;
  };

  const goalWords = argv.filter((a, i) => {
    if (a.startsWith("--")) return false;
    const prev = argv[i - 1];
    if (prev === "--max-steps" || prev === "--model" || prev === "--prompt-file") return false;
    return true;
  });

  // A long prompt should never go through the terminal at all. Pasting a 3.5KB
  // script into a TTY is the path that silently dropped whole blocks of it.
  const promptFile = flag("prompt-file");
  let filePrompt: string | null = null;
  if (promptFile) {
    // `pnpm play` runs with cwd = packages/playground, so a path the user typed
    // against the repo root would not resolve. Try both, and say so when neither
    // works — a silent miss here costs a whole run.
    const candidates = [resolve(promptFile), resolve(root, promptFile)];
    const found = candidates.find((c) => existsSync(c));
    if (!found) {
      throw new Error(`--prompt-file not found. Looked in:\n  ${candidates.join("\n  ")}`);
    }
    filePrompt = readFileSync(found, "utf8").trim();
    if (!filePrompt) throw new Error(`--prompt-file ${found} is empty`);
  }

  return {
    apiKey,
    model: flag("model") ?? process.env.MISTRAL_MODEL?.trim() ?? "mistral-medium-latest",
    mcpServerPath,
    maxSteps: Number(flag("max-steps") ?? 20),
    traceDir: resolve(root, "traces"),
    auto: argv.includes("--auto"),
    goal: filePrompt ?? (goalWords.length > 0 ? goalWords.join(" ") : null),
  };
}
