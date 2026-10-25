import type { OverviewDto, WaitingDto } from "@rovo/dashboard-contract";
import {
  overviewFixture,
  waitingEmptyFixture,
  waitingFixture,
  waitingMeFixture,
} from "@rovo/dashboard-contract/fixtures";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OverviewView } from "../src/overview-view";
import type { WaitingState } from "../src/use-waiting";
import { BROWSER_CLICKS, clickLink } from "./click-link";
import { inEn, inJa } from "./lang";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const roots: { unmount: () => void }[] = [];
afterEach(() => {
  for (const r of roots.splice(0)) act(() => r.unmount());
  document.body.innerHTML = "";
});

const ready = (data: WaitingDto): WaitingState => ({ phase: "ready", data, stale: false });

function mount(
  extra: {
    data?: OverviewDto;
    waiting?: WaitingState;
    railTab?: "day" | "waiting";
    onRailTabChange?: (tab: "day" | "waiting") => void;
    onSelectTask?: (id: string) => void;
    selectedId?: string | null;
    en?: boolean;
  } = {},
) {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  const wrap = extra.en ? inEn : inJa;
  act(() => {
    root.render(
      wrap(
        createElement(OverviewView, {
          data: extra.data ?? overviewFixture,
          autoRefresh: true,
          onAutoRefreshChange: () => {},
          onRefresh: () => {},
          stale: false,
          isToday: true,
          selectedId: extra.selectedId ?? null,
          onSelectTask: extra.onSelectTask,
          waiting: extra.waiting,
          railTab: extra.railTab,
          onRailTabChange: extra.onRailTabChange,
          console: createElement("section", { className: "console" }, "コンソールの場所"),
        }),
      ),
    );
  });
  return container;
}

const tabs = (c: HTMLElement) =>
  [...c.querySelectorAll("fieldset.rail-tabs button")] as HTMLButtonElement[];
const rows = (c: HTMLElement) => [...c.querySelectorAll("a.rail-row")] as HTMLAnchorElement[];

