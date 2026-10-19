import { defineConfig } from "vitest/config";

// LOGS（R2）を外した gateway の E2E。通常の E2E（vitest.e2e.config.ts）と同じ起動で、r2_buckets だけを足さない。
export default defineConfig({
  test: {
    include: ["test/e2e/**/*.nologs.test.ts"],
    fileParallelism: false,
    globalSetup: ["test/e2e/global-setup-nologs.ts"],
    testTimeout: 30_000,
    hookTimeout: 120_000,
  },
});
