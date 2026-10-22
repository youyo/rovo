import type { Plugin } from "vite";
import { defineConfig } from "vite";

// 配信は gateway の Worker が /dashboard/* だけ assets に渡す（docs/specs/dashboard.md D11）。
// base を /dashboard/ にすると HTML の参照は /dashboard/assets/... になるが、出力は dist 直下
// （dist/index.html・dist/assets/...）のまま。Worker が /dashboard の接頭辞を剥がして ASSETS.fetch に渡す。

/** 使わない文字体系の分割。ダッシュボードは日本語と英数字だけ（足りない字は system フォントに落ちる）。 */
const SKIPPED_SUBSETS = /-(?:cyrillic|cyrillic-ext|greek|vietnamese)-\d+-/;

/**
 * @fontsource の CSS を整える（書体は SIL OFL。npm の @fontsource から同梱し、外部の CDN は使わない）。
 * - woff2 だけを使う（woff の予備は容量が倍になるので外す。現行のブラウザは woff2 を読める）
 * - 使わない文字体系（キリル・ギリシャ・ベトナム語）の @font-face を外す
 * unicode-range の分割はそのまま残し、ブラウザが使う文字を含む分割だけを読む。
 */
function fontsourceWoff2Only(): Plugin {
  return {
    name: "rovo-fontsource-woff2-only",
    enforce: "pre",
    transform(code, id) {
      if (!/[\\/]@fontsource[\\/][^?]+\.css(?:\?|$)/.test(id)) return null;
      const blocks = code
        .split(/\n\s*\n/)
        .filter((b) => !SKIPPED_SUBSETS.test(b.split("\n")[0] ?? ""));
      const out = blocks
        .join("\n\n")
        .replace(/,\s*url\([^)]*\.woff\)\s*format\(['"]woff['"]\)/g, "");
      return { code: out, map: null };
    },
  };
}

export default defineConfig({
  base: "/dashboard/",
  plugins: [fontsourceWoff2Only()],
  build: {
    outDir: "dist",
    emptyOutDir: true,
    assetsDir: "assets",
    // 書体を data: URI に埋め込まない（CSP は font-src 'self'）
    assetsInlineLimit: 0,
  },
});
