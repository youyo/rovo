import type { OverviewDto, TaskDetailDto, WaitingDto } from "@rovo/dashboard-contract";
import {
  overviewFixture,
  overviewMeFixture,
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

// 工場の帯の中身（遅延チャンク）を先に読み込み、React.lazy の解決が CI の遅さに左右されないようにする
await import("../src/factory-panel");

const RUNNING_ID = taskDetailRunningFixture.task.task_id;
const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

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
  document.body.innerHTML = "";
  history.replaceState(null, "", "/");
});

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

const paths = (f: ReturnType<typeof vi.fn>) =>
  f.mock.calls.map((c) => new URL(String(c[0]), "http://localhost").pathname);
const text = (e: Element | null) => e?.textContent ?? "";

describe("ヘッダ（一覧と詳細で同じ骨格）", () => {
  it("Rovo・マイタスク/チーム・その日の要約・利用者名・ログアウト", async () => {
    const { c } = await mount("/dashboard/");
    const head = c.querySelector("header.top") as HTMLElement;
    expect(text(head.querySelector(".brand"))).toBe("Rovo");
    // 「Rovo」の左にロゴ（装飾。同一オリジンの SVG）
    const mark = head.querySelector(".brand > img.brand-mark:first-child") as HTMLImageElement;
    expect(mark.getAttribute("src")).toBe("/dashboard/assets/brand/rovo-mark.svg");
    expect(mark.getAttribute("alt")).toBe("");
    expect(mark.getAttribute("width")).toBe("24");
    const seg = [...head.querySelectorAll("fieldset.seg:not(.lang) button")].map(
      (b) => b.textContent,
    );
    // 並びは「マイタスク」が先。表示範囲の切り替えの名前（aria-label）も合わせる
    expect(seg).toEqual(["マイタスク", "チーム"]);
    expect(head.querySelector("fieldset.seg:not(.lang)")?.getAttribute("aria-label")).toBe(
      "表示範囲（チーム / マイタスク）",
    );
    expect(text(head.querySelector(".day-summary"))).toMatch(
      /^\d+月\d+日 +5 件 +マージ済み 2 +実行中 1$/,
    );
    expect(text(head.querySelector(".user"))).toContain("alice-example");
    expect([...head.querySelectorAll("button")].some((b) => b.textContent === "ログアウト")).toBe(
      true,
    );
  });

  it("タスクの URL でも同じヘッダ（チーム/マイタスク・要約・日付の前後送り）。戻るリンクは無い", async () => {
    const { c } = await mount(`/dashboard/tasks/${RUNNING_ID}`);
    const head = c.querySelector("header.top") as HTMLElement;
    expect(head.querySelector("fieldset.seg")).not.toBeNull();
    expect(text(head.querySelector(".day-summary"))).toContain("5 件");
    expect(head.querySelector("a[href='/dashboard/']")).toBeNull();
    expect(head.querySelector("button[aria-label='前の日']")).not.toBeNull();
  });

  it("最初は「マイタスク」の分。「チーム」に切り替えると、要約もレールも全員の分になる", async () => {
    const { c } = await mount("/dashboard/", {
      overview: (url) =>
        url.searchParams.get("scope") === "me" ? overviewMeFixture : overviewFixture,
    });
    const btn = (label: string) =>
      [...c.querySelectorAll("fieldset.seg button")].find(
        (b) => b.textContent === label,
      ) as HTMLButtonElement;
    expect(btn("マイタスク").getAttribute("aria-pressed")).toBe("true");
    expect(c.querySelectorAll("a.rail-row")).toHaveLength(overviewMeFixture.tasks.length);
    await act(async () => {
      btn("チーム").click();
      await settle();
    });
    expect(btn("チーム").getAttribute("aria-pressed")).toBe("true");
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
    // タスクの日（過去の日）を開くので工場ではなくタイムラインの出し分け。マイタスクなのでタイムラインの帯も出ない
    expect(c.querySelector(".day-today")).not.toBeNull();
    expect(c.querySelector(".tlband, section[data-factory]")).toBeNull();
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

describe("日をまたいだ「待ち」（レールの切り替え）", () => {
  const WAITING_ID = waitingFixture.tasks[0]?.task_id as string;
  const tabBtn = (c: HTMLElement, i: number) =>
    c.querySelectorAll("fieldset.rail-tabs button")[i] as HTMLButtonElement;
  const clickBtn = async (b: Element) => {
    await act(async () => {
      (b as HTMLElement).click();
      await settle();
    });
  };

  it("初期は「この日」。待ちは scope と同じ絞り込みで取り、件数をタブに添える。「待ち」を開くと日付に関係なく待ちのタスクが出る", async () => {
    const { c, f } = await mount("/dashboard/");
    expect(tabBtn(c, 0).getAttribute("aria-pressed")).toBe("true");
    // 初期の scope は「マイタスク」(me)
    expect(tabBtn(c, 1).textContent).toBe(`要対応 ${waitingMeFixture.tasks.length}`);
    const waitingCalls = f.mock.calls
      .map((x) => new URL(String(x[0]), "http://localhost"))
      .filter((u) => u.pathname === "/dashboard/api/waiting");
    expect(waitingCalls.map((u) => u.searchParams.get("scope"))).toEqual(["me"]);
    expect(waitingCalls[0]?.searchParams.has("from")).toBe(false);

    await clickBtn(tabBtn(c, 1));
    expect(tabBtn(c, 1).getAttribute("aria-pressed")).toBe("true");
    expect(
      [...c.querySelectorAll("a.rail-row")].map((a) => (a as HTMLElement).dataset.taskId),
    ).toEqual(waitingMeFixture.tasks.map((t) => t.task_id));
  });

  it("全員 / 自分の切り替えは待ちにも効く（チームにすると全員の待ちを取り直す）", async () => {
    const { c } = await mount("/dashboard/");
    await clickBtn(tabBtn(c, 1));
    const team = [...c.querySelectorAll("header.top fieldset.seg:not(.lang) button")].find(
      (b) => b.textContent === "チーム",
    ) as HTMLElement;
    await clickBtn(team);
    expect(tabBtn(c, 1).textContent).toBe(`要対応 ${waitingFixture.tasks.length}`);
    expect(
      [...c.querySelectorAll("a.rail-row")].map((a) => (a as HTMLElement).dataset.taskId),
    ).toEqual(waitingFixture.tasks.map((t) => t.task_id));
  });

  it("待ちの行を押すと、コンソールにそのタスクが出る（/dashboard/tasks/<ID>）。タブは「待ち」のまま", async () => {
    const waitingDetail = (id: string) =>
      id === WAITING_ID
        ? { ...taskDetailRunningFixture, task: waitingFixture.tasks[0] as never }
        : null;
    const { c, f } = await mount("/dashboard/", { detailOf: waitingDetail });
    await clickBtn(tabBtn(c, 1));
    const team = [...c.querySelectorAll("header.top fieldset.seg:not(.lang) button")].find(
      (b) => b.textContent === "チーム",
    ) as HTMLElement;
    await clickBtn(team);
    const row = c.querySelector(`a.rail-row[data-task-id="${WAITING_ID}"]`) as HTMLElement;
    expect(row).not.toBeNull();
    await clickBtn(row);
    expect(location.pathname).toBe(`/dashboard/tasks/${WAITING_ID}`);
    expect(tabBtn(c, 1).getAttribute("aria-pressed")).toBe("true");
    expect(
      c.querySelector(`a.rail-row[data-task-id="${WAITING_ID}"]`)?.getAttribute("aria-current"),
    ).toBe("true");
    expect(c.querySelector(".con-head h1, h1")?.textContent).toContain(
      waitingFixture.tasks[0]?.title,
    );
    expect(paths(f)).toContain(`/dashboard/api/tasks/${WAITING_ID}`);
  });

  it("待ちの取得に失敗しても一覧とコンソールは出る（「待ち」は件数なし）", async () => {
    const { c } = await mount("/dashboard/", {
      waiting: () => {
        throw new Error("x");
      },
    });
    expect(tabBtn(c, 0).getAttribute("aria-pressed")).toBe("true");
    expect(c.querySelectorAll("a.rail-row").length).toBe(overviewFixture.tasks.length);
    expect(tabBtn(c, 1).textContent).toBe("要対応");
  });
});

describe("チームで何も選んでいないときはチームボード", () => {
  const clickScope = async (c: HTMLElement, label: string) => {
    const b = [...c.querySelectorAll("fieldset.seg button")].find(
      (x) => x.textContent === label,
    ) as HTMLButtonElement;
    await act(async () => {
      b.click();
      await settle();
    });
  };

  it("マイタスクは今までどおり既定のタスクのコンソール（ボードは出ない）", async () => {
    const { c } = await mount("/dashboard/");
    expect(c.querySelector("[data-teamboard]")).toBeNull();
    expect(text(c.querySelector(".console h1"))).toBe(taskDetailRunningFixture.task.title);
  });

  it("チームに切り替えるとボードが出る。レール・帯・ステータスバーはそのまま", async () => {
    const { c } = await mount("/dashboard/");
    await clickScope(c, "チーム");
    expect(c.querySelector("[data-teamboard]")).not.toBeNull();
    expect(c.querySelector(".console h1")).toBeNull();
    expect(c.querySelector("section[data-factory]")).not.toBeNull();
    expect(c.querySelector("nav.rail")).not.toBeNull();
    expect(c.querySelector(".statusbar")).not.toBeNull();
    expect(c.querySelector("a.rail-row[aria-current='true']")).toBeNull();
    // 質問待ちは /waiting の分も数える（alice の前日からの質問待ち）
    const alice = c.querySelector("li.tb-person[data-login='alice-example']") as HTMLElement;
    expect(text(alice.querySelector('[data-stat="asking"] .tb-stat-n'))).toBe("1");
    // 自動更新の操作は引き出しに出す（コンソールが無いので 1 つだけ）
    expect(c.querySelectorAll("input[type='checkbox']")).toHaveLength(1);
  });

  it("ボードのタスクを押すとコンソールになる。URL はそのタスクのもの", async () => {
    const { c } = await mount("/dashboard/");
    await clickScope(c, "チーム");
    const link = c.querySelector(
      `a.tb-task[data-task-id="${RUNNING_ID}"]`,
    ) as HTMLAnchorElement | null;
    expect(link).not.toBeNull();
    await act(async () => {
      link?.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 }));
      await settle();
    });
    expect(location.pathname).toBe(`/dashboard/tasks/${RUNNING_ID}`);
    expect(c.querySelector("[data-teamboard]")).toBeNull();
    expect(text(c.querySelector(".console h1"))).toBe(taskDetailRunningFixture.task.title);
  });

  it("タスクの URL をチームで開くとコンソール。日を送ると何も選んでいない状態に戻りボードが出る（過去の日は走行中の欄なし）", async () => {
    const { c } = await mount(`/dashboard/tasks/${RUNNING_ID}`);
    await clickScope(c, "チーム");
    expect(c.querySelector("[data-teamboard]")).toBeNull();
    expect(text(c.querySelector(".console h1"))).toBe(taskDetailRunningFixture.task.title);
    const prev = c.querySelector("button[aria-label='前の日']") as HTMLButtonElement;
    await act(async () => {
      prev.click();
      await settle();
    });
    expect(location.pathname).toBe("/dashboard/");
    expect(c.querySelector("[data-teamboard]")).not.toBeNull();
    expect(c.querySelector('[data-stat="running"]')).toBeNull();
    expect(text(c.querySelector("#tb-people-h"))).toBe("この日");
  });
});

describe("「チーム」をもう一度押すとボードに戻る", () => {
  const team = (c: HTMLElement) =>
    [...c.querySelectorAll("fieldset.seg button")].find(
      (x) => x.textContent === "チーム",
    ) as HTMLButtonElement;
  const press = async (el: HTMLElement) => {
    await act(async () => {
      el.click();
      await settle();
    });
  };

  it("タスクを選んでいるときだけ選択を外す（履歴を積む）。ボードのときは何もしない。マイタスクのタスクは外さない", async () => {
    const { c } = await mount(`/dashboard/tasks/${RUNNING_ID}`);
    // マイタスク（既定）でタスクを選んでいるときに「マイタスク」を押しても外さない
    const me = [...c.querySelectorAll("fieldset.seg button")].find(
      (x) => x.textContent === "マイタスク",
    ) as HTMLButtonElement;
    await press(me);
    expect(location.pathname).toBe(`/dashboard/tasks/${RUNNING_ID}`);
    await press(team(c));
    // 切り替えただけ（選択はそのまま）
    expect(location.pathname).toBe(`/dashboard/tasks/${RUNNING_ID}`);
    expect(c.querySelector("[data-teamboard]")).toBeNull();
    const length = history.length;
    await press(team(c));
    expect(location.pathname).toBe("/dashboard/");
    expect(history.length).toBe(length + 1);
    expect(c.querySelector("[data-teamboard]")).not.toBeNull();
    expect(c.querySelector(".console h1")).toBeNull();
    await press(team(c));
    expect(history.length).toBe(length + 1);
    expect(c.querySelector("[data-teamboard]")).not.toBeNull();
  });
});
