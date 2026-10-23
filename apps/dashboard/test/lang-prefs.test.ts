import { describe, expect, it } from "vitest";
import { LANG_KEY, loadLang, saveLang } from "../src/prefs";

const memory = (init: Record<string, string> = {}) => {
  const m = new Map(Object.entries(init));
  return {
    m,
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, v),
  };
};
const throwing = {
  getItem: () => {
    throw new Error("denied");
  },
  setItem: () => {
    throw new Error("denied");
  },
};

describe("言語の保存（localStorage rovo.dashboard.lang）", () => {
  it("キー名は rovo.dashboard.lang", () => {
    expect(LANG_KEY).toBe("rovo.dashboard.lang");
  });

  it("何も保存されていなければ英語（ブラウザの言語は見ない）", () => {
    expect(loadLang(memory())).toBe("en");
    expect(loadLang(undefined)).toBe("en");
  });

  it("保存された en / ja をそのまま返す", () => {
    expect(loadLang(memory({ [LANG_KEY]: "ja" }))).toBe("ja");
    expect(loadLang(memory({ [LANG_KEY]: "en" }))).toBe("en");
  });

  it("未知の値は英語", () => {
    for (const v of ["fr", "JA", "", "ja ", "__proto__", "constructor"]) {
      expect(loadLang(memory({ [LANG_KEY]: v })), v).toBe("en");
    }
  });

  it("読み出しが投げても英語で動く", () => {
    expect(loadLang(throwing)).toBe("en");
  });

  it("保存する。保存が投げても例外にしない", () => {
    const s = memory();
    saveLang("ja", s);
    expect(s.m.get(LANG_KEY)).toBe("ja");
    saveLang("en", s);
    expect(s.m.get(LANG_KEY)).toBe("en");
    expect(() => saveLang("ja", throwing)).not.toThrow();
    expect(() => saveLang("ja", undefined)).not.toThrow();
  });
});
