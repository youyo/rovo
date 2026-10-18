import { describe, expect, it } from "vitest";
import { decryptString, encryptString, importEncryptionKey } from "../../../src/github/crypto";

const KEY_B64 = btoa(String.fromCharCode(...new Uint8Array(32).fill(7)));

describe("crypto", () => {
  it("暗号化して復号できる。暗号文に平文は含まれない", async () => {
    const key = await importEncryptionKey(KEY_B64);
    const enc = await encryptString(key, "ghu_secret_token", "access");
    expect(enc).not.toContain("ghu_secret_token");
    expect(await decryptString(key, enc, "access")).toBe("ghu_secret_token");
  });

  it("同じ平文でも毎回違う暗号文になる（IV がランダム）", async () => {
    const key = await importEncryptionKey(KEY_B64);
    expect(await encryptString(key, "x", "a")).not.toBe(await encryptString(key, "x", "a"));
  });

  it("用途（AAD）が違うと復号できない", async () => {
    const key = await importEncryptionKey(KEY_B64);
    const enc = await encryptString(key, "x", "access");
    await expect(decryptString(key, enc, "refresh")).rejects.toThrow();
  });

  it("別の鍵では復号できない", async () => {
    const key = await importEncryptionKey(KEY_B64);
    const other = await importEncryptionKey(
      btoa(String.fromCharCode(...new Uint8Array(32).fill(9))),
    );
    const enc = await encryptString(key, "x", "a");
    await expect(decryptString(other, enc, "a")).rejects.toThrow();
  });

  it("鍵が 32 バイトの base64 でなければエラー", async () => {
    await expect(importEncryptionKey(btoa("short"))).rejects.toThrow(/32/);
    await expect(importEncryptionKey("!!!not-base64!!!")).rejects.toThrow();
    await expect(importEncryptionKey("")).rejects.toThrow();
  });
});
