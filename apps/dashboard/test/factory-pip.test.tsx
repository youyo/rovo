import type { OverviewDto } from "@rovo/dashboard-contract";
import { overviewFixture } from "@rovo/dashboard-contract/fixtures";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import FactoryPanel from "../src/factory-panel";
import { saveFactoryPref } from "../src/factory-prefs";
import { overviewKeepAlive } from "../src/poller";
import { inJa } from "./lang";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * 工場の帯の「小窓で表示」（Document Picture-in-Picture。docs/specs/dashboard-factory.md の「小窓」）。
 * jsdom には documentPictureInPicture が無いので、requestWindow を差し替え、別の document を持つ iframe の window を小窓として返す。
 */

const roots: { unmount: () => void }[] = [];
beforeEach(() => {
  localStorage.clear();
  vi.stubGlobal("innerWidth", 1440);
  vi.stubGlobal("innerHeight", 1600);
  // 元の文書のスタイルシート（本体と、遅延チャンクの factory-panel の CSS）。アイコンの link は写さない
  for (const [rel, href] of [
    ["stylesheet", "/dashboard/assets/index-abc.css"],
    ["stylesheet", "/dashboard/assets/factory-panel-xyz.css"],
    ["icon", "/assets/brand/rovo-mark-small.svg"],
  ] as const) {
    const l = document.createElement("link");
    l.rel = rel;
    l.href = href;
    document.head.append(l);
  }
});
afterEach(() => {
  for (const r of roots.splice(0)) act(() => r.unmount());
  document.body.innerHTML = "";
  for (const l of document.head.querySelectorAll("link")) l.remove();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  overviewKeepAlive.set(null);
  localStorage.clear();
});

type PipWin = Window & typeof globalThis;

/** 小窓の代わり（別の document を持つ iframe の window）。close は本物と同じく pagehide を出す */
function stubPip() {
  const frame = document.createElement("iframe");
  document.body.append(frame);
  const win = frame.contentWindow as PipWin;
  const close = vi.fn(() => {
    win.dispatchEvent(new win.Event("pagehide"));
  });
  win.close = close;
  const requestWindow = vi.fn(async (_opts?: { width?: number; height?: number }) => win);
  vi.stubGlobal("documentPictureInPicture", { requestWindow });
  return { win, doc: win.document, close, requestWindow };
}

function stubNarrow(narrow: boolean) {
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: narrow && query.includes("max-width: 720px"),
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
  }));
}

function mount(opts: { onSelect?: (id: string) => void; stale?: boolean } = {}) {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  const outer = vi.fn();
  const draw = (data: OverviewDto, stale = opts.stale ?? false) =>
    act(() =>
      root.render(
        inJa(
          // 一覧側の親の onClick（小窓の中のクリックが React の木を伝って届いてはいけない）
          createElement(
            "div",
            { onClick: outer },
            createElement(FactoryPanel, { data, onSelect: opts.onSelect, stale }),
          ),
        ),
      ),
    );
  draw(overviewFixture);
  return { container, outer, draw, root };
}

const settle = async () => {
  for (let i = 0; i < 20; i++) await act(async () => await new Promise((r) => setTimeout(r, 0)));
};

const pipButton = (c: Element) =>
  c.querySelector("button[data-factory-pip]") as HTMLButtonElement | null;
const backButton = (c: Element) =>
  c.querySelector("button[data-factory-pip-back]") as HTMLButtonElement | null;

/** 小窓に写した link の load を出す（描くのは load の後） */
const loadLinks = (pip: ReturnType<typeof stubPip>) =>
  act(() => {
    for (const l of pip.doc.head.querySelectorAll("link")) l.dispatchEvent(new pip.win.Event("load"));
  });

async function openPip(c: Element, pip: ReturnType<typeof stubPip>) {
  act(() => pipButton(c)?.click());
  await settle();
  loadLinks(pip);
  await settle();
}

describe("小窓で表示のボタン（documentPictureInPicture があるときだけ）", () => {
  it("API があれば、見出しの行（たたむボタンの隣）に「小窓で表示」を出す", () => {
    stubPip();
    const { container } = mount();
    const btn = pipButton(container);
    expect(btn?.textContent).toBe("小窓で表示");
    expect(btn?.getAttribute("title")).toBeTruthy();
    expect(btn?.closest(".fxband-bar")?.querySelector("button[data-factory-toggle]")).not.toBeNull();
  });

  it("API が無いブラウザ（Safari・Firefox）では出さない", () => {
    expect("documentPictureInPicture" in window).toBe(false);
    const { container } = mount();
    expect(pipButton(container)).toBeNull();
  });

  it("狭い幅（720px 以下）では出さない", () => {
    stubPip();
    stubNarrow(true);
    const { container } = mount();
    expect(pipButton(container)).toBeNull();
  });
});

