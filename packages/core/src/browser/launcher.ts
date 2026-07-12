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

export interface LaunchOptions {
  headless?: boolean;        // default: true
  userDataDir?: string;      // if provided, skip mkdtemp + skip cleanup
  startUrl?: string;         // default: "about:blank"
}

export async function launchBrowser(options?: LaunchOptions): Promise<BrowserHandle> {
  const headless = options?.headless ?? true;
  const ownedDataDir = !options?.userDataDir;
  const userDataDir = options?.userDataDir ?? await mkdtemp(join(tmpdir(), "veil-"));
  const startUrl = options?.startUrl ?? "about:blank";

  const chromePath = findChromeBinary();
  const args = [
    ...(headless ? ["--headless=new"] : []),
    "--disable-gpu",
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-extensions",
    "--disable-component-extensions-with-background-pages",
    "--disable-background-networking",
    "--disable-default-apps",
    "--disable-sync",
    "--metrics-recording-only",
    // Stealth: avoid automation detection
    "--disable-blink-features=AutomationControlled",
    "--window-size=1920,1080",
    "--user-agent=Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    startUrl,
    `--user-data-dir=${userDataDir}`,
    "--remote-debugging-port=0",
  ];

  const child = spawn(chromePath, args, {
    stdio: ["ignore", "ignore", "pipe"],
  });

  // If we never reach a live DevTools socket, the spawned Chrome and the temp
  // dir must not leak. Reap both on every failure path (timeout, spawn error,
  // early exit) before rejecting.
  const reapOnFailure = async () => {
    try {
      child.kill("SIGKILL");
    } catch {
      /* already gone */
    }
    if (ownedDataDir) {
      await rm(userDataDir, { recursive: true, force: true }).catch(() => {});
    }
  };

  let wsUrl: string;
  try {
    wsUrl = await new Promise<string>((resolve, reject) => {
      let stderr = "";
      let settled = false;
      const finish = (fn: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        child.stderr!.off("data", onData);
        fn();
      };
      const onData = (chunk: Buffer) => {
        stderr += chunk.toString();
        const match = stderr.match(/DevTools listening on (ws:\/\/.+)/);
        if (match) finish(() => resolve(match[1].trim()));
      };
      child.stderr!.on("data", onData);
      child.on("error", (err) => finish(() => reject(err)));
      child.on("exit", (code) => {
        if (!stderr.includes("DevTools listening on")) {
          finish(() => reject(new Error(`Chrome exited with code ${code}\n${stderr}`)));
        }
      });
      const timer = setTimeout(
        () => finish(() => reject(new Error("Chrome launch timed out"))),
        10_000,
      );
    });
  } catch (err) {
    await reapOnFailure();
    throw err;
  }

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
    if (ownedDataDir) {
      await rm(userDataDir, { recursive: true, force: true }).catch(() => {});
    }
  };

  return { wsUrl, port, process: child, close };
}
