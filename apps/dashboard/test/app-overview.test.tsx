import {
  overviewFixture,
  overviewMeFixture,
  taskDetailRunningFixture,
  taskEventsFixture,
} from "@rovo/dashboard-contract/fixtures";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../src/app";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

type Handler = (url: URL) => Response | Promise<Response>;

function router(overview: Handler) {
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = new URL(String(input), "http://localhost");
    if (url.pathname === "/dashboard/api/me") return json(200, { login: "alice-example" });
    if (url.pathname === "/dashboard/api/overview") return overview(url);
    // 一覧のコンソールに出す走行中のタスク
    const id = taskDetailRunningFixture.task.task_id;
    if (url.pathname === `/dashboard/api/tasks/${id}`) return json(200, taskDetailRunningFixture);
    if (url.pathname === `/dashboard/api/tasks/${id}/events`) return json(200, taskEventsFixture);
    return json(404, { error: "not_found" });
  });
}

const byScope: Handler = (url) =>
  json(200, url.searchParams.get("scope") === "me" ? overviewMeFixture : overviewFixture);

const roots: { unmount: () => void }[] = [];
let store: Map<string, string>;

beforeEach(() => {
  store = new Map();
  vi.stubGlobal("localStorage", {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
  });
});

afterEach(() => {
  for (const r of roots.splice(0)) act(() => r.unmount());
  vi.unstubAllGlobals();
  vi.useRealTimers();
  document.body.innerHTML = "";
});

async function mount(f: ReturnType<typeof router>) {
  vi.stubGlobal("fetch", f);
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  await act(async () => {
    root.render(createElement(App));
  });
  return container;
}

const lanesOf = (c: HTMLElement) =>
  [...c.querySelectorAll("[data-lane]")].map((e) => e.getAttribute("data-lane"));
const overviewCalls = (f: ReturnType<typeof router>) =>
  f.mock.calls
    .map((c) => new URL(String(c[0]), "http://localhost"))
    .filter((u) => u.pathname === "/dashboard/api/overview");

describe("App: 一覧を実 API の形（fetch）につなぐ", () => {
  it("ログイン済みなら overview を取って一覧を出す。範囲はローカル日の 0 時〜いま、scope=all", async () => {
    const f = router(byScope);
    const c = await mount(f);
    expect(c.querySelector(".day-summary")?.textContent).toMatch(/^\d+月\d+日 +5 件/);
    expect(lanesOf(c)).toHaveLength(3);
    const u = overviewCalls(f)[0] as URL;
    expect(u.searchParams.get("scope")).toBe("all");
    const from = Number(u.searchParams.get("from"));
    const to = Number(u.searchParams.get("to"));
    expect(to - from).toBeGreaterThan(0);
    expect(to - from).toBeLessThanOrEqual(36 * 3600_000);
    const d = new Date(from);
    expect([d.getHours(), d.getMinutes(), d.getSeconds(), d.getMilliseconds()]).toEqual([
      0, 0, 0, 0,
    ]);
  });

  it("「自分」に切り替えると scope=me で取り直し、レーンが自分だけになる。「全員」で戻る", async () => {
    const f = router(byScope);
    const c = await mount(f);
    const btn = (label: string) =>
      [...c.querySelectorAll("button")].find((b) => b.textContent === label) as HTMLButtonElement;
    expect(btn("全員").getAttribute("aria-pressed")).toBe("true");
    await act(async () => {
      btn("自分").click();
    });
    expect(btn("自分").getAttribute("aria-pressed")).toBe("true");
    expect(overviewCalls(f).at(-1)?.searchParams.get("scope")).toBe("me");
    expect(lanesOf(c)).toEqual(["alice-example"]);
    await act(async () => {
      btn("全員").click();
    });
    expect(lanesOf(c)).toHaveLength(3);
  });

  it("切り替えた直後は、新しい応答が来るまで前のスコープのデータを出さない（読み込み中に戻る）", async () => {
    const f = router((url) =>
      url.searchParams.get("scope") === "me" ? new Promise<Response>(() => {}) : byScope(url),
    );
    const c = await mount(f);
    expect(lanesOf(c)).toHaveLength(3);
    const me = [...c.querySelectorAll("button")].find((b) => b.textContent === "自分");
    await act(async () => {
      me?.click();
    });
    expect(lanesOf(c)).toHaveLength(0);
    expect(c.querySelector("a.rail-row")).toBeNull();
    expect(c.textContent).toContain("読み込み中");
  });

  it("期間は今日だけ（ヘッダはその日の日付の要約。7 日・30 日のボタンを作らない）", async () => {
    const c = await mount(router(byScope));
    expect(c.querySelector(".day-summary")?.textContent).toMatch(/^\d+月\d+日/);
    expect(c.textContent).not.toContain("7 日");
    expect(c.textContent).not.toContain("30 日");
  });

  it("取得中は読み込み中の表示", async () => {
    const f = router(() => new Promise<Response>(() => {}));
    const c = await mount(f);
    expect(c.textContent).toContain("読み込み中");
  });

  it("overview が 401 ならログインのリンク（auth-view）", async () => {
    const c = await mount(router(() => json(401, { error: "unauthorized" })));
    const link = [...c.querySelectorAll("a")].find((a) =>
      a.textContent?.includes("GitHub でログイン"),
    );
    expect(link?.getAttribute("href")).toBe("/dashboard/auth/login");
  });

  it("overview が 404 なら「見られません」", async () => {
    const c = await mount(router(() => json(404, { error: "not_found" })));
    expect(c.textContent).toContain("見られません");
  });

  it("overview が 503 ならエラーの表示（再試行できる）", async () => {
    const c = await mount(router(() => json(503, { error: "unavailable" })));
    expect(c.textContent).toContain("読み込めませんでした");
    expect([...c.querySelectorAll("button")].some((b) => b.textContent === "再読み込み")).toBe(
      true,
    );
  });
});

