import { describe, expect, it } from "vitest";
import { TailBuffer } from "../../src/tail-buffer";

const enc = (s: string) => new TextEncoder().encode(s);

describe("TailBuffer", () => {
  it("上限以内ならそのまま返し、truncated は false", () => {
    const b = new TailBuffer(100);
    b.append(enc("hello "));
    b.append(enc("world"));
    expect(b.result()).toEqual({ text: "hello world", truncated: false, totalBytes: 11 });
  });

  it("上限を超えたら末尾 max バイトだけ残し、truncated を立てる", () => {
    const b = new TailBuffer(10);
    for (let i = 0; i < 100; i++) b.append(enc(`${i},`));
    const r = b.result();
    expect(r.truncated).toBe(true);
    expect(r.text.length).toBe(10);
    expect(r.text.endsWith("98,99,")).toBe(true);
    expect(r.totalBytes).toBe(enc(Array.from({ length: 100 }, (_, i) => `${i},`).join("")).length);
  });

  it("1 チャンクが上限より大きくても末尾だけ残す", () => {
    const b = new TailBuffer(4);
    b.append(enc("abcdefghij"));
    expect(b.result().text).toBe("ghij");
  });

  it("途中で切れたマルチバイト文字は先頭から落とす（不正な文字を残さない）", () => {
    const b = new TailBuffer(4);
    b.append(enc("あいう")); // 9 バイト。末尾 4 バイト = 「う」の 3 バイトの前に「い」の最後の 1 バイト
    const r = b.result();
    expect(r.text).toBe("う");
    expect(r.text).not.toContain("�");
  });

  it("メモリは上限の数倍に収まる（巨大な出力を溜め込まない）", () => {
    const b = new TailBuffer(1024);
    const chunk = new Uint8Array(64 * 1024).fill(97);
    for (let i = 0; i < 1000; i++) b.append(chunk);
    expect(b.heldBytes()).toBeLessThanOrEqual(1024 * 2 + 64 * 1024);
    expect(b.result().text.length).toBe(1024);
  });
});
