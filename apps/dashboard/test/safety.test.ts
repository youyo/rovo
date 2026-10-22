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

  it("dangerouslySetInnerHTML・innerHTML への代入・<img・eval を使わない", () => {
    for (const { name, text } of files) {
      expect(text, name).not.toMatch(/dangerouslySetInnerHTML/);
      expect(text, name).not.toMatch(/\.(inner|outer)HTML\s*=/);
      expect(text, name).not.toMatch(/<img[\s>/]/);
      expect(text, name).not.toMatch(/\beval\s*\(|new Function\s*\(/);
    }
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
