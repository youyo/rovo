import { defineConfig } from "vitest/config";

// wrangler dev + Docker（実コンテナ）を使う E2E。ネットワークは偽サーバー（test/support/fake-upstream.ts）だけを使う。
export default defineConfig({
  test: {
    include: ["test/e2e/**/*.e2e.test.ts"],
    fileParallelism: false,
    testTimeout: 120_000,
    hookTimeout: 400_000,
  },
});
