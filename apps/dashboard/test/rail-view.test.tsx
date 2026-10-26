import type { VisibleTaskDto } from "@rovo/dashboard-contract";
import { overviewFixture } from "@rovo/dashboard-contract/fixtures";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { formatDuration, formatUsd, modelFamily, shortModel } from "../src/format";
import { TaskRail } from "../src/rail-view";
import { MARKS } from "../src/status";
import { taskTime } from "../src/timeline";
import { BROWSER_CLICKS, clickLink } from "./click-link";
import { inJa, tJa } from "./lang";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const roots: { unmount: () => void }[] = [];
afterEach(() => {
  vi.unstubAllGlobals();
  for (const r of roots.splice(0)) act(() => r.unmount());
  document.body.innerHTML = "";
});

const AT = Date.parse(overviewFixture.generated_at);

function mount(
  tasks: VisibleTaskDto[],
  selectedId: string | null = null,
  onSelect?: (id: string) => void,
  extra: { showOwner?: boolean; at?: number } = {},
) {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  act(() => {
    root.render(inJa(createElement(TaskRail, { tasks, selectedId, onSelect, at: AT, ...extra })));
  });
  return container;
}

const rows = (c: HTMLElement) => [...c.querySelectorAll("a.rail-row")] as HTMLAnchorElement[];

