import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/** ブランドの表記は「Rovo」（画面の文言の製品名）。パッケージ名・URL・識別子は変えない。 */
const html = readFileSync(join(import.meta.dirname, "..", "index.html"), "utf8");

describe("ブランドの表記", () => {
  it("<title> は「Rovo ダッシュボード」", () => {
    expect(/<title>([^<]*)<\/title>/.exec(html)?.[1]).toBe("Rovo ダッシュボード");
  });
});

describe("ロゴ（docs/assets/brand/ の正式なものをコピーして使う）", () => {
  it("ファビコンは同一オリジンの SVG（rovo-mark-small.svg）。外部 URL は使わない", () => {
    const link = /<link\b[^>]*rel="icon"[^>]*>/.exec(html)?.[0] ?? "";
    expect(link).toContain('type="image/svg+xml"');
    expect(/href="([^"]+)"/.exec(link)?.[1]).toBe("/assets/brand/rovo-mark-small.svg");
  });

  it("public の SVG は docs/assets/brand/ の原本と同じ中身", () => {
    for (const f of ["rovo-mark.svg", "rovo-mark-small.svg"]) {
      const copy = readFileSync(
        join(import.meta.dirname, "..", "public", "assets", "brand", f),
        "utf8",
      );
      const orig = readFileSync(
        join(import.meta.dirname, "..", "..", "..", "docs", "assets", "brand", f),
        "utf8",
      );
      expect(copy, f).toBe(orig);
    }
  });
});
