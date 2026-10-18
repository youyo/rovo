import { defineConfig } from "vitest/config";

// 偽 GitHub サーバー自体のテスト（Node 環境）。Worker 本体を起動しない。
export default defineConfig({
  test: {
    include: ["test/fake-github/**/*.test.ts"],
    environment: "node",
    testTimeout: 15_000,
  },
});