describe("タスクのレール（1 行 1 タスク）", () => {
  it("新しい開始が上。行はタスク詳細へのリンク", () => {
    const c = mount(overviewFixture.tasks);
    const expected = [...overviewFixture.tasks]
      .sort((a, b) => taskTime(b) - taskTime(a))
      .map((t) => `/dashboard/tasks/${t.task_id}`);
    expect(rows(c).map((a) => a.getAttribute("href"))).toEqual(expected);
  });

  it("1 行目は「印・題名・所要」。題名は題名だけ（PR 番号は 2 行目）。状態の名前は印が持つ（読み上げ・マウスオーバー）", () => {
    const c = mount(overviewFixture.tasks);
    for (const a of rows(c)) {
      const t = overviewFixture.tasks.find((x) => a.getAttribute("href")?.endsWith(x.task_id));
      expect(t).toBeDefined();
      const task = t as VisibleTaskDto;
      expect(a.querySelector(".rail-title")?.textContent).toBe(task.title);
      const start = Date.parse(task.started_at ?? task.created_at);
      const end = task.ended_at === null ? AT : Date.parse(task.ended_at);
      expect(a.querySelector(".rail-time")?.textContent).toBe(formatDuration(end - start, tJa));
      const mark = a.querySelector("svg.mark-sym");
      expect(mark?.getAttribute("role")).toBe("img");
      expect(mark?.getAttribute("aria-label")).toMatch(
        /マージ済み|レビュー待ち|失敗|実行中|完了|閉じた|PR あり/,
      );
      expect(mark?.querySelector("title")?.textContent).toBe(mark?.getAttribute("aria-label"));
      expect(a.getAttribute("data-status")).toBe(task.status);
      expect(a.getAttribute("data-mark")).toBeTruthy();
    }
    const text = rows(c)
      .map((r) => r.textContent)
      .join("\n");
    for (const w of ["マージ済み", "レビュー待ち", "失敗", "実行中"]) expect(text).toContain(w);
  });

  it("2 行目は「PR と状態（PR が無ければ、終端は状態・実行中はリポジトリ）・モデル・費用」", () => {
    const c = mount(overviewFixture.tasks);
    const byId = (id: string) =>
      rows(c).find((a) => a.getAttribute("data-task-id") === id) as HTMLAnchorElement;
    for (const task of overviewFixture.tasks) {
      const meta = byId(task.task_id).querySelector(".rail-meta") as HTMLElement;
      expect(meta, task.title).not.toBeNull();
      expect(meta.querySelector(".rail-model")?.textContent).toBe(modelFamily(task.model));
      expect(meta.querySelector(".rail-model")?.getAttribute("title")).toBe(
        shortModel(task.model).full,
      );
      expect(meta.querySelector(".rail-cost")?.textContent).toBe(
        formatUsd(task.cost.cost_usd, tJa),
      );
    }
    // PR あり: 「#番号 状態の文字」
    const merged = overviewFixture.tasks[0] as VisibleTaskDto;
    expect(byId(merged.task_id).querySelector(".rail-pr")?.textContent).toBe("#101");
    expect(byId(merged.task_id).querySelector(".rail-subject")?.textContent).toBe(
      "#101 マージ済み",
    );
    const review = overviewFixture.tasks[1] as VisibleTaskDto;
    expect(byId(review.task_id).querySelector(".rail-subject")?.textContent).toBe(
      "#57 レビュー待ち",
    );
    const failed = overviewFixture.tasks[2] as VisibleTaskDto;
    expect(byId(failed.task_id).querySelector(".rail-subject")?.textContent).toBe("#102 失敗");
    // PR なし
    const base = overviewFixture.tasks[0] as VisibleTaskDto;
    const noPr = [
      { ...base, task_id: "01K8ZF00000000000000000A01", status: "FAILED", pr: null },
      {
        ...base,
        task_id: "01K8ZF00000000000000000A02",
        status: "RUNNING",
        pr: null,
        ended_at: null,
      },
    ] as VisibleTaskDto[];
    const c2 = mount(noPr);
    const subject = (id: string) =>
      c2.querySelector(`[data-task-id='${id}'] .rail-subject`)?.textContent;
    expect(subject("01K8ZF00000000000000000A01")).toBe("失敗");
    expect(subject("01K8ZF00000000000000000A02")).toBe(base.repository);
  });

  it("モデルは狭い場所用の短い名前（sonnet / haiku / opus）。全体の名前は title", () => {
    const base = overviewFixture.tasks[0] as VisibleTaskDto;
    const c = mount([{ ...base, model: "anthropic/claude-sonnet-5-5" }]);
    const model = c.querySelector(".rail-model") as HTMLElement;
    expect(model.textContent).toBe("sonnet");
    expect(model.getAttribute("title")).toBe("anthropic/claude-sonnet-5-5");
  });

  it("実行中の行の所要は一覧の更新時刻までの経過。終わった行は終了までの時間", () => {
    const running = overviewFixture.tasks[3] as VisibleTaskDto; // 05:40 開始、更新 06:00
    const c = mount([running]);
    expect(c.querySelector(".rail-time")?.textContent).toBe(formatDuration(20 * 60_000, tJa));
    const first = overviewFixture.tasks[0] as VisibleTaskDto; // 01:06:10 → 02:05:30
    const c2 = mount([first]);
    expect(c2.querySelector(".rail-time")?.textContent).toBe(
      formatDuration(59 * 60_000 + 20_000, tJa),
    );
  });

  it("狭い幅の所要は短い表記（9:52 / 58s / 1:02:03）。広い幅は従来どおり", () => {
    vi.stubGlobal("matchMedia", (query: string) => ({
      matches: query.includes("max-width: 720px"),
      media: query,
      addEventListener: () => {},
      removeEventListener: () => {},
    }));
    const running = overviewFixture.tasks[3] as VisibleTaskDto; // 20 分
    expect(mount([running]).querySelector(".rail-time")?.textContent).toBe("20:00");
    const first = overviewFixture.tasks[0] as VisibleTaskDto; // 59 分 20 秒
    expect(mount([first]).querySelector(".rail-time")?.textContent).toBe("59:20");
  });

  it("印: 回る輪は実行中だけが回る（spin）。状態ごとの形は MARKS の割り当て", () => {
    const c = mount(overviewFixture.tasks);
    const byStatus = (s: string) => rows(c).find((a) => a.getAttribute("data-status") === s);
    expect(byStatus("FAILED")?.querySelector("svg.mark-sym")?.getAttribute("data-shape")).toBe(
      MARKS.failed.shape,
    );
    expect(byStatus("RUNNING")?.querySelector("svg.mark-sym.spin")).not.toBeNull();
    const merged = rows(c).find((a) => a.getAttribute("data-mark") === "merged");
    expect(merged?.querySelector("svg.mark-sym")?.getAttribute("data-shape")).toBe(
      MARKS.merged.shape,
    );
    expect(merged?.querySelector("svg.mark-sym.spin")).toBeNull();
    // 行には、文字としての印（✕ ● ·）を置かない
    for (const a of rows(c)) expect(a.querySelector(".rail-mark")).toBeNull();
  });

  it("状態の形の割り当て: 準備中=点線の輪、実行中・検証中・復旧中=回る輪、入力待ち=！", () => {
    const base = overviewFixture.tasks[0] as VisibleTaskDto;
    const statuses = ["CREATING", "RUNNING", "INPUT_REQUIRED", "VERIFYING", "RECOVERING"] as const;
    const list = statuses.map((status, i) => ({
      ...base,
      task_id: `01JZ0000000000000000000${i}0A`,
      status,
      pr: null,
    }));
    const c = mount(list);
    const shapeOf = (s: string) =>
      rows(c)
        .find((a) => a.getAttribute("data-status") === s)
        ?.querySelector("svg.mark-sym")
        ?.getAttribute("data-shape");
    expect(statuses.map(shapeOf)).toEqual(["queued", "spinner", "bang", "spinner", "spinner"]);
  });

  it("選択中の行は aria-current と data-selected（左のアクセント線は CSS）。1 行だけ", () => {
    const sel = overviewFixture.tasks[1] as VisibleTaskDto;
    const c = mount(overviewFixture.tasks, sel.task_id);
    const current = rows(c).filter((a) => a.getAttribute("aria-current") === "true");
    expect(current).toHaveLength(1);
    expect(current[0]?.getAttribute("href")).toBe(`/dashboard/tasks/${sel.task_id}`);
    expect(current[0]?.getAttribute("data-selected")).toBe("true");
    expect(rows(c).filter((a) => a.hasAttribute("data-selected"))).toHaveLength(1);
  });

  it("選択が無い（一覧に出ない古いタスクの詳細など）なら、どの行も選択中にしない", () => {
    const c = mount(overviewFixture.tasks, "01JZ0000000000000000000000");
    expect(rows(c).some((a) => a.hasAttribute("aria-current"))).toBe(false);
  });

  it("チーム表示のときだけ、2 行目の先頭に頭文字の丸と依頼者（owner_login）。マイタスクでは出さない", () => {
    const team = mount(overviewFixture.tasks, null, undefined, { showOwner: true });
    for (const a of rows(team)) {
      const task = overviewFixture.tasks.find(
        (x) => x.task_id === a.getAttribute("data-task-id"),
      ) as VisibleTaskDto;
      const owner = a.querySelector(".rail-meta > .rail-owner:first-child") as HTMLElement;
      expect(owner, task.title).not.toBeNull();
      expect(owner.querySelector(".rail-avatar")?.textContent).toBe(
        task.owner_login.slice(0, 1).toUpperCase(),
      );
      expect(owner.querySelector(".rail-avatar")?.getAttribute("aria-hidden")).toBe("true");
      expect(owner.querySelector(".rail-login")?.textContent).toBe(task.owner_login);
    }
    const mine = mount(overviewFixture.tasks);
    expect(mine.querySelector(".rail-owner")).toBeNull();
  });

  it("所要と費用は数字の右揃え（tabular-nums。CSS）のための要素を持つ", () => {
    const c = mount(overviewFixture.tasks);
    for (const a of rows(c)) {
      expect(a.querySelector(".rail-time")).not.toBeNull();
      expect(a.querySelector(".rail-cost")).not.toBeNull();
    }
  });

  it("タスクが無ければ空の表示", () => {
    const c = mount([]);
    expect(rows(c)).toHaveLength(0);
    expect(c.textContent).toContain("今日のタスクはまだありません");
  });

  it("表示の安全: 題名の制御文字は除き、HTML は文字として出る", () => {
    const evil = {
      ...(overviewFixture.tasks[0] as VisibleTaskDto),
      title: "‮gpj.exe\u0007<img src=x onerror=alert(1)>\n改行",
      owner_login: "ev\u0007il",
      repository: "o/r\u0007x",
      pr: null,
      status: "RUNNING" as const,
      ended_at: null,
    };
    const c = mount([evil], null, undefined, { showOwner: true });
    expect(c.querySelector("img")).toBeNull();
    const text = c.textContent ?? "";
    expect(text.includes("\u0007")).toBe(false);
    expect(/[‪-‮⁦-⁩]/.test(text)).toBe(false);
    expect(text).toContain("<img src=x onerror=alert(1)>");
  });
});

