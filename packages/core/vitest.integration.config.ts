import { defineConfig } from "vitest/config";

// Layer 2 — real Chrome. Kept separate from the hermetic unit suite; run with
// `pnpm --filter @veil/core test:integration`.
export default defineConfig({
  test: {
    include: ["integration/**/*.integration.test.ts"],
    testTimeout: 60_000,
    hookTimeout: 60_000,
    fileParallelism: false,
  },
});
