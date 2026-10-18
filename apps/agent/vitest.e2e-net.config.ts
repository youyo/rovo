import { defineConfig } from "vitest/config";

// 実ネットワーク（registry.npmjs.org / github.com の公開リポジトリの匿名 clone）に出る E2E。
// CI で不安定になりうるため `test` には含めず、`mise run test:e2e:net` で別に実行する。
export default defineConfig({
  test: {
    include: ["test/e2e-net/**/*.e2e-net.test.ts"],
    fileParallelism: false,
    testTimeout: 180_000,
    hookTimeout: 400_000,
  },
});
