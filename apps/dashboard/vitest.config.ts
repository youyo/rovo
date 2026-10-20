import { defineConfig } from "vitest/config";

// SPA の Unit。コンポーネントは renderToStaticMarkup で試すので DOM は要らないが、
// 後続のマイルストーン（ポーリングのフックなど）で DOM を使うため jsdom にしておく。
export default defineConfig({
  test: { include: ["test/**/*.test.{ts,tsx}"], environment: "jsdom" },
});
