#!/usr/bin/env node

import { Veil, serializeCompactText, serializeJGF } from "@veil/sdk";
import type { InteractAction } from "@veil/sdk";

const USAGE = `Usage:
  veil decompose <url> [--timeout N] [--json]
  veil interact <url> <nodeId> <action> [value]

Commands:
  decompose   Decompose a webpage into a behavior graph
  interact    Interact with a node, then output the new graph

Decompose options:
  --timeout N   Navigation timeout in seconds (default: 30)
  --json        Output in JSON Graph Format instead of compact text

Interact actions:
  click         Click on the node
  type <text>   Type text into the node
  clear         Clear the node's value
  select <val>  Select an option by value
  focus         Focus the node
  hover         Hover over the node`;

function parseDecomposeArgs(args: string[]): {
  url: string;
  timeout: number;
  json: boolean;
} {
  if (!args[0] || args[0].startsWith("--")) {
    console.error("Error: URL is required\n");
    console.error(USAGE);
    process.exit(1);
  }

  let url = args[0];
  if (!/^https?:\/\//.test(url)) {
    url = `https://${url}`;
  }

  let timeout = 30;
  let json = false;

  for (let i = 1; i < args.length; i++) {
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

function parseInteractArgs(args: string[]): {
  url: string;
  nodeId: string;
  action: InteractAction;
} {
  if (args.length < 3) {
    console.error("Error: interact requires <url> <nodeId> <action> [value]\n");
    console.error(USAGE);
    process.exit(1);
  }

  let url = args[0];
  if (!/^https?:\/\//.test(url)) {
    url = `https://${url}`;
  }

  const nodeId = args[1];
  const actionName = args[2];

  let action: InteractAction;
  switch (actionName) {
    case "click":
      action = { action: "click" };
      break;
    case "type":
      if (!args[3]) {
        console.error("Error: type action requires a text value\n");
        console.error(USAGE);
        process.exit(1);
      }
      action = { action: "type", text: args[3] };
      break;
    case "clear":
      action = { action: "clear" };
      break;
    case "select":
      if (!args[3]) {
        console.error("Error: select action requires a value\n");
        console.error(USAGE);
        process.exit(1);
      }
      action = { action: "select", value: args[3] };
      break;
    case "focus":
      action = { action: "focus" };
      break;
    case "hover":
      action = { action: "hover" };
      break;
    default:
      console.error(`Unknown action: ${actionName}\n`);
      console.error(USAGE);
      process.exit(1);
  }

  return { url, nodeId, action };
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);

  if (args.length === 0 || args[0] === "--help" || args[0] === "-h") {
    console.log(USAGE);
    process.exit(0);
  }

  const command = args[0];
  const commandArgs = args.slice(1);

  if (command !== "decompose" && command !== "interact") {
    console.error(`Unknown command: ${command}\n`);
    console.error(USAGE);
    process.exit(1);
  }

  const veil = new Veil();

  const cleanup = async () => {
    await veil.close();
    process.exit(0);
  };
  process.on("SIGINT", cleanup);
  process.on("SIGTERM", cleanup);

  try {
    if (command === "decompose") {
      const { url, json } = parseDecomposeArgs(commandArgs);
      const page = await veil.open(url);

      if (json) {
        const graph = await page.getGraph();
        console.log(JSON.stringify(serializeJGF(graph), null, 2));
      } else {
        const graph = await page.getGraph();
        console.log(serializeCompactText(graph));
      }

      page.close();
    } else {
      const { url, nodeId, action } = parseInteractArgs(commandArgs);
      const page = await veil.open(url);

      console.error(`Interacting: ${action.action} on "${nodeId}"...`);
      const newGraph = await page.interact(nodeId, action);
      console.log(serializeCompactText(newGraph));

      page.close();
    }
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