describe("App: 自動更新（D15）", () => {
  it("5 秒ごとに取り直し、チェックを外すと止まる。状態は localStorage に残る", async () => {
    vi.useFakeTimers();
    const f = router(byScope);
    const c = await mount(f);
    expect(overviewCalls(f)).toHaveLength(1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });
    expect(overviewCalls(f)).toHaveLength(2);

    const box = c.querySelector("input[type='checkbox']") as HTMLInputElement;
    await act(async () => {
      box.click();
    });
    expect(box.checked).toBe(false);
    expect(store.size).toBe(1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });
    expect(overviewCalls(f)).toHaveLength(2);
  });

  it("保存済みの「切」を読んで、最初の 1 回だけ取って止まる", async () => {
    vi.useFakeTimers();
    store.set("rovo.dashboard.autoRefresh", "0");
    const f = router(byScope);
    await mount(f);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });
    expect(overviewCalls(f)).toHaveLength(1);
  });

  it("失敗すると前のデータのまま注意を出し、backoff（10 秒後）で再試行、成功で注意が消える", async () => {
    vi.useFakeTimers();
    let n = 0;
    const f = router((url) => {
      n++;
      return n === 2 ? json(503, { error: "unavailable" }) : byScope(url);
    });
    const c = await mount(f);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });
    expect(c.textContent).toContain("更新できませんでした");
    expect(lanesOf(c)).toHaveLength(3);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(9_000);
    });
    expect(overviewCalls(f)).toHaveLength(2);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
    });
    expect(overviewCalls(f)).toHaveLength(3);
    expect(c.textContent).not.toContain("更新できませんでした");
  });

  it("タブが hidden の間は取らず、visible に戻ると即 1 回", async () => {
    vi.useFakeTimers();
    const f = router(byScope);
    await mount(f);
    let state: DocumentVisibilityState = "hidden";
    vi.spyOn(document, "visibilityState", "get").mockImplementation(() => state);
    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"));
      await vi.advanceTimersByTimeAsync(30_000);
    });
    expect(overviewCalls(f)).toHaveLength(1);
    state = "visible";
    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    expect(overviewCalls(f)).toHaveLength(2);
  });
});
