import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const SRC = join(import.meta.dirname, "..", "src");
const files = readdirSync(SRC, { recursive: true, encoding: "utf8" })
  .filter((f) => /\.(ts|tsx)$/.test(f))
  .map((f) => ({ name: f, text: readFileSync(join(SRC, f), "utf8") }));

describe("ソースの禁止事項（D14）", () => {
  it("src に画面のコードがある", () => {
    expect(files.length).toBeGreaterThan(5);
  });

  // <img の例外は、固定の src（同梱のロゴの SVG）の img 1 つだけを持つファイルに限る。ほかのファイル・ほかの src は認めない
  const LOGO_FILES = ["header.tsx", "login-view.tsx"];

  it("dangerouslySetInnerHTML・innerHTML への代入・<img・eval を使わない（<img は header.tsx と login-view.tsx のロゴ 1 つずつだけ。同梱の固定の SVG）", () => {
    for (const { name, text } of files) {
      expect(text, name).not.toMatch(/dangerouslySetInnerHTML/);
      expect(text, name).not.toMatch(/\.(inner|outer)HTML\s*=/);
      if (LOGO_FILES.includes(name)) {
        // 子エージェント由来の値が入らないよう、src は同梱の SVG の固定の文字列だけ
        const imgs = [...text.matchAll(/<img\b[^>]*>/g)].map((m) => m[0]);
        expect(imgs, name).toHaveLength(1);
        expect(imgs[0], name).toMatch(/src="\/dashboard\/assets\/brand\/rovo-mark\.svg"/);
        expect(imgs[0], name).not.toMatch(/src=\{/);
        expect(imgs[0], name).toMatch(/className="brand-mark"/);
      } else {
        expect(text, name).not.toMatch(/<img[\s>/]/);
      }
      expect(text, name).not.toMatch(/\beval\s*\(|new Function\s*\(/);
    }
    // 例外のファイルが実際にある（検査が空振りしない）
    for (const f of LOGO_FILES)
      expect(
        files.some((x) => x.name === f),
        f,
      ).toBe(true);
  });

  it("契約のランタイム（zod）を画面に取り込まない（型だけ import type）", () => {
    for (const { name, text } of files) {
      for (const m of text.matchAll(
        /^import\s+(?!type\b)[^;]*from\s+"@rovo\/dashboard-contract[^"]*"/gm,
      )) {
        throw new Error(`${name}: 型以外の import: ${m[0]}`);
      }
    }
  });

  it("外部ホストの URL を書かない（GitHub の PR の正規表現・Cloudflare のトップへのリンク 1 つ・コメントを除く）", () => {
    for (const { name, text } of files) {
      const code = text
        .split("\n")
        .filter((l) => !l.trim().startsWith("//") && !l.trim().startsWith("*"))
        .join("\n");
      expect(code, name).not.toMatch(/https?:\/\/(?!github\\\.com|dash\.cloudflare\.com\/")/);
    }
  });
});
