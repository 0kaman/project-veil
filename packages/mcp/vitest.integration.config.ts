import { defineConfig } from "vitest/config";

// Layer 2: spawns the REAL built server and a REAL browser. Serial, generous
// timeouts, and it needs `dist/` — process lifetime is the thing under test, so
// there is nothing to fake.
export default defineConfig({
  test: {
    include: ["integration/**/*.integration.test.ts"],
    testTimeout: 90_000,
    hookTimeout: 90_000,
    fileParallelism: false,
  },
});
