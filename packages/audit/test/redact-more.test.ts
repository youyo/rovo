import { describe, expect, it } from "vitest";
import { maskSecrets } from "../src";

// 秘密の検出（gitleaks）に反応しないよう、キー名と値は文字列連結で組み立てる
const j = (...p: string[]) => p.join("");
const V = j("Zq8x", "Lm3p", "Rt6w"); // 12 文字の値

const wrap = (text: string) => `before\n${text}\nafter`;

describe("maskSecrets: JSON / YAML 風のキー", () => {
  it.each([
    [j('"tok', 'en": "', V, '"'), V],
    [j('"pass', 'word": "', V, '"'), V],
    [j("pass", "word: ", V), V],
    [j('"sec', 'ret": "', V, '"'), V],
    [j('"api_', 'key": "', V, '"'), V],
    [j('"api-', 'key": "', V, '"'), V],
    [j('"access_', 'token": "', V, '"'), V],
    [j('"client_', 'secret": "', V, '"'), V],
    [j('"Client_', 'Secret": "', V, '"'), V],
    [j("TOK", "EN: ", V), V],
    [j("'tok", "en': '", V, "'"), V],
    [j('{"a": 1, "tok', 'en":"', V, '"}'), V],
  ])("%s は値を伏せる", (text, secret) => {
    const out = maskSecrets(wrap(text));
    expect(out).not.toContain(secret);
    expect(out).toContain("[REDACTED]");
    expect(out.startsWith("before\n")).toBe(true);
    expect(out.endsWith("\nafter")).toBe(true);
  });

  it("JSON の構造（クォートと閉じ括弧）は壊さない", () => {
    const out = maskSecrets(j('{"tok', 'en": "', V, '", "b": 2}'));
    expect(JSON.parse(out.replace("[REDACTED]", "x"))).toMatchObject({ b: 2 });
  });

  it.each([
    '"max_tokens": 4096',
    '"max_tokens": "4096"',
    "max_tokens: 4096",
    j('"tok', 'en": 12345678901234'),
    j('"tok', 'en": "short"'),
    j('"tok', 'en": true'),
    j('"tok', 'en": "false"'),
    j('"tok', 'en": null'),
    j('"pass', 'word": ""'),
    '"tokenizer": "abcdefghijklmnop"',
    '"secrets_count": "abcdefghijkl"',
    "total token usage: lots",
  ])("%s は残す", (text) => {
    expect(maskSecrets(wrap(text))).toBe(wrap(text));
  });
});

describe("maskSecrets: CLI フラグ", () => {
  it.each([
    [j("run --tok", "en ", V, " go"), V],
    [j("run --tok", "en=", V, " go"), V],
    [j("run --pass", "word ", V), V],
    [j("run --pass", "word=", V), V],
    [j("run --api-", "key ", V), V],
    [j("run --api-", "key=", V), V],
    [j("run --sec", "ret=", V), V],
    [j("run --tok", "en vv"), "vv"],
    [j("run --tok", 'en "', V, ' x"'), V],
  ])("%s は値を伏せる", (text, secret) => {
    const out = maskSecrets(wrap(text));
    expect(out).not.toContain(secret);
    expect(out).toContain("[REDACTED]");
  });

  it.each([
    "run --token-limit 5",
    "run --tokens 5",
    "run --token-limit=5",
    j("run --pass", "word-file ./p.txt"),
    j("run --tok", "en --verbose"),
    "run --secrets-dir ./s",
  ])("%s は残す", (text) => {
    expect(maskSecrets(wrap(text))).toBe(wrap(text));
  });
});

describe("maskSecrets: ヘッダ・クエリ", () => {
  it.each([
    [j("X-Auth-", "Key: ", V), V],
    [j("x-api-", "key: ", V), V],
    [j("X-Api-", "Key: ", V), V],
    [j("Coo", "kie: session=", V, "; other=1"), V],
    [j("Set-Coo", "kie: sid=", V, "; Path=/"), V],
    [j("https://h.example/p?a=1&access_", "token=", V, "&b=2"), V],
    [j("https://h.example/p?tok", "en=", V), V],
    [j("https://h.example/p?x=1&api_", "key=", V), V],
  ])("%s は値を伏せる", (text, secret) => {
    const out = maskSecrets(wrap(text));
    expect(out).not.toContain(secret);
    expect(out).toContain("[REDACTED]");
  });

  it("クエリのマスクは他のパラメータを残す", () => {
    const out = maskSecrets(j("https://h.example/p?a=1&tok", "en=", V, "&b=2"));
    expect(out).toBe("https://h.example/p?a=1&token=[REDACTED]&b=2");
  });

  it.each([
    "https://h.example/p?max_tokens=5&a=1",
    "https://h.example/p?tokenizer=abc",
    "Content-Type: application/json",
    "Cookies are great: yes",
  ])("%s は残す", (text) => {
    expect(maskSecrets(wrap(text))).toBe(wrap(text));
  });
});

describe("maskSecrets: 形式で見分けられるトークン", () => {
  const rep = (c: string, n: number) => c.repeat(n);
  it.each([
    ["Slack bot", j("xo", "xb-", "1234567890-", "abcdefghij")],
    ["Slack user", j("xo", "xp-", "1234567890-", "abcdefghij")],
    ["Slack app", j("xo", "xa-", "1-abcdefghij")],
    ["Stripe sk_live", j("sk_", "live_", rep("a1", 12))],
    ["Stripe rk_live", j("rk_", "live_", rep("b2", 12))],
    ["Google API key", j("AI", "za", rep("Ab1_", 8), "xyz")],
    [
      "JWT",
      j(
        "ey",
        "Jhbgci0ijiuzi1ni",
        ".ey",
        "JzdWIiOiIxMjM0NTY3ODkwIn0",
        ".SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c",
      ),
    ],
    ["URL エンコードの GitHub (ghp)", j("gh", "p%5F", rep("aB1", 12))],
    ["URL エンコードの GitHub (ghs・小文字)", j("gh", "s%5f", rep("cD2", 12))],
    ["URL エンコードの GitHub (pat)", j("github%5F", "pat%5F", rep("eF3", 12))],
  ])("%s は先頭でない位置でも伏せる", (_n, secret) => {
    const out = maskSecrets(wrap(j("x=1 ", secret, " y")));
    expect(out).not.toContain(secret);
    expect(out).toContain("[REDACTED]");
    expect(out).toContain("x=1 ");
  });

  it.each([
    "sk_test_" + "a".repeat(24),
    "AIza" + "short",
    "eyJ-not-a-jwt",
    "ey" + "Jhbgci0ijiuzi1ni.onlyonepart",
    "xox is a word",
    "ghp%5F" + "ab",
  ])("%s は残す", (text) => {
    expect(maskSecrets(wrap(text))).toBe(wrap(text));
  });
});
