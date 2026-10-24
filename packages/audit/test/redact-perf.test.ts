import { describe, expect, it } from "vitest";
import { maskSecrets } from "../src";

// maskSecrets はワーカーの出力（最大数百 KB）にそのままかかる。入力長の 2 乗になる正規表現を許さない。
// 2 乗なら 100KB で数秒かかる大きさ。上限は CI の揺れを考えて緩め（線形なら数十 ms）。
const SIZE = 100_000;
const LIMIT_MS = 500;

const rep = (unit: string) => unit.repeat(Math.ceil(SIZE / unit.length)).slice(0, SIZE);

const INPUTS: [string, string][] = [
  ["a の連続", rep("a")],
  ["a- の連続", rep("a-")],
  ["a. の連続", rep("a.")],
  ["token の連続", rep("token")],
  ["eyJ の連続", rep("eyJ")],
  // 各パターンの「惜しい」形（途中まで合って、最後に合わない）
  ["ghp_", rep("ghp_")],
  ["github_pat_", rep("github_pat_")],
  ["sk-ant-", rep("sk-ant-")],
  ["sk-", rep("sk-a")],
  ["AKIA", rep("AKIA")],
  ["aws キー", rep("aws_secret_access_key  ")],
  ["authorization", rep("authorization: bearer ")],
  ["bearer", rep("bearer ")],
  ["url 資格", rep("a://b:")],
  ["url 資格の @ なし", `a://${"b:".repeat(SIZE / 2)}`],
  ["env 名のみ", rep("A_TOKEN")],
  ["env 代入", rep("A_TOKEN=")],
  ["env 代入の引用符", rep('A_TOKEN="')],
  ["小文字 env", rep("export token=")],
  ["json キー", rep('"token": "')],
  ["json キー（値なし）", rep('"token":')],
  ["yaml キー", rep("password: ")],
  ["キー候補の連続", rep("x_token_")],
  ["JWT 前半", rep("eyJaaaaa.eyJaaaaa.")],
  ["JWT 前半のみ", rep("eyJaaaaa.")],
  ["Slack", rep("xoxb-")],
  ["Stripe", rep("sk_live_")],
  ["Google", rep("AIza")],
  ["URL エンコード", rep("ghp%5F")],
  ["URL エンコード pat", rep("github%5Fpat%5F")],
  ["cookie", rep("cookie:")],
  ["cookie 空白", rep("cookie: \t")],
  ["x-api-key", rep("x-api-key ")],
  ["クエリ", rep("?token")],
  ["クエリ 2", rep("&access_token=&")],
  ["フラグ", rep("--token ")],
  ["フラグ（ハイフン）", rep("--token --")],
  ["フラグ（引用符）", rep('--token "')],
  ["空白", rep(" ")],
  ["改行", rep("\n")],
  ["引用符", rep('"')],
  ["秘密鍵の開始", rep("-----BEGIN PRIVATE " + "KEY-----")],
];

describe("maskSecrets: 100KB の入力を線形の時間で処理する（ReDoS 対策）", () => {
  it.each(INPUTS)("%s", (_name, input) => {
    expect(input.length).toBeGreaterThanOrEqual(SIZE - 1);
    const t0 = performance.now();
    maskSecrets(input);
    const ms = performance.now() - t0;
    expect(ms, `${ms.toFixed(0)}ms`).toBeLessThan(LIMIT_MS);
  });
});

describe("maskSecrets: 小文字の env", () => {
  const V = ["abcdefghijk", "12345"].join("");
  it("export token=... は伏せる", () => {
    const out = maskSecrets(`a\nexport token=${V}\nb`);
    expect(out).not.toContain(V);
    expect(out).toContain("[REDACTED]");
    expect(maskSecrets(`api_key=${V}`)).not.toContain(V);
    expect(maskSecrets(`DB_password='${V}'`)).not.toContain(V);
  });

  it.each([
    "export max_tokens=4096",
    "token_count=5",
    "use_token=true",
    "token=short",
    "tokenizer=abcdefghijklmnop",
    "mytokens=abcdefghijklmnop",
    "export token=",
  ])("%s は残す", (text) => {
    expect(maskSecrets(`a\n${text}\nb`)).toBe(`a\n${text}\nb`);
  });
});
