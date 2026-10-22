import { describe, expect, it } from "vitest";
import {
  sanitizeText,
  truncateEnd,
  truncateMiddle,
  truncateStart,
  workspaceRelativePath,
} from "../src";

describe("sanitizeText（制御文字・ANSI・双方向制御の除去）", () => {
  it("ANSI と、改行・タブ以外の C0/C1 制御文字と双方向制御を除く", () => {
    const raw = "a\u001b[31mred\u001b[0m\u0000b\u0007c\u007fd\u0085e\u202ef\u2066g\r\nh\ti";
    expect(sanitizeText(raw)).toBe("aredbcdefg\r\nh\ti");
  });

  it("singleLine なら改行もスペースにする", () => {
    expect(sanitizeText("a\r\nb\nc\td", { singleLine: true })).toBe("a b c d");
  });
});

describe("truncate（UTF-16 の長さで上限を守る。サロゲートペアの途中で切らない）", () => {
  it("上限内ならそのまま", () => {
    expect(truncateEnd("abc", 5)).toBe("abc");
    expect(truncateStart("abc", 5)).toBe("abc");
    expect(truncateMiddle("abc", 5)).toBe("abc");
  });

  it("末尾を切る・先頭を切る・中央を切る。どれも上限（マーカー込み）を超えない", () => {
    expect(truncateEnd("abcdefghij", 5)).toBe("abcd…");
    expect(truncateStart("abcdefghij", 5)).toBe("…ghij");
    const m = truncateMiddle("abcdefghij", 7);
    expect(m.length).toBeLessThanOrEqual(7);
    expect(m.startsWith("abc")).toBe(true);
    expect(m).toBe("abcd…ij");
    expect(m).toContain("…");
  });

  it("絵文字（2 コード単位）を含んでも上限を超えず、孤立サロゲートを作らない", () => {
    const emoji = "😀".repeat(100);
    for (const fn of [truncateEnd, truncateStart, truncateMiddle]) {
      const out = fn(emoji, 11);
      expect(out.length).toBeLessThanOrEqual(11);
      expect(out).not.toMatch(
        /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/,
      );
    }
  });

  it("日本語の切り詰め", () => {
    expect(truncateEnd("あいうえおかきくけこ", 5)).toBe("あいうえ…");
  });
});

describe("workspaceRelativePath（edit の path / command の cwd）", () => {
  const root = "/workspace";
  it("ワークスペースの下の絶対パスと相対パスを、相対パスにする", () => {
    expect(workspaceRelativePath(root, "/workspace/src/a.ts")).toBe("src/a.ts");
    expect(workspaceRelativePath(root, "src/./a.ts")).toBe("src/a.ts");
  });

  it("ワークスペース自身は '.'", () => {
    expect(workspaceRelativePath(root, "/workspace")).toBe(".");
  });

  it.each([
    ["..", "../etc/passwd"],
    ["途中の ..", "a/../../b"],
    ["外の絶対パス", "/etc/passwd"],
    ["NUL", "a\u0000b"],
    ["制御文字", "a\u0007b"],
    ["改行", "a\nb"],
    ["Windows 風", "C:\\x"],
    ["空", ""],
    ["長すぎる", `${"a/".repeat(200)}x`],
  ])("%s は拒否（undefined）", (_name, p) => {
    expect(workspaceRelativePath(root, p)).toBeUndefined();
  });
});
