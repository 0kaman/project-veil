import { describe, it, expect, afterEach } from "vitest";
import { findChromeBinary, chromeAvailable } from "../browser/launcher.js";

/** Hermetic — the launcher's binary resolution, no Chrome spawned. The render
 * path itself is Layer 2 (integration/, real Chrome). */
describe("findChromeBinary", () => {
  const saved = process.env.CHROME_PATH;
  afterEach(() => {
    if (saved === undefined) delete process.env.CHROME_PATH;
    else process.env.CHROME_PATH = saved;
  });

  it("honours CHROME_PATH when set", () => {
    process.env.CHROME_PATH = "/custom/chrome";
    expect(findChromeBinary()).toBe("/custom/chrome");
  });

  it("falls back to a platform default when unset", () => {
    delete process.env.CHROME_PATH;
    expect(findChromeBinary()).toBeTruthy();
  });
});

describe("chromeAvailable", () => {
  const saved = process.env.CHROME_PATH;
  afterEach(() => {
    if (saved === undefined) delete process.env.CHROME_PATH;
    else process.env.CHROME_PATH = saved;
  });

  it("false when CHROME_PATH points to a missing binary", () => {
    process.env.CHROME_PATH = "/definitely/not/here/chrome";
    expect(chromeAvailable()).toBe(false);
  });
});
