import type { TaskDetailDto, VisibleTaskDto } from "@rovo/dashboard-contract";
import {
  overviewFixture,
  taskDetailRunningFixture,
  taskEventsFixture,
} from "@rovo/dashboard-contract/fixtures";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../src/app";
import { formatUsd } from "../src/format";
import { MARKS } from "../src/status";
import { BROWSER_CLICKS, clickLink } from "./click-link";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// レール・タイムラインでの切り替え: ページを読み直さず pushState。fresh=1 は URL を直接開いたときの最初の取得だけ。
// 切り替えた瞬間に一覧の行の情報とキャッシュの詳細を描き、古い応答は捨てる。

const TASKS = overviewFixture.tasks;
const RUNNING = taskDetailRunningFixture.task; // 一覧の既定のコンソール（走行中の最新）= tasks[3]
const A = RUNNING.task_id;
const B = (TASKS[0] as VisibleTaskDto).task_id;
const C = (TASKS[1] as VisibleTaskDto).task_id;
const rowOf = (id: string) => TASKS.find((t) => t.task_id === id) as VisibleTaskDto;

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

type Deferred = { promise: Promise<Response>; resolve: (r: Response) => void };
const deferred = (): Deferred => {
  let resolve: (r: Response) => void = () => {};
  const promise = new Promise<Response>((r) => {
    resolve = r;
  });
  return { promise, resolve };
};

/** 一覧の行の task に、詳細だけが持つ値（いまは・出力）を足した詳細 */
const detailOf = (id: string, tail = "RUN v4.1.12\n ✓ test/a.test.ts (3 tests)\n"): TaskDetailDto => ({
  ...taskDetailRunningFixture,
  task: rowOf(id),
  output: { tail, redacted: true },
});

type DetailCall = { id: string; n: number; search: string; signal: AbortSignal | undefined };
type Script = {
  /** タスクの詳細の応答（タスクごとの何回目か付き）。既定は detailOf(id) */
  detail?: (call: DetailCall) => Response | Promise<Response>;
  events?: (id: string) => Response;
};

const roots: { unmount: () => void }[] = [];
let setItem: ReturnType<typeof vi.fn>;
beforeEach(() => {
  setItem = vi.fn();
  vi.stubGlobal("localStorage", { getItem: () => null, setItem });
});
afterEach(() => {
  for (const r of roots.splice(0)) act(() => r.unmount());
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
  history.replaceState(null, "", "/");
});

const settle = async () => {
  for (let i = 0; i < 30; i++) await Promise.resolve();
};

async function mount(path: string, script: Script = {}) {
  history.replaceState(null, "", path);
  const detailCalls: DetailCall[] = [];
  const counts = new Map<string, number>();
  const f = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), "http://localhost");
    if (url.pathname === "/dashboard/api/me") return json(200, { login: "alice-example" });
    if (url.pathname === "/dashboard/api/overview")
      return json(200, { ...overviewFixture, scope: "me" });
    const m = /^\/dashboard\/api\/tasks\/([^/]+)(\/events)?$/.exec(url.pathname);
    if (m) {
      const id = m[1] as string;
      if (m[2]) {
        return script.events?.(id) ?? json(200, { ...taskEventsFixture, task_id: id });
      }
      const n = counts.get(id) ?? 0;
      counts.set(id, n + 1);
      const call: DetailCall = {
        id,
        n,
        search: url.search,
        signal: init?.signal ?? undefined,
      };
      detailCalls.push(call);
      return script.detail ? script.detail(call) : json(200, detailOf(id));
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
  return { c: container, f, detailCalls };
}

const railRow = (c: HTMLElement, id: string) =>
  c.querySelector(`a.rail-row[data-task-id="${id}"]`) as HTMLAnchorElement;
const barOf = (c: HTMLElement, id: string) => c.querySelector(`a[data-task="${id}"]`) as Element;
const consoleTitle = (c: HTMLElement) => c.querySelector(".console h1")?.textContent;
const selectedId = (c: HTMLElement) =>
  c.querySelector("a.rail-row[aria-current='true']")?.getAttribute("data-task-id");
const stepCount = (c: HTMLElement) => c.querySelectorAll(".steps [data-seq]").length;
const meCalls = (f: ReturnType<typeof vi.fn>) =>
  f.mock.calls.filter((x) => String(x[0]) === "/dashboard/api/me").length;

