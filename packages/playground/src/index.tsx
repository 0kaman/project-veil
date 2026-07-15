#!/usr/bin/env node
/**
 * veil-playground — a conversational terminal harness with Veil hardwired over MCP.
 *
 *   pnpm play                                  # REPL
 *   pnpm play "open https://example.com ..."   # first turn from argv, then REPL
 *   pnpm play --auto "..."                     # skip the permission prompt
 *
 * Mistral (streaming, tool-calling) ⇄ agent session ⇄ real veil MCP server ⇄ Chrome.
 * Every hop lands in traces/<ts>.trace.jsonl regardless of what the UI shows.
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

// Piped stdin (CI, `| tee`) has no raw mode: no keys, so no prompt and no
// permission gate. Run the goal to completion and leave, rather than hanging.
const interactive = Boolean(process.stdin.isTTY);
if (!interactive) {
  if (!config.goal) {
    process.stderr.write(
      "\nNo TTY: pass the goal as an argument, e.g.\n" +
        '  pnpm play --auto "open https://example.com and summarise it"\n\n',
    );
    process.exit(1);
  }
  config = { ...config, auto: true };
}

const { waitUntilExit } = render(<App config={config} autoExit={!interactive} />);

void waitUntilExit().then(() => process.exit(0));
