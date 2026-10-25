import { act, createElement, type ReactElement } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuthView } from "../src/auth-view";
import { Header } from "../src/header";
import { hourTicks } from "../src/timeline";
import { inEn, inJa, tJa } from "./lang";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const roots: { unmount: () => void }[] = [];
afterEach(() => {
  for (const r of roots.splice(0)) act(() => r.unmount());
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});

/** 720px 以下を再現する matchMedia（max-width: 720px だけ true） */
function stubNarrow(narrow: boolean) {
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: narrow && query.includes("max-width: 720px"),
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
  }));
}

function mount(el: ReactElement): HTMLElement {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  act(() => root.render(el));
  return container;
}

describe("モバイル幅のヘッダー: 言語のボタン", () => {
  beforeEach(() => stubNarrow(true));

  it("日本語のときは「EN」1 つだけ（lang=en）。押すと英語に切り替わり、今度は「日本語」になる", () => {
    const c = mount(inJa(createElement(Header, { summary: null })));
    expect(c.querySelector("fieldset.lang")).toBeNull();
    const btn = c.querySelector("button.lang-one") as HTMLButtonElement;
    expect(btn.textContent).toBe("EN");
    expect(btn.getAttribute("lang")).toBe("en");
    act(() => btn.click());
    const after = c.querySelector("button.lang-one") as HTMLButtonElement;
    expect(after.textContent).toBe("日本語");
    expect(after.getAttribute("lang")).toBe("ja");
  });

  it("英語のときは「日本語」", () => {
    const c = mount(inEn(createElement(Header, { summary: null })));
    const btn = c.querySelector("button.lang-one") as HTMLButtonElement;
    expect(btn.textContent).toBe("日本語");
    expect(btn.getAttribute("lang")).toBe("ja");
  });

  it("「Rovo」の文字は読み上げに残す（brand-name。CSS で見えない形にする）", () => {
    const c = mount(inJa(createElement(Header, { summary: null })));
    expect(c.querySelector(".brand .brand-name")?.textContent).toBe("Rovo");
  });
});

describe("広い幅のヘッダー: 従来どおりのセグメント", () => {
  it("EN | 日本語 のセグメントで、1 つだけのボタンは無い", () => {
    stubNarrow(false);
    const c = mount(inJa(createElement(Header, { summary: null })));
    expect(c.querySelector("button.lang-one")).toBeNull();
    expect([...c.querySelectorAll("fieldset.lang button")].map((b) => b.textContent)).toEqual([
      "EN",
      "日本語",
    ]);
  });

  it("matchMedia が無い環境（SSR など）も広い幅の形", () => {
    const html = renderToStaticMarkup(inJa(createElement(Header, { summary: null })));
    expect(html).toContain("seg lang");
    expect(html).not.toContain("lang-one");
  });
});

describe("利用者のアバター", () => {
  const signedIn = { state: "signed-in", login: "alice" } as const;

  it("狭い幅: details/summary に畳み、summary は頭文字、aria-label に利用者名。中にログアウト", () => {
    stubNarrow(true);
    const onLogout = vi.fn();
    const c = mount(inJa(createElement(AuthView, { auth: signedIn, loginHref: "/x", onLogout })));
    const d = c.querySelector("details.user-menu") as HTMLDetailsElement;
    expect(d).not.toBeNull();
    const s = d.querySelector("summary") as HTMLElement;
    expect(s.getAttribute("aria-label")).toBe("alice");
    expect(s.textContent).toBe("A");
    const out = [...d.querySelectorAll("button")].find((b) => b.textContent === "ログアウト");
    expect(out).toBeDefined();
    act(() => (out as HTMLButtonElement).click());
    expect(onLogout).toHaveBeenCalledTimes(1);
  });

  it("広い幅: 従来の並び（名前とログアウト）で details は無い", () => {
    stubNarrow(false);
    const c = mount(inJa(createElement(AuthView, { auth: signedIn, loginHref: "/x" })));
    expect(c.querySelector("details")).toBeNull();
    expect(c.textContent).toContain("alice");
    expect(c.querySelector("button")?.textContent).toBe("ログアウト");
  });

  it("未ログイン: 狭い幅でも details は使わずログインのリンクをそのまま出す", () => {
    stubNarrow(true);
    const c = mount(
      inJa(createElement(AuthView, { auth: { state: "signed-out" }, loginHref: "/login" })),
    );
    expect(c.querySelector("details")).toBeNull();
    expect(c.querySelector("a")?.getAttribute("href")).toBe("/login");
  });
});

describe("タイムラインの時刻ラベルの data 属性", () => {
  it("hourTicks は時が 3 の倍数か・6 の倍数かを持つ", () => {
    const start = new Date(2026, 9, 22, 0, 0, 0).getTime();
    const ticks = hourTicks({ start, end: start + 12 * 3_600_000 }, tJa);
    expect(ticks.map((t) => [t.label, t.by3, t.by6])).toEqual(
      Array.from({ length: 13 }, (_, h) => [`${h}:00`, h % 3 === 0, h % 6 === 0]),
    );
  });
});