describe("レールの「この日 / 待ち」の切り替え", () => {
  it("上に 2 択のタブ（全員 / 自分と同じ見た目）。待ちの件数をタブに添える。選択中は aria-pressed", () => {
    const c = mount({ waiting: ready(waitingFixture), railTab: "day", onRailTabChange: () => {} });
    const fs = c.querySelector("fieldset.rail-tabs");
    expect(fs).not.toBeNull();
    expect(fs?.getAttribute("aria-label")).toBe("レールの表示（日付別 / 要対応）");
    expect(tabs(c).map((b) => b.textContent)).toEqual([
      "日付別",
      `要対応 ${waitingFixture.tasks.length}`,
    ]);
    expect(tabs(c).map((b) => b.getAttribute("aria-pressed"))).toEqual(["true", "false"]);
    // タブはレールの上（同じ列の中）にある
    expect(c.querySelector(".rail-col > fieldset.rail-tabs + nav.rail")).not.toBeNull();
  });

  it("onRailTabChange が無ければタブを出さない（従来の骨格のまま）", () => {
    const c = mount();
    expect(c.querySelector("fieldset.rail-tabs")).toBeNull();
    expect(c.querySelector(".rail-col")).toBeNull();
    expect(c.querySelector("nav.rail")).not.toBeNull();
  });

  it("タブを押すと onRailTabChange(tab) が呼ばれる", () => {
    const onChange = vi.fn();
    const c = mount({ waiting: ready(waitingFixture), railTab: "day", onRailTabChange: onChange });
    act(() => tabs(c)[1]?.click());
    expect(onChange).toHaveBeenCalledWith("waiting");
    act(() => tabs(c)[0]?.click());
    expect(onChange).toHaveBeenLastCalledWith("day");
  });

  it("「この日」では日のタスクを、「待ち」では待ちのタスク（日付に関係なく）を出す", () => {
    const day = mount({
      waiting: ready(waitingFixture),
      railTab: "day",
      onRailTabChange: () => {},
    });
    expect(rows(day).map((a) => a.dataset.taskId)).toEqual(
      expect.arrayContaining(overviewFixture.tasks.map((t) => t.task_id)),
    );
    expect(rows(day)).toHaveLength(overviewFixture.tasks.length);
    document.body.innerHTML = "";
    const w = mount({
      waiting: ready(waitingFixture),
      railTab: "waiting",
      onRailTabChange: () => {},
    });
    const ids = rows(w).map((a) => a.dataset.taskId);
    expect(new Set(ids)).toEqual(new Set(waitingFixture.tasks.map((t) => t.task_id)));
    // 行の形は既存と同じ（印・題名・モデル・費用・PR）。全員のときは依頼者も出る
    for (const a of rows(w)) {
      expect(a.querySelector(".rail-title")).not.toBeNull();
      expect(a.querySelector(".rail-model")).not.toBeNull();
      expect(a.querySelector(".rail-cost")).not.toBeNull();
      expect(a.querySelector(".rail-owner")).not.toBeNull();
      expect(a.dataset.mark).toBeTruthy();
    }
    // 待ちは INPUT_REQUIRED の印（input）と、レビュー待ちの印（review）
    expect(new Set(rows(w).map((a) => a.dataset.mark))).toEqual(new Set(["input", "review"]));
  });

  it("自分の絞り込み（scope=me）の待ちは依頼者を出さない", () => {
    const c = mount({
      waiting: ready(waitingMeFixture),
      railTab: "waiting",
      onRailTabChange: () => {},
    });
    expect(rows(c)).toHaveLength(waitingMeFixture.tasks.length);
    expect(c.querySelector(".rail-owner")).toBeNull();
  });

  it("行を押すと、既存と同じ選択の仕組み（onSelectTask。修飾キー付きはリンクのまま）", () => {
    const onSelect = vi.fn();
    const first = waitingFixture.tasks[0];
    const c = mount({
      waiting: ready(waitingFixture),
      railTab: "waiting",
      onRailTabChange: () => {},
      onSelectTask: onSelect,
    });
    const a = rows(c)[0] as HTMLAnchorElement;
    expect(a.getAttribute("href")).toBe(`/dashboard/tasks/${first?.task_id}`);
    expect(clickLink(a)).toBe(true);
    expect(onSelect).toHaveBeenCalledWith(first?.task_id);
    onSelect.mockClear();
    for (const b of BROWSER_CLICKS) {
      expect(clickLink(a, b.init), b.name).toBe(false);
    }
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("選択中のタスクは待ちの一覧でも aria-current", () => {
    const target = waitingFixture.tasks[1]?.task_id as string;
    const c = mount({
      waiting: ready(waitingFixture),
      railTab: "waiting",
      onRailTabChange: () => {},
      selectedId: target,
    });
    const current = c.querySelector("a.rail-row[aria-current='true']") as HTMLElement;
    expect(current.dataset.taskId).toBe(target);
  });

  it("待ちが空なら「待っているタスクはありません」。件数は 0 と添える", () => {
    const c = mount({
      waiting: ready(waitingEmptyFixture),
      railTab: "waiting",
      onRailTabChange: () => {},
    });
    expect(rows(c)).toHaveLength(0);
    expect(c.querySelector(".rail-empty")?.textContent).toBe("対応が要るタスクはありません。");
    expect(tabs(c)[1]?.textContent).toBe("要対応 0");
  });

  it("英語の文言", () => {
    const c = mount({
      en: true,
      waiting: ready(waitingEmptyFixture),
      railTab: "waiting",
      onRailTabChange: () => {},
    });
    expect(tabs(c).map((b) => b.textContent)).toEqual(["By day", "Needs you 0"]);
    expect(c.querySelector(".rail-empty")?.textContent).toBe("Nothing needs you right now.");
  });

  it("権限の無い待ちは件数だけ（個別の情報は無い）。0 件なら出さない", () => {
    const c = mount({
      waiting: ready({ ...waitingFixture, hidden_count: 2 }),
      railTab: "waiting",
      onRailTabChange: () => {},
    });
    expect(c.querySelector("[data-waiting-hidden]")?.textContent).toBe(
      "権限の無いリポジトリの要対応が 2 件あります。",
    );
    document.body.innerHTML = "";
    const none = mount({
      waiting: ready({ ...waitingFixture, hidden_count: 0 }),
      railTab: "waiting",
      onRailTabChange: () => {},
    });
    expect(none.querySelector("[data-waiting-hidden]")).toBeNull();
  });

  it("上限で打ち切ったときは件数に + を添える", () => {
    const c = mount({
      waiting: ready({ ...waitingFixture, truncated: true }),
      railTab: "day",
      onRailTabChange: () => {},
    });
    expect(tabs(c)[1]?.textContent).toBe(`要対応 ${waitingFixture.tasks.length}+`);
  });

  it("まだ取れていない・失敗したときは件数を出さず、「待ち」を開くと状態を案内する", () => {
    const loading = mount({
      waiting: { phase: "loading" },
      railTab: "waiting",
      onRailTabChange: () => {},
    });
    expect(tabs(loading)[1]?.textContent).toBe("要対応");
    expect(loading.querySelector(".rail-empty")?.textContent).toBe("読み込み中…");
    document.body.innerHTML = "";
    const err = mount({
      waiting: { phase: "error" },
      railTab: "waiting",
      onRailTabChange: () => {},
    });
    expect(err.querySelector(".rail-empty")?.textContent).not.toBe("");
    expect(rows(err)).toHaveLength(0);
  });
});
