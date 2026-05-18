import { spawn } from "node:child_process";
import { mkdir, writeFile, readFile, unlink, access, open, stat } from "node:fs/promises";
import { connect } from "node:net";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { SOCKET_PATH, PID_FILE, LOG_FILE, VEIL_DIR } from "./daemon-protocol.js";

export function getSocketPath(): string {
  return SOCKET_PATH;
}

export async function isRunning(): Promise<boolean> {
  try {
    await stat(SOCKET_PATH);
  } catch {
    return false;
  }

  return new Promise<boolean>((resolveProbe) => {
    const sock = connect(SOCKET_PATH);
    const timer = setTimeout(() => {
      sock.destroy();
      resolveProbe(false);
    }, 2000);
    sock.once("connect", () => {
      clearTimeout(timer);
      sock.end();
      resolveProbe(true);
    });
    sock.once("error", () => {
      clearTimeout(timer);
      resolveProbe(false);
    });
  });
}

export async function ensureDaemon(): Promise<void> {
  if (await isRunning()) return;
  await startDaemon();
}

export async function startDaemon(): Promise<void> {
  await mkdir(VEIL_DIR, { recursive: true });

  const here = dirname(fileURLToPath(import.meta.url));
  const daemonPath = resolve(here, "daemon-server.js");

  try {
    await access(daemonPath);
  } catch {
    throw new Error(
      `Daemon binary not found at ${daemonPath}. Run "pnpm build" in the project root first.`,
    );
  }

  const logFd = await open(LOG_FILE, "a");
  const child = spawn("node", [daemonPath], {
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
    await unlink(PID_FILE).catch(() => {});
    await unlink(SOCKET_PATH).catch(() => {});
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
  await unlink(SOCKET_PATH).catch(() => {});
}

export async function daemonStatus(): Promise<{ running: boolean; pid: number | null; socket: string }> {
  const running = await isRunning();
  let pid: number | null = null;
  try {
    const raw = await readFile(PID_FILE, "utf-8");
    pid = parseInt(raw.trim(), 10);
  } catch {}
  return { running, pid, socket: SOCKET_PATH };
}
