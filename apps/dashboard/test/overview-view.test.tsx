import type { OverviewDto } from "@rovo/dashboard-contract";
import { overviewFixture, overviewMeFixture } from "@rovo/dashboard-contract/fixtures";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { OverviewView } from "../src/overview-view";
import { TL_AXIS_H, TL_BAND_H, TL_MIN_LANE_H } from "../src/timeline-view";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const roots: { unmount: () => void }[] = [];
afterEach(() => {
  for (const r of roots.splice(0)) act(() => r.unmount());
  document.body.innerHTML = "";
});

function mount(data: OverviewDto, extra: { stale?: boolean; selectedId?: string | null } = {}) {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  act(() => {
    root.render(
      createElement(OverviewView, {
        data,
        autoRefresh: true,
        onAutoRefreshChange: () => {},
        onRefresh: () => {},
        stale: extra.stale ?? false,
        selectedId: extra.selectedId ?? null,
        console: createElement("section", { className: "console" }, "コンソールの場所"),
      }),
    );
  });
  return container;
}

const lanesOf = (c: HTMLElement) =>
  [...c.querySelectorAll("[data-lane]")].map((e) => e.getAttribute("data-lane"));

describe("OverviewView（骨格: 細いタイムライン帯・レール・コンソール・ステータスバー）", () => {
  it("構成: 帯 → レール + コンソール → ステータスバー の順", () => {
    const c = mount(overviewFixture);
    const band = c.querySelector(".tlband") as HTMLElement;
    const main = c.querySelector(".main") as HTMLElement;
    const bar = c.querySelector(".statusbar") as HTMLElement;
    expect(band).not.toBeNull();
    expect(main.querySelector("nav.rail")).not.toBeNull();
    expect(main.querySelector(".console")?.textContent).toBe("コンソールの場所");
    const order = [band, main, bar].map((e) =>
      [...(c.querySelectorAll("*") as NodeListOf<Element>)].indexOf(e),
    );
    expect(order).toEqual([...order].sort((a, b) => a - b));
  });

  it("全員: owner_login ごとのレーン。自分: 自分だけ", () => {
    expect(lanesOf(mount(overviewFixture))).toEqual([
      "alice-example",
      "bob-example",
      "carol-example",
    ]);
    document.body.innerHTML = "";
    expect(lanesOf(mount(overviewMeFixture))).toEqual(["alice-example"]);
  });

  it("タイムラインは細い帯（行ごとの高さ + 軸が 48px 前後に収まる）", () => {
    const heights = (c: HTMLElement) => {
      const lanes = [...c.querySelectorAll("svg.lane-svg")].map((e) =>
        Number(e.getAttribute("height")),
      );
      const axis = Number(c.querySelector("svg.axis-svg")?.getAttribute("height"));
      return { lanes, axis };
    };
    const three = heights(mount(overviewFixture));
    expect(three.axis).toBe(TL_AXIS_H);
    expect(three.lanes.reduce((a, b) => a + b, 0) + three.axis).toBeLessThanOrEqual(TL_BAND_H);
    expect(three.lanes.every((h) => h >= TL_MIN_LANE_H)).toBe(true);
    document.body.innerHTML = "";
    const one = heights(mount(overviewMeFixture));
    expect(one.lanes.reduce((a, b) => a + b, 0) + one.axis).toBeLessThanOrEqual(TL_BAND_H);
    expect(TL_BAND_H).toBeGreaterThanOrEqual(44);
    expect(TL_BAND_H).toBeLessThanOrEqual(56);
  });

  it("棒はタスク詳細へのリンク。状態は aria-label と data 属性に文字で出る（色だけに頼らない）", () => {
    const c = mount(overviewFixture);
    const bars = [...c.querySelectorAll("svg a[data-task]")];
    expect(bars).toHaveLength(5);
    for (const a of bars) {
      expect(a.getAttribute("href")).toMatch(/^\/dashboard\/tasks\/[0-9A-HJKMNP-TV-Z]{26}$/);
      expect(a.getAttribute("aria-label")).toMatch(/マージ済み|レビュー待ち|失敗|実行中/);
      expect(a.getAttribute("data-mark")).toBeTruthy();
    }
    const failed = bars.find((a) => a.getAttribute("data-status") === "FAILED");
    expect(failed?.getAttribute("aria-label")).toContain("失敗");
    expect(bars.filter((a) => a.getAttribute("data-mark") === "merged")).toHaveLength(2);
  });

  it("consult は点、いまの破線、時刻の目盛り", () => {
    const c = mount(overviewFixture);
    expect(c.querySelectorAll("[data-consult]")).toHaveLength(3);
    expect(c.querySelector("[data-now]")).toBeTruthy();
    expect(c.querySelectorAll("[data-tick]").length).toBeGreaterThanOrEqual(3);
  });

  it("今日のタスクが無いときは、帯の代わりに空の表示。レールにも空の表示", () => {
    const empty: OverviewDto = { ...overviewMeFixture, tasks: [], consults: [] };
    const c = mount(empty);
    expect(c.textContent).toContain("今日のタスクはまだありません");
    expect(c.querySelector("a.rail-row")).toBeNull();
    expect(c.querySelector("[data-lane]")).toBeNull();
  });

  it("レール: 新しい開始が上。選択中の行を示す", () => {
    const sel = overviewFixture.tasks[2]?.task_id as string;
    const c = mount(overviewFixture, { selectedId: sel });
    const rows = [...c.querySelectorAll("a.rail-row")];
    expect(rows).toHaveLength(5);
    expect(c.querySelector("a.rail-row[aria-current='true']")?.getAttribute("data-task-id")).toBe(
      sel,
    );
  });

  it("更新に失敗した直後（stale）は、前のデータのまま注意を出す", () => {
    const c = mount(overviewFixture, { stale: true });
    expect(c.textContent).toContain("更新できませんでした");
    expect(c.querySelectorAll("a.rail-row")).toHaveLength(5);
  });
});

