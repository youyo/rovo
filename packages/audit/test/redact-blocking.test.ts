import { describe, expect, it } from "vitest";
import { findBlockingSecrets, maskSecrets } from "../src";

// 秘密の検出に反応しないよう、明らかな偽物を組み立てる
const GHP = `ghp_${"a1B2".repeat(9)}`;
const PAT = `github_pat_${"E5f6".repeat(8)}`;
const categories = (text: string) => findBlockingSecrets(text).map((f) => f.category);

describe("findBlockingSecrets（push を止める確度の高いパターンだけ）", () => {
  it.each([
    [
      "秘密鍵のブロック",
      `-----BEGIN ${"RSA PRIVATE"} KEY-----\nMIIE\n-----END RSA PRIVATE KEY-----`,
    ],
    ["秘密鍵の開始行だけ", `-----BEGIN ${"OPENSSH PRIVATE"} KEY-----`],
    ["GitHub ghp_", `token ${GHP}`],
    ["GitHub ghs_", `x ghs_${"c3D4".repeat(9)}`],
    ["GitHub fine-grained", `x ${PAT}`],
    ["GitHub URL エンコード", `x ghp%5F${"a1B2".repeat(9)}`],
    ["GitHub fine-grained URL エンコード", `x github%5Fpat%5F${"E5f6".repeat(8)}`],
    ["Anthropic", `x sk-ant-${"a1B2".repeat(5)}`],
    ["OpenAI", `x sk-${"a1B2".repeat(10)}`],
    ["OpenAI proj", `x sk-proj-${"a1B2".repeat(10)}`],
    ["AWS AKIA", `x AKIA${"ABCD1234".repeat(2)}`],
    ["AWS ASIA", `x ASIA${"ABCD1234".repeat(2)}`],
    ["Slack", `x xoxb-${"1234567890"}-abcdef`],
    ["Stripe sk_live", `x sk_live_${"a1B2c3D4e5"}`],
    ["Stripe rk_live", `x rk_live_${"a1B2c3D4e5"}`],
    ["Google", `x AIza${"a1B2".repeat(8)}abc`],
    ["JWT", `x eyJ${"hbGci"}.eyJ${"zdWIi"}.${"sig_abc"}`],
    ["URL に埋め込まれた認証情報", "git clone https://user:s3cretPass@example.com/r.git"],
  ])("%s を見つける", (_name, text) => {
    const found = findBlockingSecrets(`prefix\n${text}\nsuffix`);
    expect(found.length).toBeGreaterThan(0);
    for (const f of found) expect(typeof f.category).toBe("string");
  });

  it("カテゴリ名と、値が最初に現れる行番号（1 始まり）を返す。値そのものは含めない", () => {
    const found = findBlockingSecrets(`a\nb\nconst t = "${GHP}"\n`);
    expect(found).toEqual([{ category: "github-token", line: 3 }]);
    expect(JSON.stringify(found)).not.toContain(GHP);
  });

  it("複数カテゴリを、現れる順に返す", () => {
    const text = `x AKIA${"ABCD1234".repeat(2)}\ny ${GHP}\n`;
    expect(categories(text)).toEqual(["aws-access-key", "github-token"]);
  });

  it.each([
    ["Authorization: Bearer", "Authorization: Bearer abc.DEF-123_xyz=="],
    ["bearer", "token is Bearer abcdef0123456789xyz here"],
    ["cookie", "cookie: a=b"],
    ["set-cookie", "set-cookie: sid=abcdef0123456789"],
    ["x-api-key", "x-api-key: 0000000000000000"],
    ["env の FOO_TOKEN=", "FOO_TOKEN=bar"],
    ["env の GITHUB_TOKEN=", "GITHUB_TOKEN=plainvalue123"],
    ["クエリの token=", "curl https://example.com/api?token=aaaaaaaa1111"],
    ["クエリの access_token=", "https://example.com/?access_token=aaaaaaaa1111"],
    ["CLI フラグ", "cli --token abcdef0123456789 --password hunter2hunter2"],
    ["aws_secret_access_key=", `${"aws_secret"}_access_key=${"abcd"}${"EFGH1234"}`],
    ["JSON の token", '{"token": "0000000000000000"}'],
    ["YAML の password", "password: hunter2hunter2"],
    ["通常の文", "const x = 1;\nNODE_ENV=production pnpm test"],
    ["空", ""],
  ])("推測系（%s）では何も見つけない", (_name, text) => {
    expect(findBlockingSecrets(text)).toEqual([]);
  });

  it("同じ入力で繰り返し呼んでも結果が変わらない（正規表現の状態を持ち越さない）", () => {
    const text = `x ${GHP}`;
    expect(findBlockingSecrets(text)).toEqual(findBlockingSecrets(text));
    expect(findBlockingSecrets(text)).toHaveLength(1);
  });

  it("maskSecrets の結果は変わらない（共有した正規表現でも）", () => {
    expect(maskSecrets(`x ${GHP} y`)).toBe("x [REDACTED] y");
    expect(maskSecrets(`x ${GHP} y`)).toBe("x [REDACTED] y");
    expect(maskSecrets("Authorization: Bearer abc.DEF-123_xyz==")).toBe(
      "Authorization: [REDACTED]",
    );
  });
});
