import { defineConfig } from "vitest/config";

// 本物の git（child_process）を使うテスト。workerd の pool では child_process が使えないので、node の環境で動かす。
// 一時ディレクトリの中だけで動き、Docker・Cloudflare・ネットワークは使わない。
export default defineConfig({
  test: {
    include: ["test/node/**/*.node.test.ts"],
    environment: "node",
    testTimeout: 60_000,
  },
});
