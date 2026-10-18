import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: {
        bindings: {
          ENVIRONMENT: "test",
          // 32 バイト（0x07 の繰り返し）の base64。Unit 専用の値
          TOKEN_ENC_KEY: "BwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwc=",
        },
      },
    }),
  ],
  test: { include: ["test/unit/**/*.test.ts"] },
});