describe("行のクリック（ページを読み直さず、画面の中で切り替える）", () => {
  const target = overviewFixture.tasks[1] as VisibleTaskDto;
  const rowOf = (c: HTMLElement, id: string) =>
    rows(c).find((a) => a.getAttribute("data-task-id") === id) as HTMLAnchorElement;

  it("左クリックは preventDefault して、そのタスクの ID で onSelect を呼ぶ。href は残る", () => {
    const calls: string[] = [];
    const c = mount(overviewFixture.tasks, null, (id) => calls.push(id));
    const a = rowOf(c, target.task_id);
    expect(clickLink(a)).toBe(true);
    expect(calls).toEqual([target.task_id]);
    expect(a.getAttribute("href")).toBe(`/dashboard/tasks/${target.task_id}`);
  });

  it("修飾キー（Ctrl・Cmd・Shift・Alt）付きと中クリックは、preventDefault も onSelect もしない（ブラウザが新しいタブで開く）", () => {
    const calls: string[] = [];
    const c = mount(overviewFixture.tasks, null, (id) => calls.push(id));
    const a = rowOf(c, target.task_id);
    for (const { name, init } of BROWSER_CLICKS) {
      expect(clickLink(a, init), name).toBe(false);
    }
    expect(calls).toEqual([]);
  });

  it("onSelect が無い（単体の表示）なら、普通のリンクのまま", () => {
    const c = mount(overviewFixture.tasks);
    expect(clickLink(rowOf(c, target.task_id))).toBe(false);
  });
});