/** 左クリック（preventDefault されたか）を、React の更新と取得が落ち着くまで待って返す */
async function leftClick(el: Element, init: MouseEventInit = {}) {
  let prevented = false;
  await act(async () => {
    prevented = clickLink(el, init);
    await settle();
  });
  return prevented;
}

const back = async () => {
  await act(async () => {
    history.back();
    await new Promise((r) => setTimeout(r, 20));
    await settle();
  });
};
const forward = async () => {
  await act(async () => {
    history.forward();
    await new Promise((r) => setTimeout(r, 20));
    await settle();
  });
};

const ymd = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const daysAgo = (n: number) => {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d;
};

describe("レール・タイムラインでの切り替え: ページを読み直さず、pushState で URL だけ変える", () => {
  it("レールの行を左クリック: 遷移せず（preventDefault）、pushState で /dashboard/tasks/<ID> になり、選んだタスクが出る。履歴が 1 つ積まれ、API の me を取り直さない（読み直していない）", async () => {
    const { c, f } = await mount("/dashboard/");
    expect(consoleTitle(c)).toBe(RUNNING.title); // 一覧の既定は走行中のタスク
    const push = vi.spyOn(history, "pushState");
    const length = history.length;
    const me = meCalls(f);

    expect(await leftClick(railRow(c, B))).toBe(true);

    expect(push).toHaveBeenCalledTimes(1);
    expect(push).toHaveBeenCalledWith(null, "", `/dashboard/tasks/${B}`);
    expect(location.pathname).toBe(`/dashboard/tasks/${B}`);
    expect(location.search).toBe("");
    expect(history.length).toBe(length + 1);
    expect(meCalls(f)).toBe(me);
    expect(consoleTitle(c)).toBe(rowOf(B).title);
    expect(selectedId(c)).toBe(B);
    // 行の href は残る（右クリックのメニュー・新しいタブのため）
    expect(railRow(c, B).getAttribute("href")).toBe(`/dashboard/tasks/${B}`);
  });

  it("タイムラインの棒を左クリックしても同じ", async () => {
    const { c } = await mount("/dashboard/");
    const push = vi.spyOn(history, "pushState");
    expect(await leftClick(barOf(c, C))).toBe(true);
    expect(push).toHaveBeenCalledWith(null, "", `/dashboard/tasks/${C}`);
    expect(location.pathname).toBe(`/dashboard/tasks/${C}`);
    expect(consoleTitle(c)).toBe(rowOf(C).title);
    expect(selectedId(c)).toBe(C);
    expect(barOf(c, C).getAttribute("href")).toBe(`/dashboard/tasks/${C}`);
  });

  it("タスクの URL からレールで別のタスクへ切り替えても、一覧を取り直さず、同じ日のまま", async () => {
    const { c, f } = await mount(`/dashboard/tasks/${A}`);
    const overviews = () =>
      f.mock.calls.filter((x) => String(x[0]).startsWith("/dashboard/api/overview")).length;
    const before = overviews();
    await leftClick(railRow(c, B));
    expect(consoleTitle(c)).toBe(rowOf(B).title);
    expect(overviews()).toBe(before);
    expect(c.querySelectorAll("a.rail-row").length).toBe(TASKS.length);
  });

  it("選択中の行をもう一度押しても、履歴を積まない（遷移もしない）", async () => {
    const { c } = await mount(`/dashboard/tasks/${A}`);
    const push = vi.spyOn(history, "pushState");
    expect(await leftClick(railRow(c, A))).toBe(true);
    expect(push).not.toHaveBeenCalled();
    expect(location.pathname).toBe(`/dashboard/tasks/${A}`);
  });

  it("修飾キー（Ctrl・Cmd・Shift・Alt）付きと中クリックは、ブラウザに任せる（preventDefault しない・URL も画面も変えない）", async () => {
    const { c } = await mount("/dashboard/");
    const push = vi.spyOn(history, "pushState");
    for (const { name, init } of BROWSER_CLICKS) {
      expect(await leftClick(railRow(c, B), init), `レール ${name}`).toBe(false);
      expect(await leftClick(barOf(c, B), init), `タイムライン ${name}`).toBe(false);
    }
    expect(push).not.toHaveBeenCalled();
    expect(location.pathname).toBe("/dashboard/");
    expect(consoleTitle(c)).toBe(RUNNING.title);
  });

  it("過去の日を見ているときは、日付の前後送りと同じ dayHref の流儀で ?day= を残す（ほかのクエリは引き継がない）。戻ると元の URL・進むと同じ日の表示", async () => {
    const day = ymd(daysAgo(3));
    const { c } = await mount(`/dashboard/?day=${day}&x=1`);
    const push = vi.spyOn(history, "pushState");
    await leftClick(railRow(c, B));
    expect(push).toHaveBeenCalledWith(null, "", `/dashboard/tasks/${B}?day=${day}`);
    expect(location.search).toBe(`?day=${day}`);

    await back();
    expect(location.pathname).toBe("/dashboard/");
    expect(location.search).toBe(`?day=${day}&x=1`);
    expect(consoleTitle(c)).toBe(RUNNING.title);

    await forward();
    expect(location.pathname).toBe(`/dashboard/tasks/${B}`);
    expect(consoleTitle(c)).toBe(rowOf(B).title);
    // ?day= の日がそのまま使われ、レールが「読み込み中」に戻らない
    expect(c.querySelectorAll("a.rail-row").length).toBe(TASKS.length);
    expect(c.querySelector("header button[aria-label='今日へ']")).not.toBeNull();
  });

  it("popstate（戻る・進む）で選択が URL に追従する", async () => {
    const { c } = await mount("/dashboard/");
    await leftClick(railRow(c, B));
    await leftClick(railRow(c, C));
    expect(selectedId(c)).toBe(C);

    await back();
    expect(location.pathname).toBe(`/dashboard/tasks/${B}`);
    expect(selectedId(c)).toBe(B);
    expect(consoleTitle(c)).toBe(rowOf(B).title);

    await back();
    expect(location.pathname).toBe("/dashboard/");
    expect(selectedId(c)).toBe(A); // 一覧の既定（走行中のタスク）に戻る
    expect(consoleTitle(c)).toBe(RUNNING.title);

    await forward();
    expect(selectedId(c)).toBe(B);
    expect(consoleTitle(c)).toBe(rowOf(B).title);
  });
});

