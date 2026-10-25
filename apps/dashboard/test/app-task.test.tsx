import {
  overviewFixture,
  taskDetailRunningFixture,
  taskEventsFixture,
} from "@rovo/dashboard-contract/fixtures";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../src/app";
import { LANG_KEY } from "../src/prefs";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const ID = taskDetailRunningFixture.task.task_id;
const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const roots: { unmount: () => void }[] = [];
beforeEach(() => {
  vi.stubGlobal("localStorage", {
    getItem: (k: string) => (k === LANG_KEY ? "ja" : null),
    setItem: () => {},
  });
});
afterEach(() => {
  for (const r of roots.splice(0)) act(() => r.unmount());
  vi.unstubAllGlobals();
  detailBody = taskDetailRunningFixture;
  detailStatus = 200;
  document.body.innerHTML = "";
  history.replaceState(null, "", "/");
});

const settle = async () => {
  for (let i = 0; i < 20; i++) await Promise.resolve();
};

let detailBody: unknown = taskDetailRunningFixture;
let detailStatus = 200;

async function mount(
  path: string,
  me: () => Response = () => json(200, { login: "alice-example" }),
) {
  history.replaceState(null, "", path);
  const f = vi.fn(async (input: RequestInfo | URL) => {
    const url = new URL(String(input), "http://localhost");
    if (url.pathname === "/dashboard/api/me") return me();
    if (url.pathname === "/dashboard/api/overview")
      return json(200, { ...overviewFixture, scope: "me" });
    if (url.pathname === `/dashboard/api/tasks/${ID}`) return json(detailStatus, detailBody);
    if (url.pathname === `/dashboard/api/tasks/${ID}/events`) return json(200, taskEventsFixture);
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

const localDay = (iso: string) => {
  const d = new Date(iso);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
};
const overviewCalls = (f: ReturnType<typeof vi.fn>) =>
  f.mock.calls
    .map((c) => new URL(String(c[0]), "http://localhost"))
    .filter((u) => u.pathname === "/dashboard/api/overview");
const withStart = (startedAt: string, createdAt = startedAt) => ({
  ...taskDetailRunningFixture,
  task: { ...taskDetailRunningFixture.task, created_at: createdAt, started_at: startedAt },
});
const dayBtn = (c: HTMLElement, label: string) =>
  c.querySelector(`header button[aria-label='${label}']`) as HTMLButtonElement | null;

describe("App のルーティング（個別ページは無い。/dashboard/tasks/<ULID> は一覧でそのタスクを選んだ状態）", () => {
  it("/dashboard/tasks/<ULID> は一覧の画面: そのタスクがコンソールに出てレールで選ばれる。「詳細を開く」と戻るリンクは無い", async () => {
    const { c, f } = await mount(`/dashboard/tasks/${ID}`);
    expect(c.querySelector(".console h1")?.textContent).toBe(taskDetailRunningFixture.task.title);
    expect(paths(f)).toContain(`/dashboard/api/tasks/${ID}`);
    expect(paths(f)).toContain("/dashboard/api/overview");
    expect(c.querySelector("a.rail-row[aria-current='true']")?.getAttribute("data-task-id")).toBe(
      ID,
    );
    expect(
      c.querySelector("fieldset[aria-label='表示範囲（チーム / マイタスク）']"),
    ).not.toBeNull();
    expect(dayBtn(c, "前の日")).not.toBeNull();
    expect([...c.querySelectorAll("a")].some((a) => a.textContent === "詳細を開く")).toBe(false);
    expect(c.querySelector("header a[href='/dashboard/']")).toBeNull();
  });

  it("表示する日は、そのタスクが始まったローカルの日。URL は置き換えない（リロード・共有で同じタスクが開く）", async () => {
    const started = "2026-10-21T01:06:10Z";
    detailBody = withStart(started, "2026-10-19T00:00:00Z");
    const { c, f } = await mount(`/dashboard/tasks/${ID}`);
    const calls = overviewCalls(f);
    expect(calls).toHaveLength(1); // 日が決まる前に今日の一覧を取りに行かない
    const first = calls[0] as URL;
    expect(new Date(Number(first.searchParams.get("from"))).getHours()).toBe(0);
    expect(localDay(new Date(Number(first.searchParams.get("from"))).toISOString())).toBe(
      localDay(started),
    );
    expect(location.pathname).toBe(`/dashboard/tasks/${ID}`);
    expect(location.search).toBe("");
    // 過去の日として表示される（今日へ が出る）
    expect(dayBtn(c, "今日へ")).not.toBeNull();
    expect(dayBtn(c, "次の日")?.disabled).toBe(false);
  });

  it("started_at が無ければ created_at の日", async () => {
    detailBody = {
      ...taskDetailRunningFixture,
      task: {
        ...taskDetailRunningFixture.task,
        created_at: "2026-10-18T05:00:00Z",
        started_at: null,
      },
    };
    const { f } = await mount(`/dashboard/tasks/${ID}`);
    const from = Number((overviewCalls(f)[0] as URL).searchParams.get("from"));
    expect(localDay(new Date(from).toISOString())).toBe(localDay("2026-10-18T05:00:00Z"));
  });

  it("今日始まったタスクなら今日の表示（今日へ は出ない・次の日は押せない）", async () => {
    detailBody = withStart(new Date().toISOString());
    const { c } = await mount(`/dashboard/tasks/${ID}`);
    expect(dayBtn(c, "次の日")?.disabled).toBe(true);
    expect(dayBtn(c, "今日へ")).toBeNull();
  });

  it("タスクの日時が取れない（404）ときは今日。コンソールには見られない旨を出す", async () => {
    detailStatus = 404;
    detailBody = { error: "not_found" };
    const { c, f } = await mount(`/dashboard/tasks/${ID}`);
    expect(overviewCalls(f)).toHaveLength(1);
    expect(dayBtn(c, "次の日")?.disabled).toBe(true);
    expect(c.querySelector("h1")?.textContent).toBe("このタスクは見られません");
  });

  it("タスクの URL で「前の日」を押すと、一覧の URL（?day=）に変わり、選択は外れる。戻るで元のタスクの表示に戻る", async () => {
    detailBody = withStart(new Date().toISOString());
    const { c } = await mount(`/dashboard/tasks/${ID}`);
    await act(async () => {
      dayBtn(c, "前の日")?.click();
      await settle();
    });
    expect(location.pathname).toBe("/dashboard/");
    expect(location.search).toMatch(/^\?day=\d{4}-\d{2}-\d{2}$/);
    await act(async () => {
      history.back();
      await new Promise((r) => setTimeout(r, 20));
      await settle();
    });
    expect(location.pathname).toBe(`/dashboard/tasks/${ID}`);
    expect(c.querySelector(".console h1")?.textContent).toBe(taskDetailRunningFixture.task.title);
    expect(dayBtn(c, "次の日")?.disabled).toBe(true);
  });

  it("それ以外（/dashboard/・不正な ID）は一覧", async () => {
    for (const p of ["/dashboard/", "/dashboard/tasks/not-a-ulid"]) {
      const { c, f } = await mount(p);
      expect(paths(f), p).toContain("/dashboard/api/overview");
      // 一覧のコンソールは走行中のタスク。URL の ID が不正でも一覧になる
      expect(c.querySelector("[data-lane]"), p).toBeNull();
      expect(c.querySelector("a.rail-row"), p).not.toBeNull();
      act(() => roots.pop()?.unmount());
      document.body.innerHTML = "";
    }
  });

  it("未ログインなら API を叩かず、戻り先つきのログインリンクを出す", async () => {
    const { c, f } = await mount(`/dashboard/tasks/${ID}`, () =>
      json(401, { error: "unauthorized" }),
    );
    expect(paths(f)).not.toContain(`/dashboard/api/tasks/${ID}`);
    expect(c.textContent).not.toContain(taskDetailRunningFixture.task.title);
    const login = [...c.querySelectorAll("a")].find((a) => a.textContent === "GitHub でログイン");
    expect(login?.getAttribute("href")).toBe(
      `/dashboard/auth/login?return_to=${encodeURIComponent(`/dashboard/tasks/${ID}`)}`,
    );
  });
});
