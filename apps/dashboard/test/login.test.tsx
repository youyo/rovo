import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../src/app";
import { loginErrorMessage } from "../src/login-error";
import { LoginView } from "../src/login-view";
import { LANG_KEY } from "../src/prefs";
import { inJa, tJa } from "./lang";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const ID = "01JZ0000000000000000000000";
const LOGIN = "/dashboard/auth/login";

describe("LoginView（未ログインの画面）", () => {
  const render = (props: Partial<Parameters<typeof LoginView>[0]> = {}) =>
    renderToStaticMarkup(
      inJa(
        createElement(LoginView, {
          variant: "signed-out",
          taskDetail: false,
          loginHref: LOGIN,
          message: null,
          ...props,
        }),
      ),
    );

  it("ロゴ（固定の src・class brand-mark）・見出し・説明・ログインのリンク・補足を出す", () => {
    const html = render();
    expect(html).toContain('src="/dashboard/assets/brand/rovo-mark.svg"');
    expect(html).toMatch(/<img[^>]*class="[^"]*brand-mark/);
    expect(html).toContain("<h1");
    expect(html).toContain("Rovo ダッシュボード");
    expect(html).toContain(
      "ログインすると、自分とチームのタスクの進み具合・ログ・費用を見られます。",
    );
    expect(html).toMatch(new RegExp(`<a[^>]*href="${LOGIN}"[^>]*>`));
    expect(html).toContain("GitHub でログイン");
    expect(html).toContain("許可された GitHub のアカウント・組織だけがログインできます。");
    expect(html).toContain("<svg"); // GitHub のマーク（inline）
    expect(html).not.toContain("再読み込み");
    expect(html).not.toMatch(/\sstyle=|<style/i);
  });

  it("リンクの href は渡された loginHref（タスク詳細なら return_to 付き）", () => {
    const href = `${LOGIN}?return_to=${encodeURIComponent(`/dashboard/tasks/${ID}`)}`;
    const html = render({ loginHref: href });
    expect(html).toContain(`href="${href.replace(/&/g, "&amp;")}"`);
  });

  it("タスク詳細の URL では説明の文が変わる", () => {
    const html = render({ taskDetail: true });
    expect(html).toContain("ログインすると、このタスクの詳細を見られます。");
    expect(html).not.toContain("自分とチームのタスク");
  });

  it("error: 確認できなかった旨・再読み込みのボタン・ログインのリンクを出す", () => {
    const html = render({ variant: "error" });
    expect(html).toContain("ログインの状態を確認できませんでした。");
    expect(html).toMatch(/<button[^>]*>再読み込み<\/button>/);
    expect(html).toContain(`href="${LOGIN}"`);
  });

  it("message（ログイン失敗の文）は alert として文字で出る", () => {
    const html = render({ message: "<b>x</b>" });
    expect(html).toMatch(/role="alert"/);
    expect(html).toContain("&lt;b&gt;x&lt;/b&gt;");
  });
});

describe("loginErrorMessage（login_error の許可リスト）", () => {
  it("3 種は日本語の文に引く", () => {
    expect(loginErrorMessage("denied", tJa)).toBe(
      "このアカウントはログインを許可されていません。管理者に確認してください。",
    );
    expect(loginErrorMessage("invalid", tJa)).toBe(
      "ログインの手順が途中で切れました。もう一度ログインしてください。",
    );
    expect(loginErrorMessage("unavailable", tJa)).toBe(
      "GitHub に接続できませんでした。少し待ってからもう一度お試しください。",
    );
  });

  it("未知の値・空・null・Object のプロパティ名は無視する", () => {
    for (const v of ["x", "", null, "__proto__", "constructor", "toString", "DENIED", "denied "]) {
      expect(loginErrorMessage(v, tJa), String(v)).toBeNull();
    }
  });
});

