import { describe, expect, it } from "vitest";
import { maskSecrets } from "../../src/redact";

describe("maskSecrets", () => {
  it.each([
    ["ghp_" + "a".repeat(36)],
    ["gho_" + "B".repeat(36)],
    ["ghu_" + "c".repeat(36)],
    ["ghs_" + "D".repeat(36)],
    ["ghr_" + "e".repeat(36)],
    ["github_pat_" + "11ABCDEFG0_" + "x".repeat(50)],
    ["sk-ant-api03-" + "a1b2c3d4".repeat(6)],
    [`${"AKIA"}IOSFODNN7EXAMPLE`],
    [`${"ASIA"}IOSFODNN7EXAMPLE`],
  ])("資格情報らしき文字列 %s をマスクする", (secret) => {
    const out = maskSecrets(`before ${secret} after`);
    expect(out).not.toContain(secret);
    expect(out).toContain("[REDACTED]");
    expect(out.startsWith("before ")).toBe(true);
    expect(out.endsWith(" after")).toBe(true);
  });

  it("Bearer トークンと Authorization ヘッダをマスクする", () => {
    expect(maskSecrets("Authorization: Bearer abc.DEF-123_xyz==")).not.toContain("abc.DEF");
    expect(maskSecrets("curl -H 'Authorization: token ghx'")).not.toContain("ghx");
    expect(maskSecrets("bearer   Zm9vYmFyYmF6")).not.toContain("Zm9vYmFyYmF6");
  });

  it("AWS のシークレットキー代入、URL 内の認証情報、秘密鍵ブロックをマスクする", () => {
    expect(
      maskSecrets("aws_secret_access_key = wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY"),
    ).not.toContain("wJalr");
    expect(maskSecrets("https://user:p4ssw0rd@github.com/x")).not.toContain("p4ssw0rd");
    const key = "-----BEGIN RSA PRIVATE KEY-----\nMIIabc\ndef\n-----END RSA PRIVATE KEY-----";
    expect(maskSecrets(`x\n${key}\ny`)).not.toContain("MIIabc");
  });

  it("普通の文字列は変えない", () => {
    const s = "hello world\nsk-learn is a library; ghp is short; AKIA";
    expect(maskSecrets(s)).toBe(s);
  });

  it("二重に適用しても結果は同じ（冪等）", () => {
    const once = maskSecrets("x ghp_" + "a".repeat(36));
    expect(maskSecrets(once)).toBe(once);
  });
});
