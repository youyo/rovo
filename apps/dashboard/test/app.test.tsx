import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { App } from "../src/app";

describe("App（M1 の雛形）", () => {
  it("見出し「ダッシュボード」と「準備中」を出す", () => {
    const html = renderToStaticMarkup(createElement(App));
    expect(html).toContain("<h1>ダッシュボード</h1>");
    expect(html).toContain("準備中");
  });

  it("style 要素とマークアップの style 属性を作らない（CSP の style-src 'self'）", () => {
    const html = renderToStaticMarkup(createElement(App));
    expect(html).not.toMatch(/<style/i);
    expect(html).not.toMatch(/\sstyle=/i);
  });
});
