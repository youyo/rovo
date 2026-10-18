import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest({
      // 本物のエントリ + 偽の AgentDO（test/support/fake-agent-do.ts）
      main: "./test/unit/worker-entry.ts",
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: {
        // wrangler.jsonc の AGENT_DO は別 Worker（script_name）を指す。Unit では agent を起動しないので、
        // 同じ Worker 内の、台本で制御できる偽の AgentDO に差し替える。
        durableObjects: { AGENT_DO: { className: "FakeAgentDO", useSQLite: true } },
        // Secret / 設定値のテスト用ダミー（実在の値ではない）
        bindings: {
          GITHUB_APP_CLIENT_ID: "test-client-id",
          GITHUB_APP_CLIENT_SECRET: "test-client-secret",
          ALLOWED_ORG: "acme",
          ALLOWED_TEAM: "core",
          TOKEN_ENC_KEY: "AwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwM=",
        },
      },
    }),
  ],
  test: {
    include: ["test/unit/**/*.test.ts"],
  },
});
