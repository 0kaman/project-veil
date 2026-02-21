import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface BrowserHandle {
  wsUrl: string;
  port: number;
  process: ChildProcess;
  close(): Promise<void>;
}

function findChromeBinary(): string {
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH;
  if (process.platform === "darwin") {
    return "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
  }
  return "google-chrome";
}

export async function launchBrowser(): Promise<BrowserHandle> {
  const userDataDir = await mkdtemp(join(tmpdir(), "veil-"));

  const chromePath = findChromeBinary();
  const args = [
    "--headless=new",
    "--disable-gpu",
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-extensions",
    "--disable-component-extensions-with-background-pages",
    "--disable-background-networking",
    "--disable-default-apps",
    "--disable-sync",
    "--metrics-recording-only",
    "about:blank",
    `--user-data-dir=${userDataDir}`,
    "--remote-debugging-port=0",
  ];

  const child = spawn(chromePath, args, {
    stdio: ["ignore", "ignore", "pipe"],
  });

  const wsUrl = await new Promise<string>((resolve, reject) => {
    let stderr = "";
    const onData = (chunk: Buffer) => {
      stderr += chunk.toString();
      const match = stderr.match(/DevTools listening on (ws:\/\/.+)/);
      if (match) {
        child.stderr!.off("data", onData);
        resolve(match[1]);
      }
    };
    child.stderr!.on("data", onData);
    child.on("error", reject);
    child.on("exit", (code) => {
      if (!stderr.includes("DevTools listening on")) {
        reject(new Error(`Chrome exited with code ${code}\n${stderr}`));
      }
    });

    setTimeout(() => reject(new Error("Chrome launch timed out")), 10_000);
  });

  const portMatch = wsUrl.match(/:(\d+)\//);
  const port = portMatch ? parseInt(portMatch[1], 10) : 0;

  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    child.kill("SIGTERM");
    await new Promise<void>((resolve) => {
      child.on("exit", resolve);
      setTimeout(() => {
        child.kill("SIGKILL");
        resolve();
      }, 3_000);
    });
    await rm(userDataDir, { recursive: true, force: true }).catch(() => {});
  };

  return { wsUrl, port, process: child, close };
}
