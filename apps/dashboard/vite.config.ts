import { defineConfig } from "vite";

// 配信は gateway の Worker が /dashboard/* だけ assets に渡す（docs/specs/dashboard.md D11）。
// base を /dashboard/ にすると HTML の参照は /dashboard/assets/... になるが、出力は dist 直下
// （dist/index.html・dist/assets/...）のまま。Worker が /dashboard の接頭辞を剥がして ASSETS.fetch に渡す。
export default defineConfig({
  base: "/dashboard/",
  build: { outDir: "dist", emptyOutDir: true, assetsDir: "assets" },
});
