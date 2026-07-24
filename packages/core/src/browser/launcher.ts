/**
 * Spawn headless Chrome and hand back its DevTools socket.
 *
 * Reaps the process AND the temp profile dir on EVERY failure path, not just
 * success — a launch that never reached a live socket must not leak a Chrome or
 * a temp dir.
 *
 * Two deliberate changes from v1, from what we measured:
 *   - No `--disable-gpu`. It removed WebGL entirely, which no real Mac Chrome
 *     does — a loud bot tell, and new headless doesn't need the flag.
 *   - No hardcoded stale User-Agent. v1 claimed Chrome/131 on a 150 binary,
 *     while Sec-CH-UA (which --user-agent can't override) reported the real 150
 *     — a self-contradiction no real browser produces. We let Chrome send its
 *     own UA and only strip the "Headless" token (see stripHeadless in page.ts).
 *     Real fingerprint hardening remains out of scope until a target needs it.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { existsSync } from "node:fs";

export interface BrowserHandle {
  wsUrl: string;
  port: number;
  process: ChildProcess;
  close(): Promise<void>;
}

export function findChromeBinary(): string {
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH;
  if (process.platform === "darwin") {
    return "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
  }
  return "google-chrome";
}

/** True when a Chrome binary is present — lets Layer-2 tests auto-skip. */
export function chromeAvailable(): boolean {
  const p = findChromeBinary();
  // A bare "google-chrome" (PATH lookup) can't be existsSync-checked; assume yes.
  return p.includes("/") ? existsSync(p) : true;
}

export interface LaunchOptions {
  headless?: boolean;
  userDataDir?: string;
}

export async function launchBrowser(options?: LaunchOptions): Promise<BrowserHandle> {
  const headless = options?.headless ?? true;
  const ownedDataDir = !options?.userDataDir;
  const userDataDir = options?.userDataDir ?? (await mkdtemp(join(tmpdir(), "veil-")));

  const args = [
    ...(headless ? ["--headless=new"] : []),
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-extensions",
    "--disable-component-extensions-with-background-pages",
    "--disable-background-networking",
    "--disable-default-apps",
    "--disable-sync",
    "--metrics-recording-only",
    "--disable-blink-features=AutomationControlled",
    "--window-size=1920,1080",
    "about:blank",
    `--user-data-dir=${userDataDir}`,
    "--remote-debugging-port=0",
  ];

  const child = spawn(findChromeBinary(), args, { stdio: ["ignore", "ignore", "pipe"] });

  const reapOnFailure = async () => {
    try {
      child.kill("SIGKILL");
    } catch {
      /* already gone */
    }
    if (ownedDataDir) await rm(userDataDir, { recursive: true, force: true }).catch(() => {});
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
      const timer = setTimeout(() => finish(() => reject(new Error("Chrome launch timed out"))), 10_000);
    });
  } catch (err) {
    await reapOnFailure();
    throw err;
  }

  const port = parseInt(wsUrl.match(/:(\d+)\//)?.[1] ?? "0", 10);

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
    if (ownedDataDir) await rm(userDataDir, { recursive: true, force: true }).catch(() => {});
  };

  return { wsUrl, port, process: child, close };
}
