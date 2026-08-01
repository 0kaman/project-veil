/**
 * Layer 2 — the server must die with its client, and take Chrome with it.
 *
 * A hermetic test cannot catch this. The defect is entirely about REAL process
 * lifetimes: a child spawned with a pipe, that pipe closing without a signal,
 * and whether a browser process tree is still resident afterwards. Every part
 * of that is the operating system's behaviour, not ours.
 *
 * What it exists to stop, measured in the arena on 2026-08-01: the MCP server
 * reaped its browsers on SIGINT/SIGTERM but not on stdin EOF. `docker exec -i`
 * drops its pipe WITHOUT sending a signal, so every benchmark run left a node
 * process alive holding a Chrome tree — 80 runs, 462 Chromium processes, 7.1 GiB
 * of a 7.7 GiB container. Chrome then could not start, and three tasks failed
 * with "browser launch timed out" and were very nearly written down as
 * capability failures.
 */
import { describe, it, expect } from "vitest";
import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { chromeAvailable } from "@veil/core";

const suite = chromeAvailable() ? describe : describe.skip;
const SERVER = resolve(import.meta.dirname, "../dist/server.js");

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Is this pid still alive? signal 0 tests existence without delivering one. */
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Send one MCP request and wait for anything back, so the server is warm. */
function rpc(child: ReturnType<typeof spawn>, msg: unknown): Promise<void> {
  return new Promise((done) => {
    const onData = () => {
      child.stdout?.off("data", onData);
      done();
    };
    child.stdout?.on("data", onData);
    child.stdin?.write(JSON.stringify(msg) + "\n");
    setTimeout(done, 15_000); // never hang the suite on a silent server
  });
}

suite("the stdio server dies with its client (Layer 2)", () => {
  it("exits on stdin EOF WHILE HOLDING A BROWSER, with no signal sent", async () => {
    // The browser is not incidental — it is the whole test. Without an open
    // session nothing holds the event loop, so the process exits on stdin EOF
    // whether or not the fix is present, and the test passes for a reason that
    // has nothing to do with the defect. Verified: the first cut of this test
    // was green against the unfixed server.
    const child = spawn(process.execPath, [SERVER], { stdio: ["pipe", "pipe", "pipe"] });
    const pid = child.pid!;
    expect(pid).toBeGreaterThan(0);

    await rpc(child, {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "lifecycle-test", version: "0" },
      },
    });
    await rpc(child, {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "veil_open", arguments: { url: "about:blank" } },
    });

    // Close stdin and send NOTHING else. This is the exact shape of a client
    // going away: no SIGTERM, no SIGINT, just EOF on the transport.
    child.stdin!.end();

    const exited = await new Promise<boolean>((done) => {
      const t = setTimeout(() => done(false), 20_000);
      child.on("exit", () => {
        clearTimeout(t);
        done(true);
      });
    });

    if (!exited) child.kill("SIGKILL"); // don't leak from the test itself
    expect(exited).toBe(true);
    await sleep(500);
    expect(alive(pid)).toBe(false);
  }, 60_000);

  it("leaves no Chromium behind after driving a real page", async () => {
    // The half that actually costs memory: a server that exits without reaping
    // is no better than one that never exits, because Chrome is a child that
    // outlives it. Counting the delta rather than an absolute, so a browser the
    // developer happens to have open does not fail the test.
    const before = await chromeCount();

    const child = spawn(process.execPath, [SERVER], { stdio: ["pipe", "pipe", "pipe"] });
    await rpc(child, {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "t", version: "0" } },
    });
    // about:blank is enough — the point is that a browser was STARTED.
    await rpc(child, {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "veil_open", arguments: { url: "about:blank" } },
    });

    const during = await chromeCount();
    child.stdin!.end();
    await new Promise<void>((done) => {
      const t = setTimeout(() => done(), 20_000);
      child.on("exit", () => {
        clearTimeout(t);
        done();
      });
    });
    await sleep(2500); // Chrome's tree takes a moment to fully go

    const after = await chromeCount();
    // Only meaningful if a browser actually started; otherwise this asserts
    // nothing and should say so rather than pass quietly.
    expect(during).toBeGreaterThan(before);
    expect(after).toBeLessThanOrEqual(before);
  }, 90_000);
});

/** How many Chrome/Chromium processes exist right now. */
async function chromeCount(): Promise<number> {
  const { execFile } = await import("node:child_process");
  return new Promise((done) => {
    execFile("/bin/sh", ["-lc", "ps -e -o comm= | grep -ciE 'chrom' || true"], (_e, out) => {
      done(Number(String(out).trim()) || 0);
    });
  });
}
