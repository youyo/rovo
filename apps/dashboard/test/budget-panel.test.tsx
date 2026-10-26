import type { OverviewDto } from "@rovo/dashboard-contract";
import { overviewFixture } from "@rovo/dashboard-contract/fixtures";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { BudgetPanel } from "../src/side-panels";
import { inEn, inJa } from "./lang";

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
    root.render(inJa(createElement(BudgetPanel, { data })));
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

  it("「同時に N 件始められます」を残す", () => {
    const c = mount();
    expect(c.querySelector("[data-budget-startable]")?.textContent).toBe(
      "同時に 2 件始められます。",
    );
    const zero = mount({
      ...overviewFixture,
      budget: { ...overviewFixture.budget, startable: 0 },
    });
    expect(zero.textContent).toContain("同時に 0 件始められます。");
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

  describe("月のペース（1 行。契約も API も変えず、画面で計算する）", () => {
    const pace = (c: HTMLElement) => c.querySelector("[data-budget-pace]");

    it("月の N 日目で使った額と、この速さでの月末の見込みを 1 行で出す（UTC の月と明記）", () => {
      // 2026-10-21T06:00Z は 20.25 日経過（21 日目）。$11.40 → 1 日 $0.563 → 31 日で約 $17.45
      const c = mount();
      expect(pace(c)?.textContent).toBe(
        "UTC の月の 21 日目で $11.40 使いました。この速さだと月末に約 $17.45 の見込みです。",
      );
      expect(pace(c)?.getAttribute("data-budget-pace")).toBe("ok");
      expect(c.querySelectorAll("[data-budget-pace]")).toHaveLength(1);
    });

    it("上限を超える見込みなら、色だけに頼らず文言で示す", () => {
      const c = mount({ ...overviewFixture, budget: { ...overviewFixture.budget, spent_usd: 40 } });
      expect(pace(c)?.getAttribute("data-budget-pace")).toBe("over");
      expect(pace(c)?.textContent).toContain("約 $61.23");
      expect(pace(c)?.textContent).toContain("上限 $49.90 を超える見込みです。");
    });

    it("1 日未満（月の初日）は「まだ見込みを出せません」。0 円は 0 円の見込み", () => {
      const early = mount({
        ...overviewFixture,
        generated_at: "2026-10-01T10:00:00Z",
      });
      expect(pace(early)?.getAttribute("data-budget-pace")).toBe("early");
      expect(pace(early)?.textContent).toBe("まだ見込みを出せません（UTC の月の初日）。");
      document.body.innerHTML = "";
      const zero = mount({
        ...overviewFixture,
        budget: { ...overviewFixture.budget, spent_usd: 0 },
      });
      expect(pace(zero)?.textContent).toContain("約 $0 の見込みです。");
      expect(pace(zero)?.getAttribute("data-budget-pace")).toBe("ok");
    });

    it("上限が分からないとき（古い応答で逆算もできない）は超過の判定をしない", () => {
      const { monthly_budget_usd: _omit, ...legacy } = overviewFixture.budget;
      const c = mount({
        ...overviewFixture,
        budget: { ...legacy, spent_usd: 400, remaining_usd: 0 },
      });
      expect(pace(c)?.getAttribute("data-budget-pace")).toBe("ok");
      expect(pace(c)?.textContent).not.toContain("超える");
    });

    it("英語の文言", () => {
      const container = document.createElement("div");
      document.body.append(container);
      const root = createRoot(container);
      roots.push(root);
      act(() => {
        root.render(
          inEn(
            createElement(BudgetPanel, {
              data: { ...overviewFixture, budget: { ...overviewFixture.budget, spent_usd: 40 } },
            }),
          ),
        );
      });
      expect(pace(container)?.textContent).toBe(
        "Day 21 of the UTC month: $40.00 spent. At this pace, about $61.23 by month end. Projected to exceed your $49.90 limit.",
      );
    });
  });
});
