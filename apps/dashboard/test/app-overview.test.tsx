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
import { LANG_KEY } from "../src/prefs";

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

/** scope ごとに中身が違う応答（scope の切り替えの検証用） */
const scoped: Handler = (url) =>
  json(200, url.searchParams.get("scope") === "me" ? overviewMeFixture : overviewFixture);

/** 中身は同じで、scope だけ要求どおりに返す（scope の既定が me でも、全員分の中身で検証できる） */
const byScope: Handler = (url) =>
  json(200, {
    ...overviewFixture,
    scope: url.searchParams.get("scope") === "me" ? "me" : "all",
  });

const roots: { unmount: () => void }[] = [];
let store: Map<string, string>;

beforeEach(() => {
  store = new Map([[LANG_KEY, "ja"]]);
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
/** 今日の工場の帯にいる Rovo（断面図は遅延読み込みなので、描かれるまで待つ）の持ち主 */
async function rovoOwners(c: HTMLElement, data: typeof overviewFixture): Promise<string[]> {
  for (let i = 0; i < 20; i++) await act(async () => await new Promise((r) => setTimeout(r, 0)));
  const ids = [...c.querySelectorAll("section[data-factory] a[data-task]")].map((a) =>
    a.getAttribute("data-task"),
  );
  return [
    ...new Set(ids.map((id) => data.tasks.find((t) => t.task_id === id)?.owner_login ?? "?")),
  ].sort();
}
const overviewCalls = (f: ReturnType<typeof router>) =>
  f.mock.calls
    .map((c) => new URL(String(c[0]), "http://localhost"))
    .filter((u) => u.pathname === "/dashboard/api/overview");

describe("App: 一覧を実 API の形（fetch）につなぐ", () => {
  it("ログイン済みなら overview を取って一覧を出す。範囲はローカル日の 0 時〜いま、scope の既定は me（自分）", async () => {
    const f = router(scoped);
    const c = await mount(f);
    expect(c.querySelector(".day-summary")?.textContent).toMatch(
      new RegExp(`^\\d+月\\d+日 +${overviewMeFixture.tasks.length} 件`),
    );
    expect(lanesOf(c)).toEqual([]);
    const u = overviewCalls(f)[0] as URL;
    expect(u.searchParams.get("scope")).toBe("me");
    const from = Number(u.searchParams.get("from"));
    const to = Number(u.searchParams.get("to"));
    expect(to - from).toBeGreaterThan(0);
    expect(to - from).toBeLessThanOrEqual(36 * 3600_000);
    const d = new Date(from);
    expect([d.getHours(), d.getMinutes(), d.getSeconds(), d.getMilliseconds()]).toEqual([
      0, 0, 0, 0,
    ]);
  });

  it("最初は「マイタスク」。「チーム」にすると scope=all で取り直し、工場に他の人の Rovo も出る。「マイタスク」で戻る", async () => {
    const f = router(scoped);
    const c = await mount(f);
    const btn = (label: string) =>
      [...c.querySelectorAll("button")].find((b) => b.textContent === label) as HTMLButtonElement;
    expect(btn("マイタスク").getAttribute("aria-pressed")).toBe("true");
    expect(lanesOf(c)).toEqual([]);
    expect(await rovoOwners(c, overviewMeFixture)).toEqual(["alice-example"]);
    await act(async () => {
      btn("チーム").click();
    });
    expect(btn("チーム").getAttribute("aria-pressed")).toBe("true");
    expect(overviewCalls(f).at(-1)?.searchParams.get("scope")).toBe("all");
    // 今日はタイムラインのレーンではなく工場（失敗した bob のタスクは工場に出ないが、実行中の bob の Rovo はいる）
    expect(lanesOf(c)).toEqual([]);
    expect(await rovoOwners(c, overviewFixture)).toEqual([
      "alice-example",
      "bob-example",
      "carol-example",
    ]);
    await act(async () => {
      btn("マイタスク").click();
    });
    expect(await rovoOwners(c, overviewMeFixture)).toEqual(["alice-example"]);
  });

  it("切り替えた直後は、新しい応答が来るまで前のスコープのデータを出さない（読み込み中に戻る）", async () => {
    const f = router((url) =>
      url.searchParams.get("scope") === "all" ? new Promise<Response>(() => {}) : scoped(url),
    );
    const c = await mount(f);
    expect(lanesOf(c)).toEqual([]);
    const all = [...c.querySelectorAll("button")].find((b) => b.textContent === "チーム");
    await act(async () => {
      all?.click();
    });
    expect(lanesOf(c)).toHaveLength(0);
    expect(c.querySelector("section[data-factory]")).toBeNull();
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

const ymd = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const daysAgo = (n: number) => {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d;
};
const dayBtn = (c: HTMLElement, name: string) =>
  [...c.querySelectorAll("button")].find((b) => b.getAttribute("aria-label") === name) as
    | HTMLButtonElement
    | undefined;

describe("App: 日付の前後送り", () => {
  afterEach(() => history.replaceState(null, "", "/"));

  it("今日: 「次の日」は無効、「前の日」は有効、「今日へ」は無い", async () => {
    history.replaceState(null, "", "/dashboard/");
    const c = await mount(router(byScope));
    expect(dayBtn(c, "次の日")?.disabled).toBe(true);
    expect(dayBtn(c, "前の日")?.disabled).toBe(false);
    expect(dayBtn(c, "今日へ")).toBeUndefined();
  });

  it("「前の日」で URL が ?day= になり、前日のローカル 0 時〜翌 0 時で取り直す。scope は保つ", async () => {
    history.replaceState(null, "", "/dashboard/");
    const f = router(byScope);
    const c = await mount(f);
    const all = [...c.querySelectorAll("button")].find((b) => b.textContent === "チーム");
    await act(async () => {
      all?.click();
    });
    await act(async () => {
      dayBtn(c, "前の日")?.click();
    });
    const y = daysAgo(1);
    expect(location.search).toBe(`?day=${ymd(y)}`);
    const u = overviewCalls(f).at(-1) as URL;
    expect(Number(u.searchParams.get("from"))).toBe(
      new Date(y.getFullYear(), y.getMonth(), y.getDate()).getTime(),
    );
    expect(Number(u.searchParams.get("to"))).toBe(
      new Date(y.getFullYear(), y.getMonth(), y.getDate() + 1).getTime(),
    );
    expect(u.searchParams.get("scope")).toBe("all");
    expect(dayBtn(c, "次の日")?.disabled).toBe(false);
    expect(dayBtn(c, "今日へ")).toBeDefined();
  });

  it("?day= を直接開くとその日。「次の日」で今日に戻り URL からクエリが消える", async () => {
    history.replaceState(null, "", `/dashboard/?day=${ymd(daysAgo(1))}`);
    const f = router(byScope);
    const c = await mount(f);
    const first = overviewCalls(f)[0] as URL;
    const width = Number(first.searchParams.get("to")) - Number(first.searchParams.get("from"));
    expect(width).toBeGreaterThanOrEqual(23 * 3600_000);
    await act(async () => {
      dayBtn(c, "次の日")?.click();
    });
    expect(location.search).toBe("");
    expect(dayBtn(c, "次の日")?.disabled).toBe(true);
  });

  it("「今日へ」で今日に戻る。不正な ?day= は今日として扱う", async () => {
    history.replaceState(null, "", `/dashboard/?day=${ymd(daysAgo(5))}`);
    const c = await mount(router(byScope));
    await act(async () => {
      dayBtn(c, "今日へ")?.click();
    });
    expect(location.search).toBe("");
    document.body.innerHTML = "";
    history.replaceState(null, "", "/dashboard/?day=garbage");
    const c2 = await mount(router(byScope));
    expect(dayBtn(c2, "次の日")?.disabled).toBe(true);
  });

  it("過去の日を開いている画面は、取り直しでもその日のまま", async () => {
    vi.useFakeTimers();
    history.replaceState(null, "", `/dashboard/?day=${ymd(daysAgo(2))}`);
    const f = router(byScope);
    await mount(f);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });
    const [a, b] = overviewCalls(f);
    expect(b).toBeDefined();
    expect(a?.searchParams.get("from")).toBe(b?.searchParams.get("from"));
    expect(a?.searchParams.get("to")).toBe(b?.searchParams.get("to"));
  });

  it("過去の日で空なら、文言がその日向けになる", async () => {
    history.replaceState(null, "", `/dashboard/?day=${ymd(daysAgo(1))}`);
    const c = await mount(
      router(() => json(200, { ...overviewFixture, scope: "me", tasks: [], consults: [] })),
    );
    expect(c.textContent).toContain("この日のタスクはありません");
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
    // 保存されるのは自動更新の「切」だけ（ほかは最初に入れた言語の設定）
    expect([...store.keys()].sort()).toEqual(["rovo.dashboard.autoRefresh", LANG_KEY].sort());
    expect(store.get("rovo.dashboard.autoRefresh")).toBe("0");
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
    expect(lanesOf(c)).toEqual([]);
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
