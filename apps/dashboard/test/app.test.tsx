import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { App } from "../src/app";

describe("App（初期表示）", () => {
  it("確認中の間は見出し「ダッシュボード」を出し、一覧の本文はまだ出さない", () => {
    const html = renderToStaticMarkup(createElement(App));
    expect(html).toContain("<h1>ダッシュボード</h1>");
    expect(html).not.toContain("準備中");
    expect(html).not.toContain("<table");
  });

  it("style 要素とマークアップの style 属性を作らない（CSP の style-src 'self'）", () => {
    const html = renderToStaticMarkup(createElement(App));
    expect(html).not.toMatch(/<style/i);
    expect(html).not.toMatch(/\sstyle=/i);
  });
});
