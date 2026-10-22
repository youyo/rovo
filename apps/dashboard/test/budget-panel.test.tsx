import type { OverviewDto } from "@rovo/dashboard-contract";
import { overviewFixture } from "@rovo/dashboard-contract/fixtures";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { BudgetPanel } from "../src/side-panels";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const roots: { unmount: () => void }[] = [];
afterEach(() => {
  for (const r of roots.splice(0)) act(() => r.unmount());
  document.body.innerHTML = "";
});

function mount(data: OverviewDto = overviewFixture) {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  act(() => {
    root.render(createElement(BudgetPanel, { data }));
  });
  return container;
}

const row = (c: HTMLElement, k: string) =>
  c.querySelector(`[data-budget-row='${k}']`) as HTMLElement | null;
const value = (c: HTMLElement, k: string) => row(c, k)?.querySelector("dd")?.textContent;
const label = (c: HTMLElement, k: string) => row(c, k)?.querySelector("dt")?.textContent;

describe("予算の欄（自分の予算と全員の実績を 1 つの欄にまとめる）", () => {
  it("欄は 1 つだけ（見出しも 1 つ）。前の 2 つの欄（me / all）は無い", () => {
    const c = mount();
    expect(c.querySelectorAll("section")).toHaveLength(1);
    expect(c.querySelectorAll("h2")).toHaveLength(1);
    expect(c.querySelector("h2")?.textContent).toBe("今月の予算と実績");
    expect(c.querySelector("section")?.getAttribute("data-budget")).toBe("month");
    expect(c.querySelector("[data-budget='me']")).toBeNull();
    expect(c.querySelector("[data-budget='all']")).toBeNull();
    expect(c.querySelector("section")?.getAttribute("aria-labelledby")).toBe(
      c.querySelector("h2")?.id,
    );
    expect(c.querySelector(".caption")?.textContent).toBe("UTC の月");
  });

  it("自分の使った額・残り・上限、全員の実績を、この順で並べる", () => {
    const c = mount();
    const keys = [...c.querySelectorAll("[data-budget-row]")].map((e) =>
      e.getAttribute("data-budget-row"),
    );
    expect(keys).toEqual(["spent", "remaining", "limit", "all"]);
    expect(label(c, "spent")).toBe("あなたの使った額");
    expect(label(c, "remaining")).toBe("あなたの残り");
    expect(label(c, "limit")).toBe("あなたの上限");
    expect(label(c, "all")).toBe("全員の実績");
    expect(value(c, "spent")).toBe("$11.40");
    expect(value(c, "remaining")).toBe("$38.50");
    expect(value(c, "limit")).toBe("$49.90");
    expect(value(c, "all")).toBe("$43.90");
  });

  it("行は dl の中の項目（dt と dd）。読み上げで名前と値が対応する", () => {
    const c = mount();
    const dl = c.querySelector("dl.budget-rows") as HTMLElement;
    expect(dl).not.toBeNull();
    expect(dl.querySelectorAll(":scope > div > dt")).toHaveLength(4);
    expect(dl.querySelectorAll(":scope > div > dd")).toHaveLength(4);
  });

  it("「あと N 件始められます」を残す", () => {
    const c = mount();
    expect(c.querySelector("[data-budget-startable]")?.textContent).toBe("あと 2 件始められます。");
    const zero = mount({
      ...overviewFixture,
      budget: { ...overviewFixture.budget, startable: 0 },
    });
    expect(zero.textContent).toContain("あと 0 件始められます。");
  });

  it("上限は契約の monthly_budget_usd。残りが 0 でも出る", () => {
    const c = mount({
      ...overviewFixture,
      budget: { ...overviewFixture.budget, monthly_budget_usd: 50, remaining_usd: 0 },
    });
    expect(value(c, "limit")).toBe("$50.00");
    expect(value(c, "remaining")).toBe("$0");
  });

  it("monthly_budget_usd が無い古い応答: 今の逆算（使った額 + 予約 + 残り）を上限に出す", () => {
    const { monthly_budget_usd: _omit, ...legacy } = overviewFixture.budget;
    const c = mount({
      ...overviewFixture,
      budget: { ...legacy, spent_usd: 7.97, reserved_usd: 0, remaining_usd: 42.03 },
    });
    expect(value(c, "limit")).toBe("$50.00");
    expect(value(c, "spent")).toBe("$7.97");
    // 予約額そのものは出さない
    expect(c.textContent).not.toContain("予約");
  });

  it("monthly_budget_usd が無く、残りが 0 なら、上限は求められない。作った値を出さず「不明」", () => {
    const { monthly_budget_usd: _omit, ...legacy } = overviewFixture.budget;
    const c = mount({ ...overviewFixture, budget: { ...legacy, remaining_usd: 0 } });
    expect(row(c, "limit")).not.toBeNull();
    expect(value(c, "limit")).toBe("不明");
    expect(value(c, "remaining")).toBe("$0");
  });

  it("自分と全員を足し合わせた数字は出さない（別々の値のまま並べる）", () => {
    const c = mount();
    expect(c.textContent).not.toContain("$55.30");
  });

  it("権限の無いリポジトリのタスクの件数だけを注記する（0 件なら出さない。金額は出さない）", () => {
    const c = mount();
    const note = c.querySelector("[data-hidden-tasks]");
    expect(note?.getAttribute("data-hidden-tasks")).toBe("1");
    expect(note?.textContent).toBe("権限の無いリポジトリのタスクが 1 件、費用の合計に含まれます。");
    expect(c.textContent).not.toContain("2.9");
    const zero = mount({
      ...overviewFixture,
      month: { ...overviewFixture.month, hidden_tasks: { count: 0, cost_usd: 0 } },
    });
    expect(zero.querySelector("[data-hidden-tasks]")).toBeNull();
  });

  it("幅 360px のための指定: 各行は budget-row、値は budget-value（折り返さない）、全員の行は区切る", () => {
    const c = mount();
    for (const k of ["spent", "remaining", "limit", "all"]) {
      expect(row(c, k)?.classList.contains("budget-row"), k).toBe(true);
      expect(row(c, k)?.querySelector("dd")?.classList.contains("budget-value"), k).toBe(true);
    }
    expect(row(c, "all")?.classList.contains("budget-row--all")).toBe(true);
  });
});
