import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createServer, type Server } from "node:net";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

let tmpDir: string;
let socketPath: string;
let pidPath: string;

async function setup(): Promise<void> {
  tmpDir = await mkdtemp(join(tmpdir(), "veil-test-"));
  socketPath = join(tmpDir, "daemon.sock");
  pidPath = join(tmpDir, "daemon.pid");
  process.env.VEIL_SOCKET = socketPath;
}

await setup();

const { isRunning, daemonStatus } = await import("../daemon.js");

describe("daemon - isRunning (Unix socket)", () => {
  let server: Server | null = null;

  afterEach(async () => {
    if (server) {
      await new Promise<void>((r) => server!.close(() => r()));
      server = null;
    }
    await rm(socketPath, { force: true }).catch(() => {});
  });

  it("returns false when socket file does not exist", async () => {
    expect(await isRunning()).toBe(false);
  });

  it("returns true when a server is listening on the socket", async () => {
    server = createServer();
    await new Promise<void>((r) => server!.listen(socketPath, () => r()));
    expect(await isRunning()).toBe(true);
  });

  it("returns false when socket file exists but no listener", async () => {
    // Create a stale socket file (simulating a crashed daemon).
    // unix socket connect should fail with ECONNREFUSED.
    await writeFile(socketPath, "");
    expect(await isRunning()).toBe(false);
  });
});

describe("daemon - daemonStatus", () => {
  let server: Server | null = null;

  afterEach(async () => {
    if (server) {
      await new Promise<void>((r) => server!.close(() => r()));
      server = null;
    }
    await rm(socketPath, { force: true }).catch(() => {});
    await rm(pidPath, { force: true }).catch(() => {});
  });

  it("reports running=false when no daemon", async () => {
    const status = await daemonStatus();
    expect(status.running).toBe(false);
    expect(status.socket).toBe(socketPath);
  });

  it("reports running=true with socket path when listening", async () => {
    server = createServer();
    await new Promise<void>((r) => server!.listen(socketPath, () => r()));
    const status = await daemonStatus();
    expect(status.running).toBe(true);
    expect(status.socket).toBe(socketPath);
  });
});