describe("内訳の引き出し（情報を消さない。開閉できる）", () => {
  it("権限の無いタスクの注記は件数だけ。0 件なら出さない", () => {
    const c = mount(overviewFixture);
    expect(c.textContent).toContain("権限の無いリポジトリのタスクが 1 件、費用の合計に含まれます");
    expect(c.textContent).not.toContain("2.9"); // 隠れた分の金額は出さない
    document.body.innerHTML = "";
    const zero: OverviewDto = {
      ...overviewFixture,
      month: { ...overviewFixture.month, hidden_tasks: { count: 0, cost_usd: 0 } },
    };
    expect(mount(zero).textContent).not.toContain("権限の無いリポジトリ");
  });

  it("予算は 2 つの数字を分けて出す（自分と全員を足し合わせない・予約額を出さない）", () => {
    const c = mount(overviewFixture);
    const mine = c.querySelector(".drawer [data-budget='me']");
    const all = c.querySelector(".drawer [data-budget='all']");
    expect(mine?.textContent).toContain("あなたの今月の予算");
    expect(mine?.textContent).toContain("$11.40");
    expect(mine?.textContent).toContain("$38.50");
    expect(mine?.textContent).toContain("あと 2 件始められます");
    expect(all?.textContent).toContain("全員の今月の実績");
    expect(all?.textContent).toContain("UTC の月");
    expect(all?.textContent).toContain("$43.90");
    const text = c.textContent ?? "";
    expect(text).not.toContain("$55.30"); // 11.4 + 43.9 の足し算
    expect(text).not.toContain("$5.00");
    expect(text).not.toContain("予約");
  });

  it("モデル別の費用: タスクと相談を分けて出す。件数は出さない", () => {
    const c = mount(overviewFixture);
    const models = c.querySelector(".drawer [data-models]");
    expect(models?.textContent).toContain("example-model-large");
    expect(models?.textContent).toContain("$30.60");
    expect(models?.textContent).toContain("$2.10");
    expect(models?.textContent).not.toMatch(/\d+ 件/);
  });

  it("モデル名は途中で折り返さず、接頭辞を省いて title に全体を入れる", () => {
    const data: OverviewDto = {
      ...overviewFixture,
      models: [{ model: "anthropic/claude-haiku-5-5", task_cost_usd: 1, consult_cost_usd: 0 }],
    };
    const c = mount(data);
    const side = c.querySelector(".drawer [data-models] .model-name");
    expect(side?.textContent).toBe("claude-haiku-5-5");
    expect(side?.getAttribute("title")).toBe("anthropic/claude-haiku-5-5");
  });

  it("凡例: 閉じた PR は「閉じた」、取れなかった(unknown)は「PR あり」。マージ件数に入らない", () => {
    const withState = (state: "open" | "merged" | "closed" | "unknown"): OverviewDto => ({
      ...overviewFixture,
      tasks: overviewFixture.tasks.map((t) =>
        t.status === "COMPLETED" && t.pr && !t.pr.merged ? { ...t, pr: { ...t.pr, state } } : t,
      ),
    });
    const closed = mount(withState("closed"));
    expect(closed.querySelector('[data-mark="closed"]')).not.toBeNull();
    expect(closed.querySelector('[aria-label="凡例"]')?.textContent).toContain("閉じた");
    document.body.innerHTML = "";
    const unknown = mount(withState("unknown"));
    expect(unknown.querySelector('[aria-label="凡例"]')?.textContent).toContain("PR あり");
  });

  it("下に「HH:MM に更新。…」と自動更新のチェック（引き出しの中）", () => {
    const c = mount(overviewFixture);
    expect(c.querySelector(".drawer")?.textContent).toContain(
      "に更新。あなたが GitHub で見られるリポジトリのタスクだけを表示しています。",
    );
    const box = c.querySelector(".drawer input[type='checkbox']") as HTMLInputElement;
    expect(box.checked).toBe(true);
    expect(box.closest("label")?.textContent).toContain("自動で更新する");
  });
});

