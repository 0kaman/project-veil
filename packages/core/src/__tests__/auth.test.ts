import { describe, it, expect, vi, beforeEach } from "vitest";
import { extractCookies, injectCookies } from "../browser/auth.js";

function createMockCdp() {
  const listeners = new Map<string, Set<(params: unknown) => void>>();

  return {
    send: vi.fn(async (method: string, _params?: Record<string, unknown>) => {
      if (method === "Network.getAllCookies") {
        return {
          cookies: [
            {
              name: "session_id",
              value: "abc123",
              domain: ".example.com",
              path: "/",
              expires: -1,
              size: 20,
              httpOnly: true,
              secure: true,
              session: true,
              sameSite: "Lax",
            },
            {
              name: "_csrf",
              value: "token456",
              domain: ".example.com",
              path: "/",
              expires: 1800000000,
              size: 15,
              httpOnly: false,
              secure: true,
              session: false,
              sameSite: "Strict",
            },
          ],
        };
      }
      return {};
    }),
    on: vi.fn((event: string, cb: (params: unknown) => void) => {
      if (!listeners.has(event)) listeners.set(event, new Set());
      listeners.get(event)!.add(cb);
    }),
    off: vi.fn((event: string, cb: (params: unknown) => void) => {
      listeners.get(event)?.delete(cb);
    }),
    close: vi.fn(),
    emit(event: string, params: unknown) {
      for (const cb of listeners.get(event) ?? []) {
        cb(params);
      }
    },
  };
}

describe("extractCookies", () => {
  it("should extract all cookies from CDP", async () => {
    const cdp = createMockCdp();
    const cookies = await extractCookies(cdp);

    expect(cdp.send).toHaveBeenCalledWith("Network.getAllCookies");
    expect(cookies).toHaveLength(2);
    expect(cookies[0].name).toBe("session_id");
    expect(cookies[0].httpOnly).toBe(true);
    expect(cookies[1].name).toBe("_csrf");
    expect(cookies[1].sameSite).toBe("Strict");
  });
});

describe("injectCookies", () => {
  it("should clear existing cookies and set new ones", async () => {
    const cdp = createMockCdp();
    const cookies = [
      {
        name: "session_id",
        value: "abc123",
        domain: ".example.com",
        path: "/",
        expires: -1,
        size: 20,
        httpOnly: true,
        secure: true,
        session: true,
        sameSite: "Lax",
      },
      {
        name: "_csrf",
        value: "token456",
        domain: ".example.com",
        path: "/",
        expires: 1800000000,
        size: 15,
        httpOnly: false,
        secure: true,
        session: false,
        sameSite: "Strict",
      },
    ];

    await injectCookies(cdp, cookies);

    expect(cdp.send).toHaveBeenCalledWith("Network.clearBrowserCookies");

    // First cookie — session cookie with expires -1 → undefined
    expect(cdp.send).toHaveBeenCalledWith("Network.setCookie", {
      name: "session_id",
      value: "abc123",
      domain: ".example.com",
      path: "/",
      secure: true,
      httpOnly: true,
      sameSite: "Lax",
      expires: undefined,
    });

    // Second cookie — persistent cookie with expires
    expect(cdp.send).toHaveBeenCalledWith("Network.setCookie", {
      name: "_csrf",
      value: "token456",
      domain: ".example.com",
      path: "/",
      secure: true,
      httpOnly: false,
      sameSite: "Strict",
      expires: 1800000000,
    });
  });

  it("should handle empty cookie array", async () => {
    const cdp = createMockCdp();
    await injectCookies(cdp, []);

    expect(cdp.send).toHaveBeenCalledWith("Network.clearBrowserCookies");
    // Only the clear call, no setCookie calls
    expect(cdp.send).toHaveBeenCalledTimes(1);
  });
});
