import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/e2e/**/*.e2e.test.ts"],
    // 偽 GitHub の状態は全ファイルで共有するので、ファイルは直列に実行する
    fileParallelism: false,
    globalSetup: ["test/e2e/global-setup.ts"],
    testTimeout: 30_000,
    hookTimeout: 120_000,
  },
});
