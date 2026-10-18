import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
      // Unit は fake だけを使い、実アカウントの AI は呼ばない。リモート接続（remote proxy session）は不要。
      remoteBindings: false,
      miniflare: {
        bindings: { ENVIRONMENT: "test" },
      },
    }),
  ],
  test: { include: ["test/unit/**/*.test.ts"] },
});