describe("?fresh=1 は、URL を直接開いたときの最初の取得だけ", () => {
  const detailSearches = (calls: DetailCall[], id: string) =>
    calls.filter((x) => x.id === id).map((x) => x.search);

  it("タスクの URL を直接開く: そのタスクの最初の取得に付く。レールでの切り替え（初めてのタスク）には付かない", async () => {
    const { c, detailCalls } = await mount(`/dashboard/tasks/${A}`);
    expect(detailSearches(detailCalls, A)).toEqual(["?fresh=1"]);
    await leftClick(railRow(c, B));
    expect(detailSearches(detailCalls, B)).toEqual([""]);
    await leftClick(barOf(c, C));
    expect(detailSearches(detailCalls, C)).toEqual([""]);
  });

  it("開いたタスクに戻ってきても付かない（戻る・レールのどちらでも）", async () => {
    const { c, detailCalls } = await mount(`/dashboard/tasks/${A}`);
    await leftClick(railRow(c, B));
    await back(); // popstate で A に戻る
    expect(consoleTitle(c)).toBe(RUNNING.title);
    await leftClick(railRow(c, B));
    await leftClick(railRow(c, A)); // レールで A に戻る
    expect(detailSearches(detailCalls, A)).toEqual(["?fresh=1", "", ""]);
  });

  it("一覧（/dashboard/）を開いて決まったコンソール、そこからの切り替えにも付かない（URL がタスクを指していない）", async () => {
    const { c, detailCalls } = await mount("/dashboard/");
    expect(detailSearches(detailCalls, A)).toEqual([""]);
    await leftClick(railRow(c, B));
    expect(detailSearches(detailCalls, B)).toEqual([""]);
  });

  it("切り替えたあとのポーリングにも付かない", async () => {
    vi.useFakeTimers();
    const { c, detailCalls } = await mount(`/dashboard/tasks/${A}`);
    await leftClick(railRow(c, B));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });
    const b = detailSearches(detailCalls, B);
    expect(b.length).toBeGreaterThanOrEqual(3);
    expect(b.every((q) => q === "")).toBe(true);
    // 直接開いたタスクも、最初の 1 回だけ（ポーリングには付かない）
    const a = detailSearches(detailCalls, A);
    expect(a[0]).toBe("?fresh=1");
    expect(a.slice(1).every((q) => q === "")).toBe(true);
  });

  it("もう一度 URL を直接開く（ページの読み込み）と、そのタスクの最初の取得に付く", async () => {
    const first = await mount(`/dashboard/tasks/${A}`);
    await leftClick(railRow(first.c, B));
    act(() => roots.pop()?.unmount());
    document.body.innerHTML = "";
    const { detailCalls } = await mount(`/dashboard/tasks/${B}`);
    expect(detailSearches(detailCalls, B)).toEqual(["?fresh=1"]);
  });
});