describe("小窓を開く", () => {
  it("押すとクリックの中で requestWindow を呼び、小窓の head に link を絶対 URL で写し（style 要素は作らない）、load の後に断面図を描く。元の帯は「小窓で表示中」の 1 行", async () => {
    const pip = stubPip();
    const { container } = mount();
    act(() => pipButton(container)?.click());
    // ユーザーの操作の中で最初に呼ぶ（await の後ではない）
    expect(pip.requestWindow).toHaveBeenCalledTimes(1);
    await settle();

    const hrefs = [...pip.doc.head.querySelectorAll("link")].map((l) => ({
      rel: l.getAttribute("rel"),
      href: l.getAttribute("href"),
    }));
    expect(hrefs).toEqual([
      { rel: "stylesheet", href: new URL("/dashboard/assets/index-abc.css", location.href).href },
      {
        rel: "stylesheet",
        href: new URL("/dashboard/assets/factory-panel-xyz.css", location.href).href,
      },
    ]);
    expect(pip.doc.querySelector("style")).toBeNull();
    // link を読み終えるまでは描かない
    expect(pip.doc.body.querySelector("[data-task]")).toBeNull();

    // 元の帯は「小窓で表示中」と「戻す」の 1 行（断面図・たたむボタンは出さない）
    const note = container.querySelector("[data-factory-pip-on]");
    expect(note?.textContent).toBe("小窓で表示中");
    expect(backButton(container)?.textContent).toBe("戻す");
    expect(container.querySelector(".fx-stage")).toBeNull();
    expect(container.querySelector("button[data-factory-toggle]")).toBeNull();
    expect(pipButton(container)).toBeNull();

    loadLinks(pip);
    await settle();
    expect(pip.doc.body.querySelector(".fx-stage svg.fx-svg")).not.toBeNull();
    expect(pip.doc.body.querySelectorAll("a[data-task]").length).toBeGreaterThan(0);
    // 小窓の中も style 属性・style 要素を作らない（CSP の style-src 'self'）
    expect(pip.doc.querySelector("[style]")).toBeNull();
    expect(pip.doc.querySelector("style")).toBeNull();
    expect(container.querySelector("[data-task]")).toBeNull();
  });

  it("小窓の pagehide（利用者が閉じた）で元の表示に戻る", async () => {
    const pip = stubPip();
    const { container } = mount();
    await openPip(container, pip);
    act(() => pip.win.dispatchEvent(new pip.win.Event("pagehide")));
    expect(container.querySelector("[data-factory-pip-on]")).toBeNull();
    expect(container.querySelector(".fx-stage svg.fx-svg")).not.toBeNull();
    expect(pipButton(container)).not.toBeNull();
    expect(pip.doc.body.querySelector("[data-task]")).toBeNull();
  });

  it("「戻す」は小窓を閉じ、元の表示に戻す", async () => {
    const pip = stubPip();
    const { container } = mount();
    await openPip(container, pip);
    act(() => backButton(container)?.click());
    expect(pip.close).toHaveBeenCalledTimes(1);
    expect(container.querySelector("[data-factory-pip-on]")).toBeNull();
    expect(container.querySelector(".fx-stage svg.fx-svg")).not.toBeNull();
  });

  it("帯が消えたら（一覧の読み込み直しなど）小窓も閉じる", async () => {
    const pip = stubPip();
    const { container, root } = mount();
    await openPip(container, pip);
    act(() => root.render(null));
    expect(pip.close).toHaveBeenCalled();
    expect(overviewKeepAlive.active()).toBe(false);
  });

  it("requestWindow が断られても、帯はそのまま（ボタンも残る）", async () => {
    const requestWindow = vi.fn(async () => {
      throw new Error("NotAllowedError");
    });
    vi.stubGlobal("documentPictureInPicture", { requestWindow });
    const { container } = mount();
    act(() => pipButton(container)?.click());
    await settle();
    expect(requestWindow).toHaveBeenCalledTimes(1);
    expect(pipButton(container)).not.toBeNull();
    expect(container.querySelector(".fx-stage svg.fx-svg")).not.toBeNull();
  });

  it("たたんだ帯からも開ける（小窓は断面図）", async () => {
    saveFactoryPref("collapsed");
    const pip = stubPip();
    const { container } = mount();
    await openPip(container, pip);
    expect(pip.doc.body.querySelector(".fx-stage svg.fx-svg")).not.toBeNull();
    expect(container.querySelector("[data-factory-summary]")).toBeNull();
  });
});

