import {
  overviewFixture,
  taskDetailRunningFixture,
  taskEventsFixture,
} from "@rovo/dashboard-contract/fixtures";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../src/app";
import { Header } from "../src/header";
import { LANG_KEY } from "../src/prefs";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const json = (status: number, body?: unknown) =>
  new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

const roots: { unmount: () => void }[] = [];
let store: Map<string, string>;
let failStorage = false;

beforeEach(() => {
  store = new Map();
  failStorage = false;
  vi.stubGlobal("localStorage", {
    getItem: (k: string) => {
      if (failStorage) throw new Error("denied");
      return store.get(k) ?? null;
    },
    setItem: (k: string, v: string) => {
      if (failStorage) throw new Error("denied");
      store.set(k, v);
    },
  });
});
afterEach(() => {
  for (const r of roots.splice(0)) act(() => r.unmount());
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
  document.documentElement.lang = "en";
  history.replaceState(null, "", "/");
});

async function mount(signedIn: boolean) {
  const id = taskDetailRunningFixture.task.task_id;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input), "http://localhost");
      if (url.pathname === "/dashboard/api/me") {
        return signedIn ? json(200, { login: "alice-example" }) : json(401, { error: "x" });
      }
      if (url.pathname === "/dashboard/api/overview") return json(200, overviewFixture);
      if (url.pathname === `/dashboard/api/tasks/${id}`) return json(200, taskDetailRunningFixture);
      if (url.pathname === `/dashboard/api/tasks/${id}/events`) return json(200, taskEventsFixture);
      return json(404, { error: "not_found" });
    }),
  );
  history.replaceState(null, "", "/dashboard/");
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  await act(async () => {
    root.render(createElement(App));
  });
  return container;
}

const langButton = (c: HTMLElement, label: string) =>
  [...c.querySelectorAll<HTMLButtonElement>("header .lang button")].find(
    (b) => b.textContent === label,
  ) as HTMLButtonElement;

describe("言語の切り替え（App）", () => {
  it("何も保存していなければ英語で出る。html の lang も title も英語", async () => {
    const c = await mount(true);
    expect(c.querySelector(".seg")?.textContent).toContain("My tasks");
    expect(c.querySelector(".seg")?.textContent).toContain("Team");
    expect(c.textContent).not.toContain("マイタスク");
    expect(document.documentElement.lang).toBe("en");
    expect(document.title).toBe("Rovo Dashboard");
    expect(langButton(c, "EN").getAttribute("aria-pressed")).toBe("true");
    expect(langButton(c, "日本語").getAttribute("aria-pressed")).toBe("false");
  });

  it("日本語を押すと文言・html の lang・title が変わり、localStorage に保存される", async () => {
    const c = await mount(true);
    await act(async () => {
      langButton(c, "日本語").click();
    });
    expect(c.querySelector(".seg")?.textContent).toContain("マイタスク");
    expect(c.textContent).not.toContain("My tasks");
    expect(document.documentElement.lang).toBe("ja");
    expect(document.title).toBe("Rovo ダッシュボード");
    expect(store.get(LANG_KEY)).toBe("ja");
    expect(langButton(c, "日本語").getAttribute("aria-pressed")).toBe("true");
    // 英語へ戻す
    await act(async () => {
      langButton(c, "EN").click();
    });
    expect(c.querySelector(".seg")?.textContent).toContain("My tasks");
    expect(document.documentElement.lang).toBe("en");
    expect(store.get(LANG_KEY)).toBe("en");
  });

  it("保存された言語（ja）で始まる。次回の起動でも同じ", async () => {
    store.set(LANG_KEY, "ja");
    const c = await mount(true);
    expect(c.querySelector(".seg")?.textContent).toContain("マイタスク");
    expect(document.documentElement.lang).toBe("ja");
    expect(document.title).toBe("Rovo ダッシュボード");
  });

  it("未知の保存値は英語", async () => {
    store.set(LANG_KEY, "fr");
    const c = await mount(true);
    expect(c.querySelector(".seg")?.textContent).toContain("My tasks");
    expect(document.documentElement.lang).toBe("en");
  });

  it("localStorage が使えなくても動く（英語で始まり、切り替えは画面の中で効く）", async () => {
    failStorage = true;
    const c = await mount(true);
    expect(c.querySelector(".seg")?.textContent).toContain("My tasks");
    await act(async () => {
      langButton(c, "日本語").click();
    });
    expect(c.querySelector(".seg")?.textContent).toContain("マイタスク");
    expect(document.documentElement.lang).toBe("ja");
  });

  it("未ログインのログイン画面でも切り替えられる（ヘッダに出る）", async () => {
    const c = await mount(false);
    expect(c.querySelector("h1")?.textContent).toBe("Rovo Dashboard");
    expect(c.textContent).toContain("Sign in with GitHub");
    await act(async () => {
      langButton(c, "日本語").click();
    });
    expect(c.querySelector("h1")?.textContent).toBe("Rovo ダッシュボード");
    expect(c.textContent).toContain("GitHub でログイン");
    expect(store.get(LANG_KEY)).toBe("ja");
  });

  it("切り替えのボタンは 2 つで、押している方が aria-pressed。グループに名前がある", async () => {
    const c = await mount(true);
    const group = c.querySelector("header .lang");
    expect(group?.getAttribute("aria-label")).toBe("Language");
    expect(group?.querySelectorAll("button")).toHaveLength(2);
    expect(langButton(c, "日本語").getAttribute("lang")).toBe("ja");
  });
});

describe("Header 単体（Provider なし）", () => {
  it("Provider が無いときは英語で描く", () => {
    const html = renderToStaticMarkup(
      createElement(Header, { summary: null, scope: "me", onScopeChange: () => {} }, null),
    );
    expect(html).toContain("My tasks");
    expect(html).toContain("日本語");
  });
});
