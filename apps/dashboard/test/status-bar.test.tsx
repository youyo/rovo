import type { CloudflareSummaryDto, OverviewDto } from "@rovo/dashboard-contract";
import { overviewFixture } from "@rovo/dashboard-contract/fixtures";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { StatusBar } from "../src/status-bar";
import type { CloudflareState } from "../src/use-cloudflare";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const roots: { unmount: () => void }[] = [];
afterEach(() => {
  for (const r of roots.splice(0)) act(() => r.unmount());
  document.body.innerHTML = "";
});

const period = { start: "2026-10-21T00:00:00Z", end: "2026-10-22T00:00:00Z" };
const cfData: CloudflareSummaryDto = {
  generated_at: "2026-10-22T00:00:00Z",
  open_url: null,
  range: "24h",
  workers: { ok: true, value: { period, requests: 2489, errors: 15 } },
  containers: { ok: false, reason: "forbidden" },
  ai_gateway: { ok: false, reason: "forbidden" },
  workers_ai: { ok: false, reason: "unavailable" },
  credit_balance: { ok: true, value: { balance_usd: 954.63 } },
};

function mount(
  data: OverviewDto = overviewFixture,
  cloudflare: CloudflareState | undefined = { phase: "ready", data: cfData },
) {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  act(() => {
    root.render(
      createElement(StatusBar, {
        data,
        nowMs: Date.parse(data.generated_at),
        cloudflare,
        autoRefresh: true,
        onAutoRefreshChange: () => {},
        onRefresh: () => {},
      }),
    );
  });
  return container;
}

const item = (c: HTMLElement, k: string) => c.querySelector(`.statusbar [data-sb='${k}']`);

describe("ステータスバー（tmux 風。下に 1 行、狭いと折り返す）", () => {
  it("今月の自分: 使った額 / 上限、残り・あと何件", () => {
    const c = mount();
    // 上限は契約の monthly_budget_usd
    expect(item(c, "budget-me")?.textContent).toBe("今月 $11.40 / $49.90");
    expect(item(c, "budget-left")?.textContent).toBe("残り $38.50  あと 2 件");
  });

  it("残りが 0 でも、契約の上限があれば上限を出す", () => {
    const c = mount({
      ...overviewFixture,
      budget: { ...overviewFixture.budget, remaining_usd: 0 },
    });
    expect(item(c, "budget-me")?.textContent).toBe("今月 $11.40 / $49.90");
  });

  it("古い応答（上限なし）で残りが 0 のときは上限を出さない（求められない値を作らない）", () => {
    const { monthly_budget_usd: _omit, ...legacy } = overviewFixture.budget;
    const c = mount({ ...overviewFixture, budget: { ...legacy, remaining_usd: 0 } });
    expect(item(c, "budget-me")?.textContent).toBe("今月 $11.40");
  });

  it("全員の実績・モデル別（合計の大きい順）", () => {
    const c = mount();
    expect(item(c, "budget-all")?.textContent).toBe("全員 $43.90");
    const models = item(c, "models")?.textContent ?? "";
    expect(models).toContain("example-model-large $32.70");
    expect(models).toContain("example-model-small $11.20");
    expect(models.indexOf("large")).toBeLessThan(models.indexOf("small"));
  });

  it("モデル別は sonnet / haiku / opus に縮め、金額は formatUsd の丸め", () => {
    const c = mount({
      ...overviewFixture,
      models: [
        { model: "claude-sonnet-5-5", task_cost_usd: 3.7, consult_cost_usd: 0.04 },
        { model: "anthropic/claude-haiku-5-5", task_cost_usd: 0.0629, consult_cost_usd: 0 },
        { model: "claude-opus-5-5", task_cost_usd: 0.0258, consult_cost_usd: 0 },
      ],
    });
    expect(item(c, "models")?.textContent).toBe("sonnet $3.74  haiku $0.0629  opus $0.0258");
  });

  it("モデル別の各項目は途中で折り返さない（項目ごとの span・nowrap）", () => {
    const c = mount();
    const parts = item(c, "models")?.querySelectorAll("[data-model-part]") ?? [];
    expect(parts.length).toBe(2);
  });

  it("Cloudflare の要約とクレジット残高", () => {
    const c = mount();
    expect(item(c, "cloudflare")?.textContent).toBe("Workers 2,489 件  エラー 15 件");
    expect(item(c, "credit")?.textContent).toBe("クレジット $954.63");
  });

  it("Cloudflare の取得に失敗したら、取得できない旨を言葉で出す（値は作らない）", () => {
    const failed = mount(overviewFixture, { phase: "failed", stale: null });
    expect(item(failed, "cloudflare")?.textContent).toContain("取得できませんでした");
    expect(item(failed, "credit")).toBeNull();
    document.body.innerHTML = "";
    const loading = mount(overviewFixture, { phase: "loading" });
    expect(item(loading, "cloudflare")?.textContent).toContain("読み込み中");
  });

  it("項目ごとに取れなかった理由の言葉が出る（Workers だけ取れない場合）", () => {
    const c = mount(overviewFixture, {
      phase: "ready",
      data: { ...cfData, workers: { ok: false, reason: "forbidden" } },
    });
    expect(item(c, "cloudflare")?.textContent).toContain("取得できない（トークンの権限を確認）");
  });
});

describe("内訳の引き出し（今の side-panels と cloudflare-panel の中身。情報を消さない）", () => {
  const drawer = (c: HTMLElement) => c.querySelector(".drawer") as HTMLElement;
  const button = (c: HTMLElement) =>
    [...c.querySelectorAll("button")].find((b) => b.textContent === "内訳") as HTMLButtonElement;

  it("最初は閉じている（hidden）。ボタンは aria-expanded=false で、引き出しを指す", () => {
    const c = mount();
    expect(drawer(c).hidden).toBe(true);
    expect(button(c).getAttribute("aria-expanded")).toBe("false");
    expect(button(c).getAttribute("aria-controls")).toBe(drawer(c).id);
  });

  it("押すと開き、もう一度押すと閉じる", () => {
    const c = mount();
    act(() => button(c).click());
    expect(drawer(c).hidden).toBe(false);
    expect(button(c).getAttribute("aria-expanded")).toBe("true");
    act(() => button(c).click());
    expect(drawer(c).hidden).toBe(true);
    expect(button(c).getAttribute("aria-expanded")).toBe("false");
  });

  it("中身は予算（自分・全員）・モデル別・Cloudflare・凡例・更新の案内", () => {
    const c = mount();
    const d = drawer(c);
    expect(d.querySelector("[data-budget='me']")?.textContent).toContain("あなたの今月の予算");
    expect(d.querySelector("[data-budget='all']")?.textContent).toContain("全員の今月の実績");
    expect(d.querySelector("[data-budget='all']")?.textContent).toContain(
      "権限の無いリポジトリのタスクが 1 件",
    );
    expect(d.querySelector("[data-models]")?.textContent).toContain("タスク $30.60");
    expect(d.querySelector("[data-cloudflare]")?.textContent).toContain("直近 24 時間");
    expect(d.querySelector("[aria-label='凡例']")).not.toBeNull();
    expect(d.textContent).toContain(
      "に更新。あなたが GitHub で見られるリポジトリのタスクだけを表示しています。",
    );
  });
});
