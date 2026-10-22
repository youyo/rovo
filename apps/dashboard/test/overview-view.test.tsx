import type { OverviewDto } from "@rovo/dashboard-contract";
import { overviewFixture, overviewMeFixture } from "@rovo/dashboard-contract/fixtures";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { formatClock, formatDayHeading } from "../src/format";
import { OverviewView } from "../src/overview-view";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const roots: { unmount: () => void }[] = [];
afterEach(() => {
  for (const r of roots.splice(0)) act(() => r.unmount());
  document.body.innerHTML = "";
});

function mount(data: OverviewDto, extra: { stale?: boolean } = {}) {
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
      }),
    );
  });
  return container;
}

const lanesOf = (c: HTMLElement) =>
  [...c.querySelectorAll("[data-lane]")].map((e) => e.getAttribute("data-lane"));

describe("OverviewView（fixtures で一覧が出る）", () => {
  it("見出しは範囲の開始日（ローカル）の日付", () => {
    const c = mount(overviewFixture);
    expect(c.querySelector("h1")?.textContent).toBe(
      formatDayHeading(Date.parse(overviewFixture.range.from)),
    );
  });

  it("要約: 実行したタスクの件数とマージ件数。費用を足し合わせない", () => {
    const c = mount(overviewFixture);
    expect(c.textContent).toContain("5 件のタスクを実行し、2 件をマージしました。");
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
    const merged = bars.filter((a) => a.getAttribute("data-mark") === "merged");
    expect(merged).toHaveLength(2);
  });

  it("consult は灰の点（タイムラインの上）、いまの破線、時刻の目盛り", () => {
    const c = mount(overviewFixture);
    expect(c.querySelectorAll("[data-consult]")).toHaveLength(3);
    expect(c.querySelector("[data-now]")).toBeTruthy();
    expect(c.querySelectorAll("[data-tick]").length).toBeGreaterThanOrEqual(3);
  });

  it("表: 行ごとに状態の印 + 文字、題名はタスク詳細へ、PR 列だけ GitHub へ（noopener noreferrer）", () => {
    const c = mount(overviewFixture);
    const rows = [...c.querySelectorAll("tbody tr")];
    expect(rows).toHaveLength(5);
    const first = rows[0] as Element;
    const detail = first.querySelector("a[href^='/dashboard/tasks/']");
    expect(detail).toBeTruthy();
    const external = [...c.querySelectorAll("tbody a[href^='https://']")];
    expect(external).toHaveLength(5);
    for (const a of external) {
      expect(a.getAttribute("href")).toMatch(
        /^https:\/\/github\.com\/[A-Za-z0-9-]+\/[A-Za-z0-9._-]+\/pull\/[0-9]+$/,
      );
      expect(a.getAttribute("rel")).toBe("noopener noreferrer");
    }
    const text = rows.map((r) => r.textContent).join("\n");
    for (const w of ["マージ済み", "レビュー待ち", "失敗", "実行中"]) expect(text).toContain(w);
  });

  it("表は新しい開始が上", () => {
    const c = mount(overviewFixture);
    const ids = [...c.querySelectorAll("tbody tr a[href^='/dashboard/tasks/']")].map((a) =>
      a.getAttribute("href"),
    );
    const expected = [...overviewFixture.tasks]
      .sort(
        (a, b) =>
          Date.parse(b.started_at ?? b.created_at) - Date.parse(a.started_at ?? a.created_at),
      )
      .map((t) => `/dashboard/tasks/${t.task_id}`);
    expect(ids).toEqual(expected);
  });

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

  it("予算は 2 つの数字を分けて出す（足し合わせない・分母や予約額を出さない）", () => {
    const c = mount(overviewFixture);
    const mine = c.querySelector("[data-budget='me']");
    const all = c.querySelector("[data-budget='all']");
    expect(mine?.textContent).toContain("あなたの今月の予算");
    expect(mine?.textContent).toContain("$11.40");
    expect(mine?.textContent).toContain("$38.50");
    expect(mine?.textContent).toContain("あと 2 件始められます");
    expect(all?.textContent).toContain("全員の今月の実績");
    expect(all?.textContent).toContain("UTC の月");
    expect(all?.textContent).toContain("$43.90");
    const text = c.textContent ?? "";
    expect(text).not.toContain("$49.90"); // 11.4 + 38.5 の足し算
    expect(text).not.toContain("$5.00");
    expect(text).not.toContain("予約");
  });

  it("モデル別の費用: タスクと相談を分けて出す。件数は出さない", () => {
    const c = mount(overviewFixture);
    const models = c.querySelector("[data-models]");
    expect(models?.textContent).toContain("example-model-large");
    expect(models?.textContent).toContain("$30.60");
    expect(models?.textContent).toContain("$2.10");
    expect(models?.textContent).not.toMatch(/\d+ 件/);
  });

  it("モデル名は途中で折り返さず、接頭辞を省いて title に全体を入れる（右の列も表も）", () => {
    const data: OverviewDto = {
      ...overviewFixture,
      models: [{ model: "anthropic/claude-haiku-5-5", task_cost_usd: 1, consult_cost_usd: 0 }],
      tasks: overviewFixture.tasks.map((t) => ({ ...t, model: "anthropic/claude-haiku-5-5" })),
    };
    const c = mount(data);
    const side = c.querySelector("[data-models] .model-name");
    expect(side?.textContent).toBe("claude-haiku-5-5");
    expect(side?.getAttribute("title")).toBe("anthropic/claude-haiku-5-5");
    const cell = c.querySelector("tbody td[data-model]");
    expect(cell?.textContent).toBe("claude-haiku-5-5");
    expect(cell?.getAttribute("title")).toBe("anthropic/claude-haiku-5-5");
  });

  it("下に「HH:MM に更新。…」", () => {
    const c = mount(overviewFixture);
    expect(c.textContent).toContain(
      `${formatClock(Date.parse(overviewFixture.generated_at))} に更新。あなたが GitHub で見られるリポジトリのタスクだけを表示しています。`,
    );
  });

  it("今日のタスクが無いときは空の表示", () => {
    const empty: OverviewDto = { ...overviewMeFixture, tasks: [], consults: [] };
    const c = mount(empty);
    expect(c.textContent).toContain("今日のタスクはまだありません");
    expect(c.querySelector("tbody tr")).toBeNull();
  });

  it("更新に失敗した直後（stale）は、前のデータのまま注意を出す", () => {
    const c = mount(overviewFixture, { stale: true });
    expect(c.textContent).toContain("更新できませんでした");
    expect(c.querySelectorAll("tbody tr")).toHaveLength(5);
  });

  it("自動更新のチェックボックスがある", () => {
    const c = mount(overviewFixture);
    const box = c.querySelector("input[type='checkbox']") as HTMLInputElement;
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
            title: "\u202Egpj.exe\u0007<img src=x onerror=alert(1)>\n改行",
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
    expect(/[\u202A-\u202E\u2066-\u2069]/.test(text)).toBe(false);
    expect(text).toContain("<img src=x onerror=alert(1)>");
  });

  it("許可の形でない PR の URL はリンクにしない（javascript: など）", () => {
    const c = mount(evil);
    expect(c.querySelector("a[href^='javascript:']")).toBeNull();
    const hrefs = [...c.querySelectorAll("a")].map((a) => a.getAttribute("href") ?? "");
    for (const h of hrefs) {
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
