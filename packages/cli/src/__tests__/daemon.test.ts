import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// We need to mock fs/promises for PID file reads and mock fetch for health checks.
// Import the module under test after setting up mocks.

vi.mock("node:fs/promises", async (importOriginal) => {
  const orig = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...orig,
    readFile: vi.fn(),
  };
});

import { readFile } from "node:fs/promises";
const readFileMock = vi.mocked(readFile);

describe("daemon - isRunning", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns true when health endpoint responds 200", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ status: "ok" }), { status: 200 }),
    );

    const { isRunning } = await import("../daemon.js");
    const result = await isRunning();
    expect(result).toBe(true);
  });

  it("returns false when fetch throws (connection refused)", async () => {
    fetchMock.mockRejectedValueOnce(new Error("fetch failed"));

    const { isRunning } = await import("../daemon.js");
    const result = await isRunning();
    expect(result).toBe(false);
  });

  it("returns false when health endpoint returns non-200", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response("Service Unavailable", { status: 503 }),
    );

    const { isRunning } = await import("../daemon.js");
    const result = await isRunning();
    expect(result).toBe(false);
  });
});

describe("daemon - daemonStatus", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    vi.resetModules();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns running: true with pid and port when running with PID file", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ status: "ok" }), { status: 200 }),
    );
    readFileMock.mockResolvedValueOnce("12345\n");

    const { daemonStatus } = await import("../daemon.js");
    const status = await daemonStatus();

    expect(status.running).toBe(true);
    expect(status.pid).toBe(12345);
    expect(status.port).toBe(3100);
  });

  it("returns running: false when not running", async () => {
    fetchMock.mockRejectedValueOnce(new Error("ECONNREFUSED"));
    readFileMock.mockRejectedValueOnce(new Error("ENOENT"));

    const { daemonStatus } = await import("../daemon.js");
    const status = await daemonStatus();

    expect(status.running).toBe(false);
    expect(status.pid).toBeNull();
    expect(status.port).toBe(3100);
  });

  it("returns running: false with pid when process died but PID file exists", async () => {
    fetchMock.mockRejectedValueOnce(new Error("ECONNREFUSED"));
    readFileMock.mockResolvedValueOnce("99999\n");

    const { daemonStatus } = await import("../daemon.js");
    const status = await daemonStatus();

    expect(status.running).toBe(false);
    expect(status.pid).toBe(99999);
    expect(status.port).toBe(3100);
  });
});

describe("daemon - getBaseUrl", () => {
  it("returns the expected base URL", async () => {
    const { getBaseUrl, VEIL_PORT, VEIL_HOST } = await import("../daemon.js");
    const url = getBaseUrl();
    expect(url).toBe(`http://${VEIL_HOST}:${VEIL_PORT}`);
    expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
  });
});