describe("表示の安全（D14）", () => {
  const evil: OverviewDto = {
    ...overviewFixture,
    tasks: overviewFixture.tasks.map((t, i) =>
      i === 0
        ? {
            ...t,
            title: "‮gpj.exe\u0007<img src=x onerror=alert(1)>\n改行",
            pr: { ...(t.pr as NonNullable<typeof t.pr>), url: "javascript:alert(1)" },
          }
        : t,
    ),
  };

  it("制御文字は除き、HTML は文字として出る。<img> は作らない", () => {
    const c = mount(evil);
    expect(c.querySelector("img")).toBeNull();
    const text = c.textContent ?? "";
    expect(text.includes("\u0007")).toBe(false);
    expect(/[‪-‮⁦-⁩]/.test(text)).toBe(false);
    expect(text).toContain("<img src=x onerror=alert(1)>");
  });

  it("リンクは /dashboard/ 配下か Cloudflare のトップだけ（javascript: などを作らない）", () => {
    const c = mount(evil);
    expect(c.querySelector("a[href^='javascript:']")).toBeNull();
    for (const a of c.querySelectorAll("a")) {
      const h = a.getAttribute("href") ?? "";
      expect(h.startsWith("/dashboard/") || /^https:\/\/github\.com\//.test(h)).toBe(true);
    }
  });

  it("マークアップに style 属性・style 要素・外部ホストへの参照を作らない", () => {
    const c = mount(overviewFixture);
    expect(c.innerHTML).not.toMatch(/\sstyle=/i);
    expect(c.innerHTML).not.toMatch(/<style/i);
    expect(c.innerHTML).not.toMatch(/(src|href)="https?:\/\/(?!github\.com\/)/);
  });
});
