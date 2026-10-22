import type { OverviewDto, TaskDetailDto } from "@rovo/dashboard-contract";
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

const RUNNING_ID = taskDetailRunningFixture.task.task_id;
const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

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
  document.body.innerHTML = "";
  history.replaceState(null, "", "/");
});

const settle = async () => {
  for (let i = 0; i < 30; i++) await Promise.resolve();
};

type Opts = {
  overview?: (url: URL) => OverviewDto;
  detailOf?: (id: string) => TaskDetailDto | null;
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

const paths = (f: ReturnType<typeof vi.fn>) =>
  f.mock.calls.map((c) => new URL(String(c[0]), "http://localhost").pathname);
const text = (e: Element | null) => e?.textContent ?? "";

describe("ヘッダ（一覧と詳細で同じ骨格）", () => {
  it("rovo・全員/自分・その日の要約・利用者名・ログアウト", async () => {
    const { c } = await mount("/dashboard/");
    const head = c.querySelector("header.top") as HTMLElement;
    expect(text(head.querySelector(".brand"))).toBe("rovo");
    const seg = [...head.querySelectorAll("fieldset.seg button")].map((b) => b.textContent);
    expect(seg).toEqual(["全員", "自分"]);
    expect(text(head.querySelector(".day-summary"))).toMatch(
      /^\d+月\d+日 +5 件 +マージ 2 +走行中 1$/,
    );
    expect(text(head.querySelector(".user"))).toContain("alice-example");
    expect([...head.querySelectorAll("button")].some((b) => b.textContent === "ログアウト")).toBe(
      true,
    );
  });

  it("タスクの URL でも同じヘッダ（全員/自分・要約・日付の前後送り）。戻るリンクは無い", async () => {
    const { c } = await mount(`/dashboard/tasks/${RUNNING_ID}`);
    const head = c.querySelector("header.top") as HTMLElement;
    expect(head.querySelector("fieldset.seg")).not.toBeNull();
    expect(text(head.querySelector(".day-summary"))).toContain("5 件");
    expect(head.querySelector("a[href='/dashboard/']")).toBeNull();
    expect(head.querySelector("button[aria-label='前の日']")).not.toBeNull();
  });

  it("最初は「自分」の分。「全員」に切り替えると、要約もレールも全員の分になる", async () => {
    const { c } = await mount("/dashboard/", {
      overview: (url) =>
        url.searchParams.get("scope") === "me" ? overviewMeFixture : overviewFixture,
    });
    const btn = (label: string) =>
      [...c.querySelectorAll("fieldset.seg button")].find(
        (b) => b.textContent === label,
      ) as HTMLButtonElement;
    expect(btn("自分").getAttribute("aria-pressed")).toBe("true");
    expect(c.querySelectorAll("a.rail-row")).toHaveLength(overviewMeFixture.tasks.length);
    await act(async () => {
      btn("全員").click();
      await settle();
    });
    expect(btn("全員").getAttribute("aria-pressed")).toBe("true");
    expect(c.querySelectorAll("a.rail-row")).toHaveLength(overviewFixture.tasks.length);
    expect(text(c.querySelector(".day-summary"))).toContain(`${overviewFixture.tasks.length} 件`);
  });
});

describe("一覧 /dashboard のコンソール", () => {
  it("走行中のタスクがあれば最新の走行中を出す。「詳細を開く」リンクは無い", async () => {
    const { c, f } = await mount("/dashboard/");
    expect(paths(f)).toContain(`/dashboard/api/tasks/${RUNNING_ID}`);
    expect(text(c.querySelector(".console h1"))).toBe(taskDetailRunningFixture.task.title);
    expect([...c.querySelectorAll("a")].some((a) => a.textContent === "詳細を開く")).toBe(false);
    // レールでも選択されている
    expect(c.querySelector("a.rail-row[aria-current='true']")?.getAttribute("data-task-id")).toBe(
      RUNNING_ID,
    );
  });

  it("走行中が無ければ最新のタスク", async () => {
    const finished: OverviewDto = {
      ...overviewFixture,
      scope: "me",
      tasks: overviewFixture.tasks.map((t) =>
        t.status === "RUNNING" || t.status === "VERIFYING"
          ? { ...t, status: "FAILED", ended_at: "2026-10-21T05:59:00Z" }
          : t,
      ),
    };
    const newest = [...finished.tasks].sort(
      (a, b) => Date.parse(b.started_at ?? b.created_at) - Date.parse(a.started_at ?? a.created_at),
    )[0];
    const { f } = await mount("/dashboard/", {
      overview: () => finished,
      detailOf: () => null,
    });
    expect(paths(f)).toContain(`/dashboard/api/tasks/${newest?.task_id}`);
  });

  it("タスクが無ければコンソールの場所に案内を出す（詳細は取りに行かない）", async () => {
    const empty: OverviewDto = { ...overviewFixture, scope: "me", tasks: [], consults: [] };
    const { c, f } = await mount("/dashboard/", { overview: () => empty });
    expect(paths(f).some((p) => p.startsWith("/dashboard/api/tasks/"))).toBe(false);
    expect(text(c.querySelector(".console-col"))).toContain("タスクを選ぶと");
    // コンソールが無いので、自動更新の操作は引き出しの中に出す
    expect(c.querySelectorAll("input[type='checkbox']")).toHaveLength(1);
  });
});

describe("/dashboard/tasks/:id は一覧でそのタスクを選んだ状態（同じ骨格）", () => {
  it("タイムライン帯・レール・コンソール・ステータスバーが出る。選んだタスクが選択中。「詳細を開く」は出さない", async () => {
    const { c, f } = await mount(`/dashboard/tasks/${RUNNING_ID}`);
    expect(paths(f)).toContain("/dashboard/api/overview");
    expect(c.querySelector(".tlband")).not.toBeNull();
    expect(c.querySelector("nav.rail")).not.toBeNull();
    expect(text(c.querySelector(".console h1"))).toBe(taskDetailRunningFixture.task.title);
    expect(c.querySelector(".statusbar")).not.toBeNull();
    expect(c.querySelector("a.rail-row[aria-current='true']")?.getAttribute("data-task-id")).toBe(
      RUNNING_ID,
    );
    expect([...c.querySelectorAll("a")].some((a) => a.textContent === "詳細を開く")).toBe(false);
    // 自動更新のチェックは 1 つだけ（コンソールの下）
    expect(c.querySelectorAll("input[type='checkbox']")).toHaveLength(1);
  });

  it("レールに無いタスク（今日より前など）でも詳細は出る。選択中の行は無い", async () => {
    const other = "01JZ0000000000000000000001";
    const { c } = await mount(`/dashboard/tasks/${other}`, {
      detailOf: (id) => (id === other ? taskDetailRunningFixture : null),
    });
    expect(text(c.querySelector(".console h1"))).toBe(taskDetailRunningFixture.task.title);
    expect(c.querySelector("a.rail-row[aria-current]")).toBeNull();
  });

  it("権限の無い詳細は 404 の表示（題名の断片を出さない）。レールは出ていてよい", async () => {
    const { c } = await mount(`/dashboard/tasks/01JZ0000000000000000000002`, {
      detailOf: () => null,
    });
    expect(text(c.querySelector("h1"))).toBe("このタスクは見られません");
    expect(text(c.querySelector("[role='alert']"))).toContain("権限が無いか、存在しません");
  });

  it("一覧の取得に失敗しても詳細は出る（レールには案内を出す）", async () => {
    history.replaceState(null, "", `/dashboard/tasks/${RUNNING_ID}`);
    const f = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input), "http://localhost");
      if (url.pathname === "/dashboard/api/me") return json(200, { login: "alice-example" });
      if (url.pathname === `/dashboard/api/tasks/${RUNNING_ID}`)
        return json(200, taskDetailRunningFixture);
      if (url.pathname === `/dashboard/api/tasks/${RUNNING_ID}/events`)
        return json(200, taskEventsFixture);
      return json(503, { error: "unavailable" });
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
    expect(text(container.querySelector(".console h1"))).toBe(taskDetailRunningFixture.task.title);
    expect(text(container.querySelector("nav.rail"))).toContain("読み込めませんでした");
  });
});

