import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: {
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
