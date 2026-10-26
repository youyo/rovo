import type { OverviewDto, VisibleTaskDto, WaitingDto } from "@rovo/dashboard-contract";
import { overviewFixture, waitingFixture } from "@rovo/dashboard-contract/fixtures";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TeamBoard } from "../src/team-board";
import { clickLink } from "./click-link";
import { inEn, inJa, tEn } from "./lang";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const roots: { unmount: () => void }[] = [];
afterEach(() => {
  vi.unstubAllGlobals();
  for (const r of roots.splice(0)) act(() => r.unmount());
  document.body.innerHTML = "";
});

function mount(
  props: {
    data?: OverviewDto;
    waiting?: WaitingDto | null;
    isToday?: boolean;
    onSelectTask?: (id: string) => void;
  } = {},
  wrap: typeof inJa = inJa,
) {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  act(() => {
    root.render(
      wrap(
        createElement(TeamBoard, {
          data: props.data ?? overviewFixture,
          waiting: props.waiting === undefined ? waitingFixture : props.waiting,
          isToday: props.isToday ?? true,
          onSelectTask: props.onSelectTask,
        }),
      ),
    );
  });
  return container;
}

const text = (e: Element | null | undefined) => e?.textContent ?? "";
const person = (c: HTMLElement, login: string) =>
  c.querySelector(`li.tb-person[data-login="${login}"]`) as HTMLElement;
const statN = (el: Element, stat: string) =>
  text(el.querySelector(`[data-stat="${stat}"] .tb-stat-n`));

