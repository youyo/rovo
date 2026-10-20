import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { App } from "../src/app";
import { AuthView } from "../src/auth-view";
import { fetchMe, loginHref, logout } from "../src/session";

// React の act() を使うテスト環境の宣言
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function response(status: number, body?: unknown): Response {
  return new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: body === undefined ? {} : { "content-type": "application/json" },
  });
}

describe("fetchMe（GET /dashboard/api/me）", () => {
  it("200 {login} なら signed-in", async () => {
    const f = vi.fn(async () => response(200, { login: "alice" }));
    expect(await fetchMe(f as unknown as typeof fetch)).toEqual({
      state: "signed-in",
      login: "alice",
    });
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/dashboard/api/me");
    expect(init.credentials).toBe("same-origin");
  });

  it("401 なら signed-out", async () => {
    const f = vi.fn(async () => response(401, { error: "unauthorized" }));
    expect(await fetchMe(f as unknown as typeof fetch)).toEqual({ state: "signed-out" });
  });

  it("403・503・ネットワークエラー・壊れた本文は error（ログイン済みとは見なさない）", async () => {
    for (const f of [
      async () => response(403, { error: "forbidden" }),
      async () => response(503, { error: "unavailable" }),
      async () => {
        throw new TypeError("network");
      },
      async () => response(200, { nope: 1 }),
      async () => new Response("not json", { status: 200 }),
    ]) {
      expect(await fetchMe(f as unknown as typeof fetch)).toEqual({ state: "error" });
    }
  });
});

describe("logout（POST /dashboard/api/logout）", () => {
  it("同じ origin に POST し、204 なら true", async () => {
    const f = vi.fn(async () => response(204));
    expect(await logout(f as unknown as typeof fetch)).toBe(true);
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/dashboard/api/logout");
    expect(init.method).toBe("POST");
    expect(init.credentials).toBe("same-origin");
  });

  it("失敗（403・ネットワークエラー）は false", async () => {
    expect(await logout((async () => response(403)) as unknown as typeof fetch)).toBe(false);
    expect(
      await logout((async () => {
        throw new TypeError("network");
      }) as unknown as typeof fetch),
    ).toBe(false);
  });
});

describe("loginHref（ログイン後の戻り先）", () => {
  it("タスク詳細のパスなら return_to に付ける。それ以外は付けない（サーバー側でも検証する）", () => {
    const id = "01JZ0000000000000000000000";
    expect(loginHref(`/dashboard/tasks/${id}`)).toBe(
      `/dashboard/auth/login?return_to=${encodeURIComponent(`/dashboard/tasks/${id}`)}`,
    );
    for (const path of ["/dashboard/", "/dashboard", "//evil.com", "https://evil.com", "/x"]) {
      expect(loginHref(path), path).toBe("/dashboard/auth/login");
    }
  });
});

describe("AuthView", () => {
  it("未ログイン: 「GitHub でログイン」のリンク（/dashboard/auth/login）だけを出す", () => {
    const html = renderToStaticMarkup(
      createElement(AuthView, {
        auth: { state: "signed-out" },
        loginHref: "/dashboard/auth/login",
      }),
    );
    expect(html).toContain('href="/dashboard/auth/login"');
    expect(html).toContain("GitHub でログイン");
    expect(html).not.toContain("ログアウト");
  });

  it("ログイン済み: login とログアウトのボタンを出す。login は文字として出力される（HTML を解釈しない）", () => {
    const html = renderToStaticMarkup(
      createElement(AuthView, {
        auth: { state: "signed-in", login: "<img src=x onerror=alert(1)>" },
        loginHref: "/dashboard/auth/login",
        onLogout: () => {},
      }),
    );
    expect(html).toContain("ログアウト");
    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;img");
    expect(html).not.toContain("GitHub でログイン");
  });

  it("読み込み中・エラー: ログイン済みの表示にならない", () => {
    const loading = renderToStaticMarkup(
      createElement(AuthView, { auth: { state: "loading" }, loginHref: "/dashboard/auth/login" }),
    );
    expect(loading).not.toContain("ログアウト");
    const error = renderToStaticMarkup(
      createElement(AuthView, { auth: { state: "error" }, loginHref: "/dashboard/auth/login" }),
    );
    expect(error).not.toContain("ログアウト");
    expect(error).toContain("GitHub でログイン"); // 再試行の導線
  });

  it("style 要素とマークアップの style 属性を作らない（CSP の style-src 'self'）", () => {
    for (const auth of [
      { state: "loading" },
      { state: "signed-out" },
      { state: "error" },
      { state: "signed-in", login: "a" },
    ] as const) {
      const html = renderToStaticMarkup(
        createElement(AuthView, { auth, loginHref: "/dashboard/auth/login", onLogout: () => {} }),
      );
      expect(html).not.toMatch(/<style/i);
      expect(html).not.toMatch(/\sstyle=/i);
    }
  });
});

describe("App（jsdom）", () => {
  const roots: { unmount: () => void }[] = [];
  afterEach(() => {
    for (const r of roots.splice(0)) act(() => r.unmount());
    vi.unstubAllGlobals();
    document.body.innerHTML = "";
  });

  async function mount(fetchImpl: typeof fetch) {
    vi.stubGlobal("fetch", fetchImpl);
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    roots.push(root);
    await act(async () => {
      root.render(createElement(App));
    });
    return container;
  }

  it("未ログイン（401）ならログインのリンク、ログイン済みなら login とログアウト。ログアウトで未ログインに戻る", async () => {
    let signedIn = true;
    const f = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === "/dashboard/api/me") {
        return signedIn
          ? response(200, { login: "alice" })
          : response(401, { error: "unauthorized" });
      }
      if (url === "/dashboard/api/logout" && init?.method === "POST") {
        signedIn = false;
        return response(204);
      }
      return response(404);
    });
    const container = await mount(f as unknown as typeof fetch);
    expect(container.textContent).toContain("alice");
    const button = [...container.querySelectorAll("button")].find((b) =>
      b.textContent?.includes("ログアウト"),
    );
    expect(button).toBeTruthy();
    await act(async () => {
      button?.click();
    });
    expect(container.textContent).not.toContain("alice");
    const link = container.querySelector("a");
    expect(link?.getAttribute("href")).toBe("/dashboard/auth/login");
    expect(link?.textContent).toContain("GitHub でログイン");
  });
});