describe("切り替えた瞬間の表示: 一覧の行の情報と、キャッシュの詳細", () => {
  it("初めてのタスク: 詳細が届く前に、一覧の行の題名・状態・費用を描く。届いたら差し替わる", async () => {
    const slow = deferred();
    const { c } = await mount("/dashboard/", {
      detail: (call) => (call.id === B ? slow.promise : json(200, detailOf(call.id))),
    });
    await leftClick(railRow(c, B));

    const row = rowOf(B);
    expect(consoleTitle(c)).toBe(row.title);
    const head = c.querySelector(".console .con-head")?.textContent ?? "";
    expect(head).toContain(MARKS.done.label);
    expect(head).toContain(formatUsd(row.cost.cost_usd));
    expect(head).toContain(row.repository);
    expect(c.querySelector(".console")?.textContent).toContain("読み込み中");
    expect(c.querySelector(".console [data-seq]")).toBeNull();
    expect(c.querySelector(".console .output")).toBeNull();

    await act(async () => {
      slow.resolve(json(200, detailOf(B, "TAIL-OF-B")));
      await settle();
    });
    expect(consoleTitle(c)).toBe(row.title);
    expect(c.querySelector(".console .output")?.textContent).toContain("TAIL-OF-B");
    expect(stepCount(c)).toBeGreaterThan(0);
    expect(c.querySelector(".console")?.textContent).not.toContain("読み込み中");
  });

  it("前に開いたタスクに戻る: キャッシュの詳細（進み具合・出力）をすぐ描き、届いた応答で差し替える", async () => {
    const second = deferred();
    const { c, detailCalls } = await mount("/dashboard/", {
      detail: (call) =>
        call.id === A && call.n >= 1 ? second.promise : json(200, detailOf(call.id, "OLD-TAIL")),
    });
    expect(c.querySelector(".console .output")?.textContent).toContain("OLD-TAIL");
    const steps = stepCount(c);
    expect(steps).toBeGreaterThan(0);

    await leftClick(railRow(c, B));
    expect(consoleTitle(c)).toBe(rowOf(B).title);

    await leftClick(railRow(c, A));
    // A の 2 回目の取得はまだ返っていない。それでもキャッシュの詳細がすぐ出る
    expect(detailCalls.filter((x) => x.id === A)).toHaveLength(2);
    expect(consoleTitle(c)).toBe(RUNNING.title);
    expect(c.querySelector(".console .output")?.textContent).toContain("OLD-TAIL");
    expect(stepCount(c)).toBe(steps);
    expect(c.querySelector(".console")?.textContent).not.toContain("読み込み中");

    await act(async () => {
      second.resolve(json(200, detailOf(A, "NEW-TAIL")));
      await settle();
    });
    expect(c.querySelector(".console .output")?.textContent).toContain("NEW-TAIL");
    expect(c.querySelector(".console .output")?.textContent).not.toContain("OLD-TAIL");
  });

  it("popstate で戻ったときも、キャッシュの詳細をすぐ描く", async () => {
    const hold = deferred();
    const { c } = await mount("/dashboard/", {
      detail: (call) =>
        call.id === A && call.n >= 1 ? hold.promise : json(200, detailOf(call.id, "OLD-TAIL")),
    });
    await leftClick(railRow(c, B));
    await back(); // 一覧の既定（A）へ
    expect(selectedId(c)).toBe(A);
    expect(c.querySelector(".console .output")?.textContent).toContain("OLD-TAIL");
  });

  it("権限を失っていた（取り直しが 404）ら、キャッシュの詳細は消え、見られない画面になる。次に開いてもキャッシュは出ない", async () => {
    const { c } = await mount("/dashboard/", {
      detail: (call) =>
        call.id === A && call.n >= 1
          ? json(404, { error: "not_found" })
          : json(200, detailOf(call.id)),
    });
    await leftClick(railRow(c, B));
    await leftClick(railRow(c, A));
    expect(c.querySelector(".console-col")?.textContent).toContain("このタスクは見られません");
    expect(c.querySelector(".console-col")?.textContent).not.toContain("RUN v4.1.12");
    await leftClick(railRow(c, B));
    await leftClick(railRow(c, A));
    expect(c.querySelector(".console-col")?.textContent).toContain("このタスクは見られません");
  });

  it("キャッシュはメモリだけ（localStorage に書かない）。ページを読み直すと空", async () => {
    const first = await mount("/dashboard/");
    await leftClick(railRow(first.c, B));
    await leftClick(railRow(first.c, A));
    expect(setItem).not.toHaveBeenCalled();
    act(() => roots.pop()?.unmount());
    document.body.innerHTML = "";

    const slow = deferred();
    const { c } = await mount(`/dashboard/tasks/${B}`, {
      detail: (call) => (call.id === B ? slow.promise : json(200, detailOf(call.id))),
    });
    expect(c.querySelector(".console .output")).toBeNull();
    expect(c.querySelector(".console")?.textContent).toContain("読み込み中");
  });
});

