import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
      // ai バインディングは常にリモートに接続する設定で、接続（remote proxy session）が全テスト終了後も
      // 残り「Vite server が終了しない」警告の原因になる。Unit は台本付き fake モデルで実 AI を呼ばないので、リモート接続は不要。
      remoteBindings: false,
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
