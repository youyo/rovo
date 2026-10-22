import { describe, expect, it } from "vitest";
import { headChars, maskSecrets, stripAnsi, tailChars } from "../src";

// 秘密の検出に反応しないよう、明らかな偽物を組み立てる
const GHP = `ghp_${"a1B2".repeat(9)}`;
const GHS = `ghs_${"c3D4".repeat(9)}`;
const PAT = `github_pat_${"E5f6".repeat(8)}`;

describe("maskSecrets（gateway と agent の共通。D14）", () => {
  it.each([
    ["GitHub ghp_", `x ${GHP} y`, GHP],
    ["GitHub ghs_", `x ${GHS} y`, GHS],
    ["GitHub fine-grained", `x ${PAT} y`, PAT],
    [
      "Bearer",
      "wget --header 'Authorization: Bearer " + "abcdef0123456789xyz' https://e",
      "abcdef0123456789xyz",
    ],
    ["bearer（ヘッダ名なし）", "token is Bearer abcdef0123456789xyz here", "abcdef0123456789xyz"],
    ["URL 内の資格", "git clone https://user:s3cretPass@example.com/r.git", "s3cretPass"],
    ["env の KEY=value（TOKEN）", "GITHUB_TOKEN=plainvalue123 npm test", "plainvalue123"],
    ["env の KEY=value（API_KEY）", "export OPENAI_API_KEY=plainvalue456", "plainvalue456"],
    ["env の KEY=value（PASSWORD・引用符つき）", 'DB_PASSWORD="pa ss wd" run', "pa ss wd"],
    // 秘密の検出に反応しないよう、キー名を分けて組み立てる
    ["AWS", `${"aws_secret"}_access_key: ${"abcd"}${"EFGH1234"}`, `${"abcd"}${"EFGH1234"}`],
  ])("%s は先頭でない位置でも伏せる", (_name, text, secret) => {
    const out = maskSecrets(`prefix line\n${text}\nsuffix`);
    expect(out).not.toContain(secret);
    expect(out).toContain("[REDACTED]");
    expect(out).toContain("prefix line");
    expect(out).toContain("suffix");
  });

  it("通常の文字列は変えない", () => {
    expect(maskSecrets("NODE_ENV=production pnpm test")).toBe("NODE_ENV=production pnpm test");
  });
});

describe("text（共通化した整形）", () => {
  it("stripAnsi / headChars / tailChars を提供する", () => {
    expect(stripAnsi("\u001b[31mred\u001b[0m")).toBe("red");
    expect(headChars("あいうえお", 3)).toBe("あいう...");
    expect(tailChars("あいうえお", 3)).toBe("...うえお");
  });
});
