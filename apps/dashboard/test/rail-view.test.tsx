import type { VisibleTaskDto } from "@rovo/dashboard-contract";
import { overviewFixture } from "@rovo/dashboard-contract/fixtures";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { formatClock } from "../src/format";
import { TaskRail } from "../src/rail-view";
import { taskTime } from "../src/timeline";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const roots: { unmount: () => void }[] = [];
afterEach(() => {
  for (const r of roots.splice(0)) act(() => r.unmount());
  document.body.innerHTML = "";
});

function mount(tasks: VisibleTaskDto[], selectedId: string | null = null) {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  act(() => {
    root.render(createElement(TaskRail, { tasks, selectedId }));
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

  it("行の中身: 状態の印・PR 番号・題名・開始時刻。状態は文字（読み上げ）でも持つ", () => {
    const c = mount(overviewFixture.tasks);
    for (const a of rows(c)) {
      const t = overviewFixture.tasks.find((x) => a.getAttribute("href")?.endsWith(x.task_id));
      expect(t).toBeDefined();
      const task = t as VisibleTaskDto;
      expect(a.querySelector(".rail-title")?.textContent).toContain(task.title);
      if (task.pr) expect(a.querySelector(".rail-pr")?.textContent).toBe(`#${task.pr.number}`);
      expect(a.querySelector(".rail-time")?.textContent).toBe(formatClock(taskTime(task)));
      expect(a.querySelector(".rail-mark")?.getAttribute("aria-hidden")).toBe("true");
      expect(a.querySelector(".sr-only")?.textContent).toMatch(
        /マージ済み|レビュー待ち|失敗|実行中|完了|閉じた|PR あり/,
      );
      expect(a.getAttribute("data-status")).toBe(task.status);
      expect(a.getAttribute("data-mark")).toBeTruthy();
    }
    const text = rows(c)
      .map((r) => r.textContent)
      .join("\n");
    for (const w of ["マージ済み", "レビュー待ち", "失敗", "実行中"]) expect(text).toContain(w);
  });

  it("印: 失敗は ✕、走行中は脈動。マージ済みは ●", () => {
    const c = mount(overviewFixture.tasks);
    const byStatus = (s: string) => rows(c).find((a) => a.getAttribute("data-status") === s);
    expect(byStatus("FAILED")?.querySelector(".rail-mark")?.textContent).toBe("✕");
    expect(byStatus("RUNNING")?.querySelector(".rail-mark .pulse")).not.toBeNull();
    const merged = rows(c).find((a) => a.getAttribute("data-mark") === "merged");
    expect(merged?.querySelector(".rail-mark")?.textContent).toBe("●");
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

  it("リポジトリ・モデル・費用・PR の状態は行に出さず（見出しに出す）、ツールチップも付けない", () => {
    const c = mount(overviewFixture.tasks);
    for (const a of rows(c)) {
      expect(a.hasAttribute("title")).toBe(false);
      expect(a.querySelector("[title]")).toBeNull();
      expect(a.textContent).not.toContain("$");
      expect(a.textContent).not.toContain(overviewFixture.tasks[0]?.repository);
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
    };
    const c = mount([evil]);
    expect(c.querySelector("img")).toBeNull();
    const text = c.textContent ?? "";
    expect(text.includes("\u0007")).toBe(false);
    expect(/[‪-‮⁦-⁩]/.test(text)).toBe(false);
    expect(text).toContain("<img src=x onerror=alert(1)>");
  });
});
