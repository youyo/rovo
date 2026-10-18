import { generateKeyPairSync } from "node:crypto";
import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

// テスト用の GitHub App の鍵は、実行のたびに生成する（リポジトリに秘密鍵は置かない）
const appKeys = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  publicKeyEncoding: { type: "spki", format: "pem" },
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
});

export default defineConfig({
  plugins: [
    cloudflareTest({
      // 本物のエントリ + 偽の AgentDO（test/support/fake-agent-do.ts）
      main: "./test/unit/worker-entry.ts",
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: {
        // wrangler.jsonc の AGENT_DO は別 Worker（script_name）を指す。Unit では agent を起動しないので、
        // 同じ Worker 内の、台本で制御できる偽の AgentDO に差し替える。
        // wrangler.jsonc の WEB は別 Worker（rovo-web）への service binding。Unit では web を起動しないので、
        // 呼ばれたらエラーにするだけの関数に差し替える。web を使うテストは fake を直接差し込む。
        serviceBindings: {
          WEB: () => new Response("web is not available in unit tests", { status: 500 }),
        },
        durableObjects: { AGENT_DO: { className: "FakeAgentDO", useSQLite: true } },
        // Secret / 設定値のテスト用ダミー（実在の値ではない）
        bindings: {
          GITHUB_APP_CLIENT_ID: "test-client-id",
          GITHUB_APP_CLIENT_SECRET: "test-client-secret",
          ALLOWED_ORG: "acme",
          ALLOWED_TEAM: "core",
          TOKEN_ENC_KEY: "AwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwM=",
          GITHUB_APP_ID: "424242",
          GITHUB_APP_PRIVATE_KEY: appKeys.privateKey,
          // 偽 GitHub が JWT の署名を検証する公開鍵（Unit だけが使う）
          TEST_APP_PUBLIC_KEY: appKeys.publicKey,
        },
      },
    }),
  ],
  test: {
    include: ["test/unit/**/*.test.ts"],
    setupFiles: ["test/unit/setup.ts"],
  },
});
