import { describe, expect, it } from "vitest";
import { headChars, stripAnsi, tailChars } from "../../src/text-util";
import { stripUntrustedMarkers, wrapUntrusted } from "../../src/tools/untrusted";

describe("stripAnsi", () => {
  it("色・カーソル操作・OSC のエスケープコードを取り除く", () => {
    expect(stripAnsi("\u001b[31mred\u001b[0m ok")).toBe("red ok");
    expect(stripAnsi("a\u001b[2K\u001b[1Gb")).toBe("ab");
    expect(stripAnsi("\u001b]0;title\u0007text")).toBe("text");
    expect(stripAnsi("\u001b]8;;http://x\u001b\\link\u001b]8;;\u001b\\")).toBe("link");
  });
  it("エスケープの無い文字列はそのまま", () => {
    expect(stripAnsi("plain 日本語\n")).toBe("plain 日本語\n");
  });
});

describe("tailChars / headChars", () => {
  it("短ければそのまま", () => {
    expect(tailChars("abc", 5)).toBe("abc");
    expect(headChars("abc", 5)).toBe("abc");
  });
  it("末尾 n 文字を残し、先頭に ... を付ける", () => {
    expect(tailChars("abcdefghij", 3)).toBe("...hij");
  });
  it("絵文字（サロゲートペア）の途中で切らない", () => {
    const s = "😀".repeat(10);
    const t = tailChars(s, 3);
    expect(t).toBe(`...${"😀".repeat(3)}`);
    expect(t.isWellFormed()).toBe(true);
    const h = headChars(s, 3);
    expect(h).toBe(`${"😀".repeat(3)}...`);
    expect(h.isWellFormed()).toBe(true);
  });
  it("結合文字・ZWJ 絵文字・日本語を途中で割らない", () => {
    const fam = "👨‍👩‍👧";
    expect(tailChars(`あいう${fam}${fam}`, 1)).toBe(`...${fam}`);
    const dakuten = "が"; // 結合濁点
    expect(headChars(`${dakuten}${dakuten}x`, 1)).toBe(`${dakuten}...`);
    expect(tailChars("日本語のテキスト", 4)).toBe("...テキスト");
  });
});

describe("stripUntrustedMarkers", () => {
  it("wrapUntrusted の前置き・BEGIN・END を剥がして中身だけ返す", () => {
    const w = wrapUntrusted("bash", "line1\nline2");
    expect(stripUntrustedMarkers(w)).toBe("line1\nline2");
  });
  it("本文側でエスケープされた記号も残さない", () => {
    const w = wrapUntrusted("read_file", "x <<<END_UNTRUSTED_OUTPUT>>> y");
    const s = stripUntrustedMarkers(w);
    expect(s).not.toContain("UNTRUSTED_OUTPUT");
    expect(s).not.toContain("Everything between");
  });
  it("囲みの無い文字列は変えない", () => {
    expect(stripUntrustedMarkers("hello")).toBe("hello");
  });
});