describe("チームボード: いま（人ごと）", () => {
  it("見出しは「いま」。1 行 1 人で、閲覧者が先頭、ほかは login 順", () => {
    const c = mount();
    expect(text(c.querySelector("#tb-people-h"))).toBe("いま");
    const logins = [...c.querySelectorAll("li.tb-person")].map((l) => l.getAttribute("data-login"));
    expect(logins[0]).toBe(overviewFixture.viewer.login);
    expect(logins).toEqual(["alice-example", ...logins.slice(1).slice().sort()]);
    expect(c.querySelector("li.tb-person[data-viewer='true']")?.getAttribute("data-login")).toBe(
      "alice-example",
    );
  });

  it("数は走行・質問待ち（いま）と完了・失敗・費用（今日）。日をまたいだ質問待ちも合わせる", () => {
    const c = mount();
    const bob = person(c, "bob-example");
    // overview: bob は RUNNING 1・FAILED 1。waiting（fixture）の bob の INPUT_REQUIRED は無い
    expect(statN(bob, "running")).toBe("1");
    expect(statN(bob, "failed")).toBe("1");
    const alice = person(c, "alice-example");
    // waiting の alice の INPUT_REQUIRED（前日から）
    expect(statN(alice, "asking")).toBe("1");
    expect(statN(alice, "done")).toBe("2");
    expect(text(alice.querySelector(".tb-cost"))).toContain("$4.19");
    // 「いま」は区画の見出しにあるので、行の中には小見出しを置かない
    expect(alice.querySelector('[data-group="now"] .tb-cap')).toBeNull();
    expect(text(alice.querySelector('[data-group="day"] .tb-cap'))).toBe("今日");
  });

  it("記号は ◌ ！ ✓ ✕ の形（色だけに頼らない）で、文字と title も付く", () => {
    const c = mount();
    const alice = person(c, "alice-example");
    const shapes = (s: string) =>
      alice.querySelector(`[data-stat="${s}"] svg`)?.getAttribute("data-shape");
    expect(shapes("running")).toBe("spinner");
    expect(shapes("asking")).toBe("bang");
    expect(shapes("done")).toBe("check");
    expect(shapes("failed")).toBe("cross");
    expect(alice.querySelector('[data-stat="asking"]')?.getAttribute("title")).toBe("質問待ち 1");
    expect(text(alice.querySelector('[data-stat="asking"] .tb-stat-label'))).toBe("質問待ち");
  });

  it("走行中・質問待ちのタスクを行の下に出す。質問待ちが先。印と題名とリポジトリと経過", () => {
    const c = mount();
    const alice = person(c, "alice-example");
    const tasks = [...alice.querySelectorAll("a.tb-task")];
    expect(tasks.map((a) => a.getAttribute("data-mark"))).toEqual(["input"]);
    const a = tasks[0] as HTMLAnchorElement;
    expect(a.getAttribute("href")).toBe(`/dashboard/tasks/${a.getAttribute("data-task-id")}`);
    expect(a.querySelector("svg[data-mark='input']")).not.toBeNull();
    expect(text(a.querySelector(".tb-task-state"))).toBe("入力待ち");
    expect(text(a.querySelector(".tb-task-repo"))).toContain("example-org/");
    expect(text(a.querySelector(".tb-task-time"))).not.toBe("");
    const bob = person(c, "bob-example");
    expect([...bob.querySelectorAll("a.tb-task")].map((x) => x.getAttribute("data-mark"))).toEqual([
      "running",
    ]);
  });

  it("4 件以上は 3 件まで出して「+n」", () => {
    const base = overviewFixture.tasks[3] as VisibleTaskDto;
    const many: VisibleTaskDto[] = Array.from({ length: 5 }, (_, i) => ({
      ...base,
      task_id: `01K8ZFM${String(i).padStart(19, "0")}`,
      title: `running ${i}`,
      started_at: `2026-10-21T0${i}:10:00Z`,
    }));
    const c = mount({ data: { ...overviewFixture, tasks: many }, waiting: null });
    const bob = person(c, "bob-example");
    expect(bob.querySelectorAll("a.tb-task")).toHaveLength(3);
    expect(text(bob.querySelector("[data-more]"))).toBe("+2");
  });

  it("タスクを押すと選ぶ（修飾キー付きはブラウザに任せる）", () => {
    const onSelect = vi.fn();
    const c = mount({ onSelectTask: onSelect });
    const link = c.querySelector("a.tb-task") as HTMLAnchorElement;
    expect(clickLink(link, {})).toBe(true);
    expect(onSelect).toHaveBeenCalledWith(link.getAttribute("data-task-id"));
    onSelect.mockClear();
    expect(clickLink(link, { ctrlKey: true })).toBe(false);
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("review の kind は件数・走行・リストに入らない", () => {
    const run = overviewFixture.tasks[3] as VisibleTaskDto;
    const review: VisibleTaskDto = {
      ...run,
      task_id: "01K8ZFR00000000000000000R1",
      title: "review-only-title",
      kind: "review",
    };
    const c = mount({
      data: { ...overviewFixture, tasks: [...overviewFixture.tasks, review] },
      waiting: null,
    });
    expect(statN(person(c, "bob-example"), "running")).toBe("1");
    expect(c.textContent).not.toContain("review-only-title");
  });
});

describe("チームボード: リポジトリ別", () => {
  it("見出し・表・今日の件数（走行）・待ちの PR（GitHub の PR へのリンク）", () => {
    const c = mount();
    expect(text(c.querySelector("#tb-repos-h"))).toBe("リポジトリ別今日");
    const heads = [...c.querySelectorAll(".tb-repos thead th")].map((h) => h.textContent);
    expect(heads).toEqual(["リポジトリ", "今日の件数", "待ちの PR"]);
    const web = c.querySelector('tr[data-repo="example-org/web-app"]') as HTMLElement;
    expect(text(web.querySelector(".tb-count"))).toBe("2");
    const infra = c.querySelector('tr[data-repo="example-org/infra-tools"]') as HTMLElement;
    expect(text(infra.querySelector(".tb-repo-run"))).toContain("走行");
    const prs = [...c.querySelectorAll("a.tb-pr")] as HTMLAnchorElement[];
    expect(prs.length).toBeGreaterThan(0);
    for (const a of prs) {
      expect(a.href).toMatch(/^https:\/\/github\.com\/example-org\/[^/]+\/pull\/\d+$/);
      expect(a.rel).toContain("noopener");
      expect(a.textContent).toMatch(/^#\d+$/);
    }
  });

  it("件数は多い順", () => {
    const c = mount();
    const counts = [...c.querySelectorAll(".tb-repos tbody .tb-count")].map((e) =>
      Number(e.textContent),
    );
    expect(counts).toEqual([...counts].sort((a, b) => b - a));
  });
});

describe("チームボード: 過去の日", () => {
  it("走行中の欄（いま・質問待ち・走行中のタスク・リポジトリの走行）を出さず、その日の完了・失敗・費用だけ", () => {
    const c = mount({ isToday: false });
    expect(text(c.querySelector("#tb-people-h"))).toBe("この日");
    expect(c.querySelector('[data-group="now"]')).toBeNull();
    expect(c.querySelector('[data-stat="running"]')).toBeNull();
    expect(c.querySelector('[data-stat="asking"]')).toBeNull();
    expect(c.querySelector("a.tb-task")).toBeNull();
    expect(c.querySelector(".tb-repo-run")).toBeNull();
    expect(text(c.querySelector('[data-group="day"] .tb-cap'))).toBe("この日");
    expect(statN(person(c, "alice-example"), "done")).toBe("2");
    expect(text(c.querySelector("#tb-repos-h"))).toBe("リポジトリ別この日");
  });
});

describe("チームボード: 英語・漏れ", () => {
  it("英語の見出し", () => {
    const c = mount({}, inEn);
    expect(text(c.querySelector("#tb-people-h"))).toBe("Now");
    expect(text(c.querySelector("#tb-repos-h"))).toBe("By repositoryToday");
    expect(text(c.querySelector('[data-stat="asking"] .tb-stat-label'))).toBe("Waiting for answer");
  });

  it("権限の無いタスクの情報（hidden）は出ない", () => {
    const c = mount();
    expect(c.textContent).not.toContain("dave-hidden-example");
    expect(c.textContent).not.toContain("hidden-repo");
  });
});

describe("チームボード: 今月の費用（UTC・人ごと）", () => {
  const data: OverviewDto = {
    ...overviewFixture,
    generated_at: "2026-10-16T00:00:00.000Z",
    budget: { ...overviewFixture.budget, monthly_budget_usd: 100 },
    month: {
      ...overviewFixture.month,
      by_owner: [
        { login: "bob-example", task_cost_usd: 60, consult_cost_usd: 0 },
        { login: "alice-example", task_cost_usd: 1, consult_cost_usd: 1 },
      ],
      hidden: { count: 3, cost_usd: 4.5 },
    },
  };

  it("リポジトリ別の下に出る。1 行 1 人・バー・額 / 上限・割合・ペース（文字と記号）", () => {
    const c = mount({ data }, inEn);
    const sections = [...c.querySelectorAll("section.tb-section h2")].map((h) => text(h));
    expect(sections[2]).toContain("This month (UTC)");
    const bob = c.querySelector('li.tb-month-row[data-login="bob-example"]') as HTMLElement;
    expect(bob.querySelector(".tb-month-bar")).not.toBeNull();
    expect(text(bob)).toContain("$60.00");
    expect(text(bob)).toContain("$100.00");
    expect(text(bob)).toContain("60%");
    expect(text(bob.querySelector("[data-pace]"))).toMatch(/▲/);
    const first = c.querySelector("li.tb-month-row");
    expect(first?.getAttribute("data-login")).toBe("alice-example");
    expect(text(c.querySelector("[data-month-hidden]"))).toContain("3");
    expect(text(c.querySelector("[data-month-hidden]"))).toContain("$4.50");
  });

  it("過去の日でも今月のまま。hidden が 0 件なら行を出さない。ja の見出し", () => {
    const c = mount(
      {
        data: { ...data, month: { ...data.month, hidden: { count: 0, cost_usd: 0 } } },
        isToday: false,
      },
      inJa,
    );
    expect(text(c.querySelector("#tb-month-h"))).toContain("今月");
    expect(c.querySelector("li.tb-month-row")).not.toBeNull();
    expect(c.querySelector("[data-month-hidden]")).toBeNull();
  });

  it("額の定義の注記を出す（予算の欄の額と一致しないことがある）", () => {
    const ja = mount({ data }, inJa);
    expect(text(ja.querySelector("[data-month-note]"))).toContain("予算の欄");
    const en = mount({ data }, inEn);
    expect(text(en.querySelector("[data-month-note]"))).toContain("budget panel");
  });

  it("残り・予約・あと何件は出さない", () => {
    const c = mount({ data }, inEn);
    expect(text(c.querySelector("#tb-month-h")?.parentElement)).not.toMatch(/remaining|reserved/i);
  });
});

describe("チームボード: 成果の推移（直近 14 日）", () => {
  const withFlow = (flow: Partial<NonNullable<OverviewDto["flow"]>> = {}): OverviewDto => ({
    ...overviewFixture,
    month: { ...overviewFixture.month, by_owner: [] },
    flow: {
      period: { start: "2026-10-08T00:00:00.000Z", end: "2026-10-22T00:00:00.000Z" },
      days: [
        { date: "2026-10-20", completed: 10, failed: 0, budget_exceeded: 0, cancelled: 0 },
        { date: "2026-10-21", completed: 6, failed: 2, budget_exceeded: 0, cancelled: 0 },
      ],
      median_duration_ms: 12 * 60_000,
      pr_merged: 5,
      hidden: { count: 3, failed: 1 },
      ...flow,
    },
  });

  it("4 つ目の区画。並びは いま → リポジトリ別 → 今月 → 成果の推移", () => {
    const c = mount({ data: withFlow() });
    const ids = [...c.querySelectorAll("section.tb-section h2")].map((h) => h.id);
    expect(ids).toEqual(["tb-people-h", "tb-repos-h", "tb-month-h", "tb-flow-h"]);
    expect(text(c.querySelector("#tb-flow-h"))).toContain("14");
  });

  it("棒は 14 日分。失敗のある日だけ、色でなく形（斜線の塗り）の失敗の棒がある", () => {
    const c = mount({ data: withFlow() });
    const days = c.querySelectorAll("[data-flow] [data-day]");
    expect(days).toHaveLength(14);
    expect(c.querySelectorAll("[data-flow] [data-fail-mark]")).toHaveLength(1);
    const fail = c.querySelector("[data-day='2026-10-21'] [data-fail-mark]");
    expect(fail).not.toBeNull();
    // 完了の棒（無地の塗り）と形が違う: 斜線のパターンの塗り + 枠
    expect(fail?.getAttribute("fill")).toMatch(/^url\(#/);
    expect(
      c.querySelector("[data-day='2026-10-21'] .tb-flow-bar")?.getAttribute("fill"),
    ).toBeNull();
  });

  it("失敗の棒も件数に比例した高さ（完了の棒と同じ縦軸・同じ基線）", () => {
    const c = mount({ data: withFlow() });
    const num = (el: Element | null, a: string) => Number.parseFloat(el?.getAttribute(a) ?? "NaN");
    const done = c.querySelector("[data-day='2026-10-21'] .tb-flow-bar");
    const fail = c.querySelector("[data-day='2026-10-21'] [data-fail-mark]");
    const peak = c.querySelector("[data-day='2026-10-20'] .tb-flow-bar");
    // 最大は 10 件（高さ 60）。6 件 = 36、2 件 = 12
    expect(num(peak, "height")).toBe(60);
    expect(num(done, "height")).toBe(36);
    expect(num(fail, "height")).toBe(12);
    expect(num(fail, "y") + num(fail, "height")).toBe(num(done, "y") + num(done, "height"));
    // 同じ日の 2 本は重ならず隣り合う（積み上げない）
    expect(num(fail, "x")).toBeGreaterThanOrEqual(num(done, "x") + num(done, "width"));
  });

  it("グラフは区画の幅いっぱい: 幅は 100%・高さは固定、棒の位置と幅は割合（% ）で、14 日が幅の中に並ぶ", () => {
    const c = mount({ data: withFlow() });
    const svg = c.querySelector("svg.tb-flow-chart");
    expect(svg?.getAttribute("width")).toBe("100%");
    expect(svg?.getAttribute("height")).toBe("61");
    expect(svg?.getAttribute("viewBox")).toBeNull();
    const rects = [...c.querySelectorAll("[data-flow] [data-day] rect")];
    for (const r of rects) {
      expect(r.getAttribute("x")).toMatch(/^\d+(\.\d+)?%$/);
      expect(r.getAttribute("width")).toMatch(/^\d+(\.\d+)?%$/);
      const right =
        Number.parseFloat(r.getAttribute("x") ?? "") +
        Number.parseFloat(r.getAttribute("width") ?? "");
      expect(right).toBeLessThanOrEqual(100);
    }
    // 日は左から右へ、幅を等分して並ぶ（最初の日は左端の近く、最後の日は右端の近く）
    const xs = [...c.querySelectorAll("[data-flow] [data-day] .tb-flow-bar")].map((r) =>
      Number.parseFloat(r.getAttribute("x") ?? ""),
    );
    expect(xs).toHaveLength(14);
    expect(xs[0]).toBeLessThan(5);
    expect(xs[13]).toBeGreaterThan(90);
  });

  it("失敗が完了より多い日は、縦軸の最大が失敗の件数になる", () => {
    const c = mount({
      data: withFlow({
        days: [{ date: "2026-10-20", completed: 2, failed: 8, budget_exceeded: 0, cancelled: 0 }],
      }),
    });
    const fail = c.querySelector("[data-day='2026-10-20'] [data-fail-mark]");
    const done = c.querySelector("[data-day='2026-10-20'] .tb-flow-bar");
    expect(Number(fail?.getAttribute("height"))).toBe(60);
    expect(Number(done?.getAttribute("height"))).toBe(15);
  });

  it("横軸に日付のラベル: 両端（14 日前と今日）と週の区切り。ロケールの短い書き方", () => {
    const ja = mount({ data: withFlow() }, inJa);
    const labels = (c: Element) =>
      [...c.querySelectorAll("[data-flow] [data-axis-label]")].map((e) => text(e));
    expect(labels(ja)).toEqual(["10/8", "10/15", "10/21"]);
    const en = mount({ data: withFlow() }, inEn);
    expect(labels(en)).toEqual(["10/8", "10/15", "10/21"]);
  });

  it("間引いた日も、読み上げ（aria-label）と title で日付と件数が分かる", () => {
    const c = mount({ data: withFlow() }, inJa);
    const g = c.querySelector("[data-day='2026-10-12']");
    expect(g?.getAttribute("role")).toBe("img");
    expect(g?.getAttribute("aria-label")).toBe("2026-10-12: 完了 0 件、失敗 0 件");
    expect(text(g?.querySelector("title") ?? null)).toBe("2026-10-12: 完了 0 件、失敗 0 件");
    // 横軸の文字は視覚用（読み上げは各日の aria-label が受け持つ）
    expect(
      c.querySelector("[data-flow] [data-axis-label]")?.closest("[aria-hidden='true']"),
    ).not.toBeNull();
  });

  it("失敗率は % と件数の併記、中央値、マージ数、脚注", () => {
    const c = mount({ data: withFlow() }, inEn);
    expect(text(c.querySelector("[data-flow-rate]"))).toContain("11%");
    expect(text(c.querySelector("[data-flow-rate]"))).toContain("2 / 18");
    expect(text(c.querySelector("[data-flow-median]"))).toContain("12");
    expect(text(c.querySelector("[data-flow-merged]"))).toContain("5");
    expect(text(c.querySelector("[data-flow-note]"))).toContain("merged directly on GitHub");
    expect(text(c.querySelector("[data-flow-hidden]"))).toContain("3");
  });

  it("日本語の脚注", () => {
    const c = mount({ data: withFlow() });
    expect(text(c.querySelector("[data-flow-note]"))).toBe(
      "rovo でマージした分だけ。GitHub で直接マージした分は入らない",
    );
  });

  it("完了・失敗が 0 件なら失敗率は「–」、中央値が無ければ「–」", () => {
    const c = mount({ data: withFlow({ days: [], median_duration_ms: null, pr_merged: 0 }) });
    expect(text(c.querySelector("[data-flow-rate]"))).not.toContain("%");
    expect(text(c.querySelector("[data-flow-median]"))).toContain("–");
  });

  it("過去の日を見ていても直近 14 日のまま", () => {
    const c = mount({ data: withFlow(), isToday: false });
    expect(c.querySelectorAll("[data-flow] [data-day]")).toHaveLength(14);
    expect(c.querySelector("[data-flow-rate]")).not.toBeNull();
  });

  it("flow が無い古い応答では区画を出さない", () => {
    expect(mount().querySelector("[data-flow]")).toBeNull();
  });
});

function stubNarrow(narrow: boolean) {
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: narrow && query.includes("max-width: 720px"),
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
  }));
}

describe("チームボード: 狭い幅の重複の整理と列見出し", () => {
  it("過去の日の表の列見出しは「件数」（表の題に「この日」がある）。英語も短い", () => {
    const c = mount({ isToday: false });
    const heads = [...c.querySelectorAll(".tb-repos thead th")].map((h) => h.textContent);
    expect(heads).toEqual(["リポジトリ", "件数", "待ちの PR"]);
    expect(tEn("board.colCountDay")).toBe("Tasks");
  });

  it("狭い幅の過去の日: 人ごとの行に「この日」のラベルを出さない（箱の見出しは残る）", () => {
    stubNarrow(true);
    const c = mount({ isToday: false });
    expect(text(c.querySelector("#tb-people-h"))).toBe("この日");
    expect(c.querySelector("li.tb-person .tb-cap")).toBeNull();
  });

  it("広い幅の過去の日: 従来どおり人ごとの行に「この日」", () => {
    stubNarrow(false);
    const c = mount({ isToday: false });
    expect(text(c.querySelector("li.tb-person .tb-cap"))).toBe("この日");
  });
});