describe("小窓の中の Rovo", () => {
  it("押すと、同期的に opener の window.focus() を呼び、そのタスクを選ぶ。一覧側の親の onClick には届かない", async () => {
    const order: string[] = [];
    const onSelect = vi.fn((id: string) => void order.push(`select:${id}`));
    const focus = vi.spyOn(window, "focus").mockImplementation(() => void order.push("focus"));
    const pip = stubPip();
    const { container, outer } = mount({ onSelect });
    await openPip(container, pip);
    const a = pip.doc.body.querySelector("a[data-task]") as Element;
    const id = a.getAttribute("data-task") as string;
    const ev = new pip.win.MouseEvent("click", { bubbles: true, cancelable: true, button: 0 });
    act(() => void a.dispatchEvent(ev));
    expect(focus).toHaveBeenCalledTimes(1);
    expect(onSelect).toHaveBeenCalledWith(id);
    expect(order).toEqual(["focus", `select:${id}`]);
    // ページ（小窓）を読み直さない
    expect(ev.defaultPrevented).toBe(true);
    expect(outer).not.toHaveBeenCalled();
  });

  it("focus に失敗しても選ぶ（focus の成否に選択を依存させない）", async () => {
    const onSelect = vi.fn();
    vi.spyOn(window, "focus").mockImplementation(() => {
      throw new Error("blocked");
    });
    const pip = stubPip();
    const { container } = mount({ onSelect });
    await openPip(container, pip);
    const a = pip.doc.body.querySelector("a[data-task]") as Element;
    act(
      () =>
        void a.dispatchEvent(
          new pip.win.MouseEvent("click", { bubbles: true, cancelable: true, button: 0 }),
        ),
    );
    expect(onSelect).toHaveBeenCalledWith(a.getAttribute("data-task"));
  });
});

describe("小窓と一覧の自動更新（overviewKeepAlive）", () => {
  it("開いている間は、小窓の文書が visible なら hidden でも続ける条件が立つ。小窓の visibilitychange で再評価を知らせ、閉じれば条件を外す", async () => {
    const pip = stubPip();
    const { container } = mount();
    expect(overviewKeepAlive.active()).toBe(false);
    act(() => pipButton(container)?.click());
    await settle();
    expect(overviewKeepAlive.active()).toBe(true);

    const notified = vi.fn();
    const off = overviewKeepAlive.subscribe(notified);
    Object.defineProperty(pip.doc, "visibilityState", { value: "hidden", configurable: true });
    act(() => void pip.doc.dispatchEvent(new pip.win.Event("visibilitychange")));
    expect(notified).toHaveBeenCalled();
    expect(overviewKeepAlive.active()).toBe(false);
    Object.defineProperty(pip.doc, "visibilityState", { value: "visible", configurable: true });
    expect(overviewKeepAlive.active()).toBe(true);

    notified.mockClear();
    act(() => pip.win.dispatchEvent(new pip.win.Event("pagehide")));
    expect(notified).toHaveBeenCalled();
    expect(overviewKeepAlive.active()).toBe(false);
    off();
  });
});

describe("小窓の古さの表示（止まった絵を新しいと誤解させない）", () => {
  it("最後に更新に成功してから 30 秒以上で「更新なし」、通信エラーで「通信エラー」。新しいデータが届くと消える", async () => {
    let now = Date.parse("2026-10-21T05:00:00Z");
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const pip = stubPip();
    const { container, draw } = mount();
    await openPip(container, pip);
    const status = () => pip.doc.body.querySelector("[data-pip-stale]");
    expect(status()).toBeNull();

    now += 29_000;
    draw(overviewFixture);
    expect(status()).toBeNull();

    now += 2_000;
    draw(overviewFixture);
    expect(status()?.getAttribute("data-pip-stale")).toBe("old");
    expect(status()?.textContent).toContain("更新なし");
    expect(status()?.getAttribute("title")).toBeTruthy();

    draw(overviewFixture, true);
    expect(status()?.getAttribute("data-pip-stale")).toBe("error");
    expect(status()?.textContent).toContain("通信エラー");

    // 次の取得に成功（新しいデータ）
    draw({ ...overviewFixture }, false);
    await settle();
    expect(status()).toBeNull();
  });
});
