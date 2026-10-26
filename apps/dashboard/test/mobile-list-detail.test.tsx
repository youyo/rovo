import type { OverviewDto, TaskDetailDto, WaitingDto } from "@rovo/dashboard-contract";
import {
  overviewFixture,
  taskDetailRunningFixture,
  taskEventsFixture,
  waitingFixture,
  waitingMeFixture,
} from "@rovo/dashboard-contract/fixtures";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../src/app";
import { LANG_KEY } from "../src/prefs";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const RUNNING_ID = taskDetailRunningFixture.task.task_id;
const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const roots: { unmount: () => void }[] = [];
let store: Map<string, string>;
beforeEach(() => {
  stubNarrow(true);
  vi.stubGlobal("scrollTo", vi.fn());
  store = new Map([[LANG_KEY, "ja"]]);
  vi.stubGlobal("localStorage", {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
  });
});
afterEach(() => {
  for (const r of roots.splice(0)) act(() => r.unmount());
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
  history.replaceState(null, "", "/");
});

/** 720px 以下を再現する matchMedia */
function stubNarrow(narrow: boolean) {
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: narrow && query.includes("max-width: 720px"),
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
  }));
}

const settle = async () => {
  for (let i = 0; i < 30; i++) await Promise.resolve();
};

type Opts = {
  overview?: (url: URL) => OverviewDto;
  detailOf?: (id: string) => TaskDetailDto | null;
  waiting?: (url: URL) => WaitingDto;
};

async function mount(path: string, opts: Opts = {}) {
  history.replaceState(null, "", path);
  const f = vi.fn(async (input: RequestInfo | URL) => {
    const url = new URL(String(input), "http://localhost");
    if (url.pathname === "/dashboard/api/me") return json(200, { login: "alice-example" });
    if (url.pathname === "/dashboard/api/overview") {
      const o = opts.overview?.(url);
      return json(
        200,
        o ?? {
          ...overviewFixture,
          scope: url.searchParams.get("scope") === "me" ? "me" : "all",
        },
      );
    }
    if (url.pathname === "/dashboard/api/waiting") {
      const w = opts.waiting?.(url);
      return json(
        200,
        w ?? (url.searchParams.get("scope") === "me" ? waitingMeFixture : waitingFixture),
      );
    }
    const m = /^\/dashboard\/api\/tasks\/([^/]+)(\/events)?$/.exec(url.pathname);
    if (m) {
      const id = m[1] as string;
      const detail = opts.detailOf
        ? opts.detailOf(id)
        : id === RUNNING_ID
          ? taskDetailRunningFixture
          : null;
      if (detail === null) return json(404, { error: "not_found" });
      return m[2] ? json(200, taskEventsFixture) : json(200, detail);
    }
    return json(404, { error: "not_found" });
  });
  vi.stubGlobal("fetch", f);
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  await act(async () => {
    root.render(createElement(App));
    await settle();
  });
  return { c: container, f };
}

const text = (e: Element | null) => e?.textContent ?? "";

const click = async (el: Element) => {
  await act(async () => {
    el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 }));
    await settle();
  });
};