describe("自動更新の入切は一覧とコンソールで共有する", () => {
  it("コンソールの下のチェックを外すと、保存され、一覧の取得も止まる", async () => {
    vi.useFakeTimers();
    try {
      const { c, f } = await mount("/dashboard/");
      const overviewCalls = () => paths(f).filter((p) => p === "/dashboard/api/overview").length;
      const before = overviewCalls();
      const box = c.querySelector(".console input[type='checkbox']") as HTMLInputElement;
      await act(async () => {
        box.click();
      });
      expect(store.get("rovo.dashboard.autoRefresh")).toBe("0");
      await act(async () => {
        await vi.advanceTimersByTimeAsync(30_000);
      });
      expect(overviewCalls()).toBe(before);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("内訳の引き出しはアプリの中で開閉できる", () => {
  it("初期は閉じ、「内訳」で開く（中身は予算・モデル別・Cloudflare）", async () => {
    const { c } = await mount("/dashboard/");
    const drawer = c.querySelector(".drawer") as HTMLElement;
    expect(drawer.hidden).toBe(true);
    const btn = [...c.querySelectorAll("button")].find(
      (b) => b.textContent === "内訳",
    ) as HTMLElement;
    await act(async () => btn.click());
    expect(drawer.hidden).toBe(false);
    expect(drawer.querySelector("[data-budget='month']")).not.toBeNull();
    expect(drawer.querySelector("[data-models]")).not.toBeNull();
    expect(drawer.querySelector("[data-cloudflare]")).not.toBeNull();
  });
});
