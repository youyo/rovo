import { describe, expect, it } from "vitest";
import { DICTS, LANGS, localeOf, makeT } from "../src/i18n";

const CJK = /[\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Han}]/u;
const placeholders = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();

describe("辞書（en と ja）", () => {
  it("対応する言語は en と ja の 2 つ", () => {
    expect([...LANGS]).toEqual(["en", "ja"]);
  });

  it("en と ja のキーが一致する", () => {
    expect(Object.keys(DICTS.ja).sort()).toEqual(Object.keys(DICTS.en).sort());
  });

  it("どのキーも空の文字列ではない", () => {
    for (const lang of LANGS) {
      for (const [k, v] of Object.entries(DICTS[lang])) {
        expect(v, `${lang}:${k}`).not.toBe("");
      }
    }
  });

  it("差し込みの名前（{name}）が en と ja で同じ", () => {
    for (const k of Object.keys(DICTS.en) as (keyof typeof DICTS.en)[]) {
      const en = placeholders(DICTS.en[k]);
      const ja = placeholders(DICTS.ja[k]);
      // ja は単複を持たないので、en の単複の両方に出る名前だけを比べる
      expect(new Set(ja), k).toEqual(new Set(en));
    }
  });

  it("en の文言に日本語の文字は無い（訳し漏れの目印）", () => {
    for (const [k, v] of Object.entries(DICTS.en)) {
      expect(CJK.test(v), `en:${k} = ${v}`).toBe(false);
    }
  });
});

describe("t", () => {
  it("lang とロケール（en は en-US、ja は ja-JP）を持つ", () => {
    expect(makeT("en").lang).toBe("en");
    expect(makeT("ja").lang).toBe("ja");
    expect(localeOf("en")).toBe("en-US");
    expect(localeOf("ja")).toBe("ja-JP");
  });

  it("言語ごとの文言を引く", () => {
    expect(makeT("en")("scope.me")).toBe("My tasks");
    expect(makeT("ja")("scope.me")).toBe("マイタスク");
    expect(makeT("en")("scope.all")).toBe("Team");
    expect(makeT("ja")("scope.all")).toBe("チーム");
  });

  it("パラメータを差し込む。足りないものは {name} のまま残す", () => {
    expect(makeT("en")("header.merged", { n: 3 })).toBe("Merged 3");
    expect(makeT("ja")("header.merged", { n: 3 })).toBe("マージ 3");
    expect(makeT("en")("header.merged")).toBe("Merged {n}");
  });

  it("en は n が 1 のとき単数形、ほかは複数形。ja は常に同じ形", () => {
    expect(makeT("en")("header.total", { n: 1 })).toBe("1 task");
    expect(makeT("en")("header.total", { n: 0 })).toBe("0 tasks");
    expect(makeT("en")("header.total", { n: 12 })).toBe("12 tasks");
    expect(makeT("ja")("header.total", { n: 1 })).toBe("1 件");
    expect(makeT("ja")("header.total", { n: 12 })).toBe("12 件");
  });

  it("差し込む値は文字のまま（HTML として解釈せず、$& などの置換記号も効かない）", () => {
    const out = makeT("en")("header.merged", { n: "<b>$&</b>" });
    expect(out).toBe("Merged <b>$&</b>");
  });

  it("差し込んだ値の中の {name} は、さらに置換されない", () => {
    expect(makeT("en")("header.merged", { n: "{n}" })).toBe("Merged {n}");
  });
});
