import { spawn } from "node:child_process";
import { mkdir, writeFile, readFile, unlink, access, open } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";

export const VEIL_PORT = Number(process.env.VEIL_PORT) || 3100;
export const VEIL_HOST = "127.0.0.1";
export const BASE_URL = `http://${VEIL_HOST}:${VEIL_PORT}`;

const VEIL_DIR = join(homedir(), ".veil");
const PID_FILE = join(VEIL_DIR, "daemon.pid");
const LOG_FILE = join(VEIL_DIR, "daemon.log");

export function getBaseUrl(): string {
  return BASE_URL;
}

export async function isRunning(): Promise<boolean> {
  try {
    const res = await fetch(`${BASE_URL}/health`, { signal: AbortSignal.timeout(2000) });
    return res.status === 200;
  } catch {
    return false;
  }
}

export async function ensureDaemon(): Promise<void> {
  if (await isRunning()) return;
  await startDaemon();
}

export async function startDaemon(): Promise<void> {
  await mkdir(VEIL_DIR, { recursive: true });

  const serverPath = new URL("../../server/dist/index.js", import.meta.url).pathname;
  try {
    await access(serverPath);
  } catch {
    throw new Error(
      `Server binary not found at ${serverPath}. Run "pnpm build" in the project root first.`,
    );
  }

  const logFd = await open(LOG_FILE, "a");
  const child = spawn("node", [serverPath], {
    detached: true,
    stdio: ["ignore", logFd.fd, logFd.fd],
    env: process.env,
  });

  child.unref();

  if (child.pid) {
    await writeFile(PID_FILE, String(child.pid));
  }

  await logFd.close();
  await waitForReady(5000);
}

async function waitForReady(timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await isRunning()) return;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`Daemon failed to start within ${timeoutMs / 1000}s. Check ${LOG_FILE}`);
}

export async function stopDaemon(): Promise<void> {
  let pid: number;
  try {
    const raw = await readFile(PID_FILE, "utf-8");
    pid = parseInt(raw.trim(), 10);
  } catch {
    throw new Error("No PID file found. Is the daemon running?");
  }

  try {
    process.kill(pid, "SIGTERM");
  } catch {
    // Process already dead
    await unlink(PID_FILE).catch(() => {});
    return;
  }

  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    if (!(await isRunning())) break;
    await new Promise((r) => setTimeout(r, 200));
  }

  if (await isRunning()) {
    try { process.kill(pid, "SIGKILL"); } catch {}
  }

  await unlink(PID_FILE).catch(() => {});
}

export async function daemonStatus(): Promise<{ running: boolean; pid: number | null; port: number }> {
  const running = await isRunning();
  let pid: number | null = null;
  try {
    const raw = await readFile(PID_FILE, "utf-8");
    pid = parseInt(raw.trim(), 10);
  } catch {}
  return { running, pid, port: VEIL_PORT };
}
