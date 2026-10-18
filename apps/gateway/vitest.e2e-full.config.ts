import { defineConfig } from "vitest/config";

// Gateway + Agent + 実コンテナ（Docker 必須）の通しの E2E。1 回の wrangler dev を全シナリオで使う。
export default defineConfig({
  test: {
    include: ["test/full/**/*.e2e.test.ts"],
    fileParallelism: false,
    testTimeout: 360_000,
    hookTimeout: 600_000,
  },
});
