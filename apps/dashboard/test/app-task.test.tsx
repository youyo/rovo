import {
  overviewFixture,
  taskDetailRunningFixture,
  taskEventsFixture,
} from "@rovo/dashboard-contract/fixtures";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../src/app";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const ID = taskDetailRunningFixture.task.task_id;
const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const roots: { unmount: () => void }[] = [];
beforeEach(() => {
  vi.stubGlobal("localStorage", { getItem: () => null, setItem: () => {} });
});
afterEach(() => {
  for (const r of roots.splice(0)) act(() => r.unmount());
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
  history.replaceState(null, "", "/");
});

const settle = async () => {
  for (let i = 0; i < 20; i++) await Promise.resolve();
};

async function mount(
  path: string,
  me: () => Response = () => json(200, { login: "alice-example" }),
) {
  history.replaceState(null, "", path);
  const f = vi.fn(async (input: RequestInfo | URL) => {
    const url = new URL(String(input), "http://localhost");
    if (url.pathname === "/dashboard/api/me") return me();
    if (url.pathname === "/dashboard/api/overview") return json(200, overviewFixture);
    if (url.pathname === `/dashboard/api/tasks/${ID}`) return json(200, taskDetailRunningFixture);
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

describe("App のルーティング", () => {
  it("/dashboard/tasks/<ULID> は詳細（コンソール）。一覧と同じ骨格のためレール用に一覧の API も取る。全員 / 自分と戻るリンクを出す", async () => {
    const { c, f } = await mount(`/dashboard/tasks/${ID}`);
    expect(c.querySelector(".console h1")?.textContent).toBe(taskDetailRunningFixture.task.title);
    expect(paths(f)).toContain(`/dashboard/api/tasks/${ID}`);
    expect(paths(f)).toContain("/dashboard/api/overview");
    expect(c.querySelector("fieldset[aria-label='表示するタスク']")).not.toBeNull();
    expect(c.querySelector("header a[href='/dashboard/']")?.textContent).toBe(
      "ダッシュボードに戻る",
    );
  });

  it("それ以外（/dashboard/・不正な ID）は一覧", async () => {
    for (const p of ["/dashboard/", "/dashboard/tasks/not-a-ulid"]) {
      const { c, f } = await mount(p);
      expect(paths(f), p).toContain("/dashboard/api/overview");
      // 一覧のコンソールは走行中のタスク。URL の ID が不正でも一覧になる
      expect(c.querySelector("[data-lane]"), p).not.toBeNull();
      expect(c.querySelector("a.rail-row"), p).not.toBeNull();
      act(() => roots.pop()?.unmount());
      document.body.innerHTML = "";
    }
  });

  it("詳細: 未ログインなら API を叩かず、戻り先つきのログインリンクを出す", async () => {
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
