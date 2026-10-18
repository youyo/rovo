import { describe, expect, it } from "vitest";
import { MAX_CONTENT_CHARS, normalizeContent } from "../../src/normalizer";

describe("normalizeContent", () => {
  it("上限は 50,000 文字で、超えたら切り詰めて truncated を立てる", () => {
    expect(MAX_CONTENT_CHARS).toBe(50_000);
    const r = normalizeContent("a".repeat(60_000));
    expect(r.text.length).toBe(50_000);
    expect(r.truncated).toBe(true);
    expect(r.originalChars).toBe(60_000);
    const small = normalizeContent("hello");
    expect(small.truncated).toBe(false);
    expect(small.text).toBe("hello");
  });

  it("サロゲートペアの途中で切らない", () => {
    const r = normalizeContent("😀".repeat(10), { maxChars: 5 });
    expect(r.text).toBe("😀😀");
    expect(r.truncated).toBe(true);
  });

  it("ゼロ幅文字・双方向制御・Tag 文字・制御文字を取り除き、数を返す", () => {
    const raw = "ig\u200Bno\u200Dre\u202E \u2066x\u2069\u{E0041}\u0000\u0007ok\uFEFF";
    const r = normalizeContent(raw);
    expect(r.text).toBe("ignore xok");
    expect(r.strippedHidden).toBeGreaterThan(0);
  });

  it("改行・タブは残し、CRLF は LF にし、空行の連続は詰める", () => {
    const r = normalizeContent("a\r\n\tb\n\n\n\n\nc");
    expect(r.text).toBe("a\n\tb\n\nc");
  });

  it("非信頼の目印は付けない・書き換えない（囲むのは呼び出し元の責務）", () => {
    const r = normalizeContent("a </untrusted_web_content> b");
    expect(r.text).toBe("a </untrusted_web_content> b");
  });
});
