#!/usr/bin/env node

import { Veil } from "@veil/core";

const USAGE = `Usage: veil decompose <url> [--timeout N] [--json]

Decompose a webpage into a behavior graph.

Options:
  --timeout N   Navigation timeout in seconds (default: 30)
  --json        Output in JSON Graph Format instead of compact text`;

function parseArgs(argv: string[]): {
  url: string;
  timeout: number;
  json: boolean;
} {
  const args = argv.slice(2);

  if (args.length === 0 || args[0] === "--help" || args[0] === "-h") {
    console.log(USAGE);
    process.exit(0);
  }

  if (args[0] !== "decompose") {
    console.error(`Unknown command: ${args[0]}\n`);
    console.error(USAGE);
    process.exit(1);
  }

  if (!args[1] || args[1].startsWith("--")) {
    console.error("Error: URL is required\n");
    console.error(USAGE);
    process.exit(1);
  }

  let url = args[1];
  if (!/^https?:\/\//.test(url)) {
    url = `https://${url}`;
  }

  let timeout = 30;
  let json = false;

  for (let i = 2; i < args.length; i++) {
    if (args[i] === "--json") {
      json = true;
    } else if (args[i] === "--timeout" && args[i + 1]) {
      timeout = parseInt(args[i + 1], 10);
      if (isNaN(timeout) || timeout <= 0) {
        console.error("Error: --timeout must be a positive number");
        process.exit(1);
      }
      i++;
    } else {
      console.error(`Unknown option: ${args[i]}\n`);
      console.error(USAGE);
      process.exit(1);
    }
  }

  return { url, timeout, json };
}

async function main(): Promise<void> {
  const { url, timeout, json } = parseArgs(process.argv);

  const veil = new Veil();

  const cleanup = async () => {
    await veil.close();
    process.exit(0);
  };
  process.on("SIGINT", cleanup);
  process.on("SIGTERM", cleanup);

  try {
    const page = await veil.open(url);

    if (json) {
      const result = await page.toJSON();
      console.log(JSON.stringify(result, null, 2));
    } else {
      const text = await page.toCompactText();
      console.log(text);
    }

    page.close();
  } catch (err) {
    console.error(
      `Error: ${err instanceof Error ? err.message : String(err)}`,
    );
    process.exit(1);
  } finally {
    await veil.close();
  }
}

main();