describe("App（未ログインの画面・jsdom）", () => {
  const roots: { unmount: () => void }[] = [];
  // 言語は日本語で描く（既定は英語。保存された言語を読む）
  beforeEach(() => localStorage.setItem(LANG_KEY, "ja"));
  afterEach(() => {
    for (const r of roots.splice(0)) act(() => r.unmount());
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    document.body.innerHTML = "";
    history.replaceState(null, "", "/");
  });

  const json = (status: number, body?: unknown) =>
    new Response(body === undefined ? null : JSON.stringify(body), { status });

  async function mount(url: string, me: () => Promise<Response>) {
    history.replaceState(null, "", url);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => me()),
    );
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    roots.push(root);
    await act(async () => {
      root.render(createElement(App));
    });
    return container;
  }

  const signedOut = async () => json(401, { error: "unauthorized" });

  it("未ログイン: ロゴ・見出し・ボタンが出て、ヘッダに重複のログインリンクは無い", async () => {
    const c = await mount("/dashboard/", signedOut);
    expect(c.querySelector("h1")?.textContent).toBe("Rovo ダッシュボード");
    expect(c.querySelector('img[src="/dashboard/assets/brand/rovo-mark.svg"]')).not.toBeNull();
    const links = [...c.querySelectorAll("a")].filter((a) =>
      a.textContent?.includes("GitHub でログイン"),
    );
    expect(links).toHaveLength(1);
    expect(links[0]?.getAttribute("href")).toBe(LOGIN);
    expect(c.querySelector("header a")).toBeNull();
    expect(c.textContent).toContain("自分とチームのタスクの進み具合・ログ・費用");
  });

  it("タスク詳細の URL: 文が変わり、リンクは return_to 付き", async () => {
    const c = await mount(`/dashboard/tasks/${ID}`, signedOut);
    expect(c.textContent).toContain("ログインすると、このタスクの詳細を見られます。");
    expect(c.querySelector("main a")?.getAttribute("href")).toBe(
      `${LOGIN}?return_to=${encodeURIComponent(`/dashboard/tasks/${ID}`)}`,
    );
  });

  it("loading の間は見出しもボタンも出さない（チラつかせない）", async () => {
    history.replaceState(null, "", "/dashboard/");
    vi.stubGlobal(
      "fetch",
      vi.fn(() => new Promise<Response>(() => {})),
    );
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    roots.push(root);
    await act(async () => {
      root.render(createElement(App));
    });
    expect(container.querySelector("h1")).toBeNull();
    expect(container.textContent).not.toContain("GitHub でログイン");
  });

  it("error（確認できなかった）: 文・再読み込みのボタン・ログインのリンクを出す", async () => {
    const c = await mount("/dashboard/", async () => json(503, { error: "x" }));
    expect(c.textContent).toContain("ログインの状態を確認できませんでした。");
    expect(c.querySelector('a[href="/dashboard/auth/login"]')).not.toBeNull();
    expect([...c.querySelectorAll("button")].some((b) => b.textContent === "再読み込み")).toBe(
      true,
    );
    expect(c.querySelector("header a")).toBeNull();
  });

  it("LoginView の再読み込みボタンは onReload を呼ぶ", async () => {
    const onReload = vi.fn();
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    roots.push(root);
    await act(async () => {
      root.render(
        inJa(
          createElement(LoginView, {
            variant: "error",
            taskDetail: false,
            loginHref: LOGIN,
            message: null,
            onReload,
          }),
        ),
      );
    });
    await act(async () => {
      container.querySelector("button")?.click();
    });
    expect(onReload).toHaveBeenCalledOnce();
  });

  it("?login_error=denied|invalid|unavailable は日本語の文を出し、replaceState でクエリを消す", async () => {
    for (const [code, text] of [
      ["denied", "このアカウントはログインを許可されていません。管理者に確認してください。"],
      ["invalid", "ログインの手順が途中で切れました。もう一度ログインしてください。"],
      ["unavailable", "GitHub に接続できませんでした。少し待ってからもう一度お試しください。"],
    ] as const) {
      const spy = vi.spyOn(history, "replaceState");
      const c = await mount(`/dashboard/?login_error=${code}`, signedOut);
      expect(c.querySelector('[role="alert"]')?.textContent, code).toContain(text);
      expect(spy).toHaveBeenCalled();
      expect(location.search, code).toBe("");
      expect(location.pathname).toBe("/dashboard/");
      for (const r of roots.splice(0)) act(() => r.unmount());
      document.body.innerHTML = "";
      spy.mockRestore();
    }
  });

  it("未知の login_error は画面に出さない（値をそのまま出さない）。クエリは消す。ほかのクエリは残す", async () => {
    const c = await mount("/dashboard/?login_error=<img src=x>&day=2026-10-01", signedOut);
    expect(c.querySelector('[role="alert"]')).toBeNull();
    expect(c.textContent).not.toContain("<img");
    expect(c.textContent).not.toContain("login_error");
    expect(location.search).toBe("?day=2026-10-01");
  });

  it("task 詳細の URL に付いた login_error も消しても、パスは変えない", async () => {
    await mount(`/dashboard/tasks/${ID}?login_error=denied`, signedOut);
    expect(location.pathname).toBe(`/dashboard/tasks/${ID}`);
    expect(location.search).toBe("");
  });
});
