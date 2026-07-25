#!/usr/bin/env node
/**
 * veil-playground — an Ink REPL where Mistral drives the real Veil MCP server.
 *
 *   pnpm play                                  # REPL
 *   pnpm play "find the best fusion news"      # first turn from argv, then REPL
 *   pnpm play --auto "…"                       # skip the permission gate
 *   pnpm play --auto --prompt-file smoke.txt   # long prompt, never via the TTY
 *
 * Mistral (streaming, tool-calling) ⇄ agent ⇄ real veil MCP server (stdio) ⇄
 * search + read. Every hop lands in traces/<ts>.trace.jsonl.
 */
import React from "react";
import { render } from "ink";
import { loadConfig } from "./config.js";
import { App } from "./ui/App.js";

let config;
try {
  config = loadConfig(process.argv.slice(2));
} catch (err) {
  process.stderr.write(`\n${err instanceof Error ? err.message : String(err)}\n\n`);
  process.exit(1);
}

// Piped stdin (CI, | tee) has no raw mode: no keys, so no prompt and no gate.
// Run the goal to completion and leave, rather than hanging.
const interactive = Boolean(process.stdin.isTTY);
if (!interactive) {
  if (!config.goal) {
    process.stderr.write('\nNo TTY: pass the goal as an argument, e.g.\n  pnpm play --auto "…"\n\n');
    process.exit(1);
  }
  config = { ...config, auto: true };
}

const { waitUntilExit } = render(<App config={config} autoExit={!interactive} />);
void waitUntilExit().then(() => process.exit(0));
