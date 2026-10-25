import type { OverviewDto, VisibleTaskDto, WaitingDto } from "@rovo/dashboard-contract";
import { overviewFixture, waitingFixture } from "@rovo/dashboard-contract/fixtures";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TeamBoard } from "../src/team-board";
import { clickLink } from "./click-link";
import { inEn, inJa } from "./lang";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const roots: { unmount: () => void }[] = [];
afterEach(() => {
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
    expect(text(alice.querySelector('[data-group="now"] .tb-cap'))).toBe("いま");
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
