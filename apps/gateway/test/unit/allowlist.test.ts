import { describe, expect, it } from "vitest";
import { isUserIdAllowed, loadAllowRules } from "../../src/auth/allowlist";

type E = { ALLOWED_ORG?: string; ALLOWED_TEAM?: string; ALLOWED_USER_IDS?: string };

describe("loadAllowRules: ALLOWED_USER_IDS の解析", () => {
  it.each<[string, string | undefined, number[] | "invalid"]>([
    ["123", "123", [123]],
    ["前後の空白は除く", "123, 456", [123, 456]],
    ["周囲の空白", "  7 ,8\t", [7, 8]],
    ["英字を含む", "12a", "invalid"],
    ["0", "0", "invalid"],
    ["負の数", "-1", "invalid"],
    ["重複", "123,123", "invalid"],
    ["重複（先頭の 0 だけ違う）", "5,05", "invalid"],
    ["空要素だけ", ",", "invalid"],
    ["空白だけ", " ", "invalid"],
    ["途中の空要素", "1,,2", "invalid"],
    ["末尾のカンマ", "1,2,", "invalid"],
    ["小数", "1.5", "invalid"],
    ["良い要素と悪い要素の混在は全体が不正", "1,abc,3", "invalid"],
    ["安全な整数を超える", "99999999999999999999", "invalid"],
  ])("%s: %j", (_name, value, expected) => {
    const r = loadAllowRules({ ALLOWED_USER_IDS: value } as E);
    if (expected === "invalid") {
      expect(r).toBeNull();
    } else {
      expect(r).not.toBeNull();
      expect(r?.membership).toBeNull();
      expect([...(r?.userIds ?? [])]).toEqual(expected);
    }
  });
});

describe("loadAllowRules: ルールの組み合わせ", () => {
  it("ID だけ: 有効", () => {
    expect(loadAllowRules({ ALLOWED_USER_IDS: "10" })?.membership).toBeNull();
  });
  it("org/team だけ: 有効", () => {
    const r = loadAllowRules({ ALLOWED_ORG: "acme", ALLOWED_TEAM: "core" });
    expect(r?.membership).toEqual({ org: "acme", team: "core" });
    expect(r?.userIds).toBeNull();
  });
  it("org だけ: 有効（org の全員を許可。team は null）", () => {
    const r = loadAllowRules({ ALLOWED_ORG: "acme" });
    expect(r?.membership).toEqual({ org: "acme", team: null });
    expect(r?.userIds).toBeNull();
  });
  it("org だけ（team が空文字）+ ID: 有効で OR", () => {
    const r = loadAllowRules({ ALLOWED_ORG: "acme", ALLOWED_TEAM: "", ALLOWED_USER_IDS: "10" });
    expect(r?.membership).toEqual({ org: "acme", team: null });
    expect(r?.userIds?.has(10)).toBe(true);
  });
  it("両方: 有効", () => {
    const r = loadAllowRules({ ALLOWED_ORG: "acme", ALLOWED_TEAM: "core", ALLOWED_USER_IDS: "10" });
    expect(r?.membership).toEqual({ org: "acme", team: "core" });
    expect(r?.userIds?.has(10)).toBe(true);
  });
  it.each<[string, E]>([
    ["何も無い", {}],
    ["空文字だけ", { ALLOWED_ORG: "", ALLOWED_TEAM: "", ALLOWED_USER_IDS: "" }],
  ])("どちらも無い（%s）: null", (_n, env) => {
    expect(loadAllowRules(env)).toBeNull();
  });
  it.each<[string, E]>([
    ["team だけ", { ALLOWED_TEAM: "core" }],
    ["team だけ + 有効な ID", { ALLOWED_TEAM: "core", ALLOWED_USER_IDS: "10" }],
    ["team だけ（org が空文字）", { ALLOWED_ORG: "", ALLOWED_TEAM: "core" }],
  ])("team だけ（org なし）は ID が有効でも不正（fail closed）: %s", (_n, env) => {
    expect(loadAllowRules(env)).toBeNull();
  });
  it("org/team が完全でも、ID が不正なら全体が不正", () => {
    expect(
      loadAllowRules({ ALLOWED_ORG: "acme", ALLOWED_TEAM: "core", ALLOWED_USER_IDS: "1,,2" }),
    ).toBeNull();
  });
});

describe("isUserIdAllowed", () => {
  it("リストにある ID だけ true", () => {
    const r = loadAllowRules({ ALLOWED_USER_IDS: "10,20" });
    if (!r) throw new Error("rules");
    expect(isUserIdAllowed(r, 10)).toBe(true);
    expect(isUserIdAllowed(r, 20)).toBe(true);
    expect(isUserIdAllowed(r, 30)).toBe(false);
  });
  it("ID のルールが無ければ常に false", () => {
    const r = loadAllowRules({ ALLOWED_ORG: "acme", ALLOWED_TEAM: "core" });
    if (!r) throw new Error("rules");
    expect(isUserIdAllowed(r, 10)).toBe(false);
  });
});
