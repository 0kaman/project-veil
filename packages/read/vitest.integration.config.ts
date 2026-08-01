import { defineConfig } from "vitest/config";

// Layer 2 — the read path over a real socket, using the real global `fetch`.
// No Chrome, so this never auto-skips. Run with
// `pnpm --filter @veil/read test:integration`.
export default defineConfig({
  test: {
    include: ["integration/**/*.integration.test.ts"],
    testTimeout: 30_000,
    hookTimeout: 30_000,
    fileParallelism: false,
  },
});
