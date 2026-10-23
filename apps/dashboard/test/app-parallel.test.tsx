import {
  cloudflareSummaryFixture,
  overviewFixture,
  taskDetailRunningFixture,
  taskEventsFixture,
} from "@rovo/dashboard-contract/fixtures";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../src/app";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// 一覧・詳細・Cloudflare・予算は互いに待たない。遅い（または失敗する）部分があっても、届いたものから描く。

const ID = taskDetailRunningFixture.task.task_id;
const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const never = () => new Promise<Response>(() => {});

type Part = "overview" | "detail" | "events" | "cloudflare" | "budget";
type Script = Partial<Record<Part, () => Promise<Response> | Response>>;

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
  for (let i = 0; i < 30; i++) await Promise.resolve();
};

async function mount(path: string, script: Script = {}) {
  history.replaceState(null, "", path);
  const f = vi.fn(async (input: RequestInfo | URL) => {
    const url = new URL(String(input), "http://localhost");
    const p = url.pathname;
    if (p === "/dashboard/api/me") return json(200, { login: "alice-example" });
    if (p === "/dashboard/api/overview")
      return (
        script.overview?.() ??
        json(200, {
          ...overviewFixture,
          scope: url.searchParams.get("scope") === "me" ? "me" : "all",
        })
      );
    if (p === "/dashboard/api/budget")
      return script.budget?.() ?? json(200, overviewFixture.budget);
    if (p === "/dashboard/api/cloudflare")
      return script.cloudflare?.() ?? json(200, cloudflareSummaryFixture);
    if (p === `/dashboard/api/tasks/${ID}`)
      return script.detail?.() ?? json(200, taskDetailRunningFixture);
    if (p === `/dashboard/api/tasks/${ID}/events`)
      return script.events?.() ?? json(200, taskEventsFixture);
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
const paths = (f: ReturnType<typeof vi.fn>) =>
  f.mock.calls.map((c) => new URL(String(c[0]), "http://localhost").pathname);

describe("既定の表示は「マイタスク」", () => {
  it("scope の初期値は me。「マイタスク」が押された状態で、overview も scope=me で取る", async () => {
    const { c, f } = await mount("/dashboard/");
    const pressed = (label: string) =>
      [...c.querySelectorAll("fieldset.seg button")]
        .find((b) => b.textContent === label)
        ?.getAttribute("aria-pressed");
    expect(pressed("マイタスク")).toBe("true");
    expect(pressed("チーム")).toBe("false");
    const u = f.mock.calls
      .map((x) => new URL(String(x[0]), "http://localhost"))
      .find((x) => x.pathname === "/dashboard/api/overview");
    expect(u?.searchParams.get("scope")).toBe("me");
  });
});

describe("一覧・詳細・Cloudflare は互いに待たない", () => {
  it("詳細が返らなくても、一覧（レール・帯・ステータスバー）が先に出る。詳細の場所だけ読み込み中", async () => {
    const { c } = await mount("/dashboard/", { detail: never });
    expect(c.querySelectorAll("a.rail-row").length).toBeGreaterThan(0);
    expect(c.querySelector(".tlband")).not.toBeNull();
    expect(c.querySelector(".statusbar")).not.toBeNull();
    expect(text(c.querySelector(".console-col"))).toContain("読み込み中");
    expect(text(c.querySelector("nav.rail"))).not.toContain("読み込み中");
  });

  it("Cloudflare が返らなくても、一覧も詳細も出る。バーの Cloudflare の場所だけ読み込み中", async () => {
    const { c } = await mount("/dashboard/", { cloudflare: never });
    expect(c.querySelectorAll("a.rail-row").length).toBeGreaterThan(0);
    expect(text(c.querySelector(".console h1"))).toBe(taskDetailRunningFixture.task.title);
    expect(text(c.querySelector("[data-sb='cloudflare']"))).toContain("読み込み中");
  });

  it("Cloudflare が失敗しても、一覧と詳細は出る", async () => {
    const { c } = await mount("/dashboard/", {
      cloudflare: () => json(503, { error: "unavailable" }),
    });
    expect(c.querySelectorAll("a.rail-row").length).toBeGreaterThan(0);
    expect(text(c.querySelector(".console h1"))).toBe(taskDetailRunningFixture.task.title);
  });

  it("一覧が返らない間も、ヘッダ・予算（/budget）・コンソールの場所が描かれ、画面全体の「読み込み中」で止まらない", async () => {
    const { c } = await mount("/dashboard/", { overview: never });
    expect(c.querySelector("header.top fieldset.seg")).not.toBeNull();
    expect(text(c.querySelector("header .user"))).toContain("alice-example");
    const bar = c.querySelector(".statusbar");
    expect(bar).not.toBeNull();
    expect(text(bar?.querySelector("[data-sb='budget-me']") ?? null)).toContain("今月");
    expect(text(bar?.querySelector("[data-sb='budget-left']") ?? null)).toContain("残り");
    // 一覧の場所（レール）だけが読み込み中
    expect(text(c.querySelector("nav.rail"))).toContain("読み込み中");
    expect(c.querySelector(".console-col")).not.toBeNull();
  });

  it("一覧と /budget の両方が遅くても、Cloudflare の要約は先に出る", async () => {
    const { c } = await mount("/dashboard/", { overview: never, budget: never });
    expect(text(c.querySelector("[data-sb='cloudflare']"))).not.toContain("読み込み中");
    expect(text(c.querySelector("[data-sb='cloudflare']"))).toContain("Workers");
  });

  it("一覧が失敗したときは、これまでどおりエラーと再読み込みを出す（一覧の画面）", async () => {
    const { c } = await mount("/dashboard/", {
      overview: () => json(503, { error: "unavailable" }),
    });
    expect(text(c.querySelector("[role='alert']"))).toContain("読み込めませんでした");
  });
});

describe("タスクの URL: 詳細の取得は 1 回で、画面全体を止めない", () => {
  it("詳細は fresh=1 の 1 回だけ（App と画面で二重に取らない）", async () => {
    const { f } = await mount(`/dashboard/tasks/${ID}`);
    const detailCalls = f.mock.calls
      .map((x) => String(x[0]))
      .filter((u) => u.startsWith(`/dashboard/api/tasks/${ID}`) && !u.includes("/events"));
    expect(detailCalls).toEqual([`/dashboard/api/tasks/${ID}?fresh=1`]);
  });

  it("詳細が返らない間も、ヘッダ・ステータスバーの予算・コンソールの読み込み中が出て、Cloudflare も取りに行く", async () => {
    const { c, f } = await mount(`/dashboard/tasks/${ID}`, { detail: never });
    expect(c.querySelector("header.top fieldset.seg")).not.toBeNull();
    expect(text(c.querySelector(".console-col"))).toContain("読み込み中");
    expect(text(c.querySelector("[data-sb='budget-me']"))).toContain("今月");
    expect(paths(f)).toContain("/dashboard/api/cloudflare");
  });

  it("詳細が 404 でも一覧は今日の日で出る", async () => {
    const { c } = await mount(`/dashboard/tasks/${ID}`, {
      detail: () => json(404, { error: "not_found" }),
    });
    expect(c.querySelectorAll("a.rail-row").length).toBeGreaterThan(0);
    expect(text(c.querySelector(".console-col"))).toContain("このタスクは見られません");
  });
});