describe("古い応答は、新しい選択を上書きしない", () => {
  it("B の取得が遅れている間に C へ切り替えると、あとから届いた B の応答は捨てられ、C の表示のまま。B の取得は止める", async () => {
    const slowB = deferred();
    const { c, detailCalls } = await mount("/dashboard/", {
      detail: (call) =>
        call.id === B ? slowB.promise : json(200, detailOf(call.id, `TAIL-OF-${call.id.slice(-2)}`)),
    });
    await leftClick(railRow(c, B));
    await leftClick(railRow(c, C));
    expect(consoleTitle(c)).toBe(rowOf(C).title);
    expect(c.querySelector(".console .output")?.textContent).toContain(`TAIL-OF-${C.slice(-2)}`);

    // 選択が移ったので、B の取得は止められている
    expect(detailCalls.find((x) => x.id === B)?.signal?.aborted).toBe(true);

    await act(async () => {
      slowB.resolve(json(200, detailOf(B, "LATE-TAIL-OF-B")));
      await settle();
    });
    expect(consoleTitle(c)).toBe(rowOf(C).title);
    expect(selectedId(c)).toBe(C);
    expect(c.querySelector(".console")?.textContent).not.toContain("LATE-TAIL-OF-B");
    expect(location.pathname).toBe(`/dashboard/tasks/${C}`);
  });

  it("最初のタスク（A）の取得が遅れている間に B へ切り替えても、遅れて届いた A の応答は B の表示を上書きしない", async () => {
    const slowA = deferred();
    const { c } = await mount("/dashboard/", {
      detail: (call) => (call.id === A ? slowA.promise : json(200, detailOf(call.id, "TAIL-OF-B"))),
    });
    await leftClick(railRow(c, B));
    expect(c.querySelector(".console .output")?.textContent).toContain("TAIL-OF-B");
    await act(async () => {
      slowA.resolve(json(200, detailOf(A, "LATE-TAIL-OF-A")));
      await settle();
    });
    expect(consoleTitle(c)).toBe(rowOf(B).title);
    expect(c.querySelector(".console .output")?.textContent).toContain("TAIL-OF-B");
    expect(c.querySelector(".console")?.textContent).not.toContain("LATE-TAIL-OF-A");
  });

  it("遅れて届いた古い応答は、キャッシュにも入らない（あとでそのタスクに戻っても、古い内容を先に出さない）", async () => {
    const slowB = deferred();
    const { c } = await mount("/dashboard/", {
      detail: (call) =>
        call.id === B && call.n === 0 ? slowB.promise : json(200, detailOf(call.id, "FRESH-TAIL")),
    });
    await leftClick(railRow(c, B));
    await leftClick(railRow(c, C));
    await act(async () => {
      slowB.resolve(json(200, detailOf(B, "LATE-TAIL-OF-B")));
      await settle();
    });
    await leftClick(railRow(c, B));
    expect(c.querySelector(".console")?.textContent).not.toContain("LATE-TAIL-OF-B");
  });
});
