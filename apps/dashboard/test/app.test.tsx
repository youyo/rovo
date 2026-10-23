import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it } from "vitest";
import { App } from "../src/app";
import { LANG_KEY } from "../src/prefs";

describe("App（初期表示）", () => {
  afterEach(() => localStorage.removeItem(LANG_KEY));

  it("確認中の間は、ログインの画面も一覧の本文も出さない（ログイン済みの人にログインの画面をチラつかせない）", () => {
    // 否定の確認なので、日本語と英語の両方で描いて確かめる（言語を取り違えても素通りしない）
    for (const lang of ["ja", "en"]) {
      localStorage.setItem(LANG_KEY, lang);
      const html = renderToStaticMarkup(createElement(App));
      expect(html, lang).not.toContain("<h1");
      expect(html, lang).not.toContain("GitHub でログイン");
      expect(html, lang).not.toContain("Sign in with GitHub");
      expect(html, lang).not.toContain("準備中");
      expect(html, lang).not.toContain("Preparing");
      expect(html, lang).not.toContain("<table");
    }
  });

  it("style 要素とマークアップの style 属性を作らない（CSP の style-src 'self'）", () => {
    const html = renderToStaticMarkup(createElement(App));
    expect(html).not.toMatch(/<style/i);
    expect(html).not.toMatch(/\sstyle=/i);
  });

  it("確認中でもヘッダには言語の切り替えが出る", () => {
    const html = renderToStaticMarkup(createElement(App));
    expect(html).toContain("EN");
    expect(html).toContain("日本語");
  });
});