describe("モバイル幅: 一覧と詳細の切り替え", () => {
  it("一覧（/dashboard）: レールだけで、マイタスクでも詳細を自動選択しない", async () => {
    const { c, f } = await mount("/dashboard/");
    expect(c.querySelector("nav.rail")).not.toBeNull();
    expect(c.querySelector(".console")).toBeNull();
    expect(c.querySelector("button.back-to-list")).toBeNull();
    expect(f.mock.calls.some((x) => String(x[0]).includes("/tasks/"))).toBe(false);
  });

  it("一覧（チーム）: レールの下にチームボード", async () => {
    const { c } = await mount("/dashboard/");
    const b = [...c.querySelectorAll("fieldset.seg button")].find(
      (x) => x.textContent === "チーム",
    ) as HTMLButtonElement;
    await act(async () => {
      b.click();
      await settle();
    });
    expect(c.querySelector("nav.rail")).not.toBeNull();
    expect(c.querySelector("[data-teamboard]")).not.toBeNull();
  });

  it("行を押すと詳細だけになり、「← 一覧」がある。レールとタイムライン帯は出ない", async () => {
    const { c } = await mount("/dashboard/");
    await click(c.querySelector(`a.rail-row[data-task-id="${RUNNING_ID}"]`) as Element);
    expect(location.pathname).toBe(`/dashboard/tasks/${RUNNING_ID}`);
    expect(text(c.querySelector(".console h1"))).toBe(taskDetailRunningFixture.task.title);
    expect(c.querySelector("nav.rail")).toBeNull();
    expect(c.querySelector(".tlband")).toBeNull();
    expect(text(c.querySelector("button.back-to-list"))).toBe("← 一覧");
  });

  it("タスクの URL を直接開いても詳細だけ", async () => {
    const { c } = await mount(`/dashboard/tasks/${RUNNING_ID}`);
    expect(c.querySelector("nav.rail")).toBeNull();
    expect(c.querySelector(".tlband")).toBeNull();
    expect(c.querySelector("button.back-to-list")).not.toBeNull();
  });

  it("「← 一覧」は pushState で一覧の URL（?day= を保つ）へ。ブラウザの戻るで詳細に戻れる", async () => {
    const { c } = await mount(`/dashboard/tasks/${RUNNING_ID}?day=2026-10-20`);
    await click(c.querySelector("button.back-to-list") as Element);
    expect(location.pathname).toBe("/dashboard/");
    expect(location.search).toBe("?day=2026-10-20");
    expect(c.querySelector("nav.rail")).not.toBeNull();
    expect(c.querySelector(".console")).toBeNull();
    await act(async () => {
      history.back();
      await new Promise((r) => setTimeout(r, 20));
      await settle();
    });
    expect(location.pathname).toBe(`/dashboard/tasks/${RUNNING_ID}`);
    expect(c.querySelector("button.back-to-list")).not.toBeNull();
  });

  it("英語では「← Tasks」", async () => {
    store.set(LANG_KEY, "en");
    const { c } = await mount(`/dashboard/tasks/${RUNNING_ID}`);
    expect(text(c.querySelector("button.back-to-list"))).toBe("← Tasks");
  });

  it("一覧から開いた詳細の「← 一覧」は履歴を戻る（[一覧, 詳細, 一覧] と積まない）", async () => {
    const { c } = await mount("/dashboard/");
    const push = vi.spyOn(history, "pushState");
    await click(c.querySelector(`a.rail-row[data-task-id="${RUNNING_ID}"]`) as Element);
    expect(push).toHaveBeenCalledTimes(1);
    await act(async () => {
      (c.querySelector("button.back-to-list") as HTMLButtonElement).click();
      await new Promise((r) => setTimeout(r, 20));
      await settle();
    });
    expect(location.pathname).toBe("/dashboard/");
    expect(push).toHaveBeenCalledTimes(1);
    expect(c.querySelector("nav.rail")).not.toBeNull();
  });

  it("詳細に入るとページの先頭へ。一覧に戻ると直前の行が中央に出て focus される", async () => {
    const scrollIntoView = vi.fn();
    Element.prototype.scrollIntoView = scrollIntoView;
    const { c } = await mount("/dashboard/");
    await click(c.querySelector(`a.rail-row[data-task-id="${RUNNING_ID}"]`) as Element);
    expect(window.scrollTo).toHaveBeenCalledWith(0, 0);
    await act(async () => {
      (c.querySelector("button.back-to-list") as HTMLButtonElement).click();
      await new Promise((r) => setTimeout(r, 20));
      await settle();
    });
    expect(scrollIntoView).toHaveBeenCalledWith({ block: "center" });
    expect(document.activeElement).toBe(
      c.querySelector(`a.rail-row[data-task-id="${RUNNING_ID}"]`),
    );
  });

  it("詳細でスコープ（チーム）を押すと一覧へ移る", async () => {
    const { c } = await mount(`/dashboard/tasks/${RUNNING_ID}`);
    const b = [...c.querySelectorAll("fieldset.seg button")].find(
      (x) => x.textContent === "チーム",
    ) as HTMLButtonElement;
    await act(async () => {
      b.click();
      await settle();
    });
    expect(location.pathname).toBe("/dashboard/");
    expect(c.querySelector(".back-to-list")).toBeNull();
    expect(c.querySelector("nav.rail")).not.toBeNull();
  });

  it("見つからない詳細: 「← 一覧」だけで、素の「ダッシュボードに戻る」リンクは出ない", async () => {
    const { c } = await mount(`/dashboard/tasks/${RUNNING_ID}`, { detailOf: () => null });
    expect(c.querySelector("button.back-to-list")).not.toBeNull();
    expect(text(c.querySelector(".state"))).not.toContain("ダッシュボードに戻る");
  });

  it("一覧だけの画面（マイタスク）は data-narrow-list。チームはボードが続くので付けない", async () => {
    const { c } = await mount("/dashboard/");
    expect(c.querySelector(".main[data-narrow-list]")).not.toBeNull();
    const b = [...c.querySelectorAll("fieldset.seg button")].find(
      (x) => x.textContent === "チーム",
    ) as HTMLButtonElement;
    await act(async () => {
      b.click();
      await settle();
    });
    expect(c.querySelector(".main[data-narrow-list]")).toBeNull();
  });

  it("レールの所要は短い表記で、title に長い形", async () => {
    const { c } = await mount("/dashboard/");
    const t = c.querySelector("a.rail-row .rail-time") as HTMLElement;
    expect(t.textContent).toMatch(/^(\d+s|\d+:\d{2}(:\d{2})?)$/);
    expect(t.getAttribute("title")).toMatch(/[分秒時]/);
  });

  it("広い幅では従来どおり: 一覧でも詳細を自動選択し、レールと並び、戻るボタンは無い", async () => {
    stubNarrow(false);
    const { c } = await mount("/dashboard/");
    expect(c.querySelector("nav.rail")).not.toBeNull();
    expect(text(c.querySelector(".console h1"))).toBe(taskDetailRunningFixture.task.title);
    expect(c.querySelector("button.back-to-list")).toBeNull();
  });
});
