import { describe, expect, it } from "vitest";
import { maskSecrets } from "../src";

// env の KEY=value は、値が秘密らしいときだけ伏せる（ワーカーのモデルが読むツール結果の誤検出を減らす）
describe("maskSecrets: env の KEY=value", () => {
  it.each([
    "MAX_TOKENS=4096",
    "TOKEN_COUNT=5",
    "USE_TOKEN=true",
    "USE_TOKEN=FALSE",
    "API_KEY=",
    "DB_PASSWORD=short7c",
    'DB_PASSWORD="abc"',
    "export MAX_TOKENS=123456789012",
  ])("%s は残す", (text) => {
    expect(maskSecrets(`a\n${text}\nb`)).toBe(`a\n${text}\nb`);
  });

  it.each([
    // 秘密の検出に反応しないよう、値を分けて組み立てる
    [`GITHUB_TOKEN=${"abcdefgh"}${"12345678"}`, `${"abcdefgh"}${"12345678"}`],
    [`API_KEY="${"sk-"}${"0123456789"}"`, `${"sk-"}${"0123456789"}`],
    [`export DB_PASSWORD=${"hunter2"}${"hunter2"}`, `${"hunter2"}${"hunter2"}`],
    ["DB_PASSWORD='pa ss wd 1'", "pa ss wd 1"],
    ["SECRET=abcdefgh", "abcdefgh"],
  ])("%s は伏せる", (text, secret) => {
    const out = maskSecrets(`a\n${text}\nb`);
    expect(out).not.toContain(secret);
    expect(out).toContain("[REDACTED]");
  });
});
