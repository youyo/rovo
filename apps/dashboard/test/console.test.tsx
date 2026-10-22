import type { TaskDetailDto, TaskEventDto } from "@rovo/dashboard-contract";
import {
  taskDetailFailedSetupFixture,
  taskDetailRunningFixture,
  taskEventsFixture,
} from "@rovo/dashboard-contract/fixtures";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { formatClockSeconds } from "../src/format";
import { TaskView } from "../src/task-view";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const roots: { unmount: () => void }[] = [];
afterEach(() => {
  for (const r of roots.splice(0)) act(() => r.unmount());
  document.body.innerHTML = "";
});

type Props = Partial<Parameters<typeof TaskView>[0]>;

function render(c: HTMLElement, detail: TaskDetailDto, events: TaskEventDto[], extra: Props) {
  const root = roots.at(-1) as ReturnType<typeof createRoot>;
  act(() => {
    root.render(
      createElement(TaskView, {
        detail,
        events,
        hasOlder: false,
        stale: false,
        loadingOlder: false,
        olderError: false,
        autoRefresh: true,
        onAutoRefreshChange: () => {},
        onRefresh: () => {},
        onLoadOlder: () => {},
        ...extra,
      }),
    );
  });
  return c;
}

function mount(
  detail: TaskDetailDto = taskDetailRunningFixture,
  events: TaskEventDto[] = taskEventsFixture.events,
  extra: Props = {},
) {
  const container = document.createElement("div");
  document.body.append(container);
  roots.push(createRoot(container));
  return render(container, detail, events, extra);
}

const rerender = (
  c: HTMLElement,
  detail: TaskDetailDto,
  events: TaskEventDto[],
  extra: Props = {},
) => render(c, detail, events, extra);

/** jsdom は寸法を持たないので、画面の寸法とスクロール位置を差し替える */
function fakeScroll(el: HTMLElement, dims: { scrollHeight: number; clientHeight: number }) {
  let top = 0;
  let height = dims.scrollHeight;
  Object.defineProperty(el, "clientHeight", { configurable: true, get: () => dims.clientHeight });
  Object.defineProperty(el, "scrollHeight", { configurable: true, get: () => height });
  Object.defineProperty(el, "scrollTop", {
    configurable: true,
    get: () => top,
    set: (v: number) => {
      top = Math.max(0, Math.min(v, height - dims.clientHeight));
    },
  });
  return {
    get top() {
      return top;
    },
    userScrollTo(v: number) {
      top = v;
      act(() => {
        el.dispatchEvent(new Event("scroll"));
      });
    },
    grow(h: number) {
      height = h;
    },
  };
}

const screenOf = (c: HTMLElement) => c.querySelector(".screen") as HTMLElement;

describe("コンソールの見出し（今の表の情報をここに出す）", () => {
  it("題名・モデルと選ばれ方・所要（開始から）・費用・リポジトリ・依頼者", () => {
    const c = mount();
    const head = c.querySelector(".con-head") as HTMLElement;
    const t = taskDetailRunningFixture.task;
    expect(head.querySelector("h1")?.textContent).toBe(t.title);
    expect(head.textContent).toContain("自動（Clef が内容から選んだ）");
    expect(head.querySelector("[data-model]")?.getAttribute("title")).toBe(t.model);
    expect(head.textContent).toContain("開始から");
    expect(head.textContent).toContain("$0.90");
    expect(head.textContent).toContain(t.repository);
    expect(head.textContent).toContain(`${t.owner_login} が依頼`);
  });

  it("終端のタスクは「所要」", () => {
    const c = mount(taskDetailFailedSetupFixture, []);
    expect(c.querySelector(".con-head")?.textContent).toContain("所要");
  });

  it("Draft PR のリンクと状態（許可の形の URL だけ外部リンク、noopener noreferrer）", () => {
    const c = mount();
    const pr = c.querySelector(".con-head a[href^='https://github.com/']") as HTMLAnchorElement;
    expect(pr.getAttribute("href")).toBe(taskDetailRunningFixture.task.pr?.url);
    expect(pr.getAttribute("rel")).toBe("noopener noreferrer");
    expect(pr.getAttribute("target")).toBe("_blank");
    expect(pr.textContent).toContain(`#${taskDetailRunningFixture.task.pr?.number}`);
    expect(c.querySelector("[data-pr]")?.textContent).toMatch(/Draft|Ready/);
  });

  it("PR が無いタスクは PR のリンクを出さず、無い旨を言葉で出す", () => {
    const c = mount(taskDetailFailedSetupFixture, []);
    expect(c.querySelector(".con-head a[href^='https://']")).toBeNull();
    expect(c.querySelector("[data-pr]")?.textContent).toContain("まだありません");
  });

  it("個別ページへの「詳細を開く」リンクは出さない（一覧がそのまま詳細）", () => {
    expect([...mount().querySelectorAll("a")].some((a) => a.textContent === "詳細を開く")).toBe(
      false,
    );
    expect(mount().querySelector(".con-open")).toBeNull();
  });

  it("費用の内訳（トークン）と設定は、見出しの「設定」に畳んである（情報を消さない）", () => {
    const c = mount();
    const more = c.querySelector("details.con-more") as HTMLDetailsElement;
    expect(more.open).toBe(false);
    expect(more.textContent).toContain("入力");
    expect(more.textContent).toContain("standard-2");
    expect(more.textContent).toContain("人のレビューを待つ");
  });
});

describe("段階の帯（到達した段階をアクセント、止まった段階を失敗色）", () => {
  it("段階ごとに data-state が付く。止まった段階は stopped", () => {
    const stopped: TaskDetailDto = {
      ...taskDetailRunningFixture,
      task: {
        ...taskDetailRunningFixture.task,
        status: "FAILED",
        ended_at: "2026-10-21T06:00:00Z",
      },
      phase: "done",
      stopped_phase: "verify",
    };
    const c = mount(stopped);
    const states = [...c.querySelectorAll("[data-band] li")].map((li) =>
      li.getAttribute("data-state"),
    );
    expect(states).toEqual(["done", "done", "stopped", "todo"]);
    expect(c.querySelector("[data-band] li[data-state='stopped']")?.className).toContain(
      "band-item--stopped",
    );
  });
});

describe("画面（screen）", () => {
  it("構造化イベントを時刻つきの行で時系列に並べる。時刻は dim、コマンドは `$ コマンド`", () => {
    const c = mount();
    const rows = [...screenOf(c).querySelectorAll("ol.steps > li.step")];
    expect(rows).toHaveLength(8);
    const first = rows[0] as HTMLElement;
    expect(first.querySelector(".step-time")?.textContent).toBe(
      formatClockSeconds(Date.parse(taskEventsFixture.events[0]?.at as string)),
    );
    const cmd = rows.find((r) => r.querySelector(".prompt")) as HTMLElement;
    expect(cmd.querySelector(".prompt")?.textContent).toBe("$ ");
    expect(cmd.querySelector(".step-target")?.textContent).toBe("pnpm exec vitest run");
    // 読み上げ用に、何をしたかも文字で持つ
    expect(cmd.querySelector(".sr-only")?.textContent).toContain("コマンドを実行した");
  });

  it("cd /workspace/<相対パス> && の前置きは行に出さず、「<相対パス> で」を `$` の前に添える", () => {
    const at = "2026-10-21T05:50:00Z";
    const events: TaskEventDto[] = [
      { seq: 1, at, type: "command", command: "cd /workspace/apps/agent && pnpm test", exit_code: 0 },
      { seq: 2, at, type: "command", command: "cd /workspace && git status", exit_code: 0 },
      {
        seq: 3,
        at,
        type: "tool_start",
        call_id: "c",
        name: "bash",
        summary: '{"command":"cd /workspace/apps/gateway && pnpm exec vitest ru',
      },
    ];
    const c = mount(taskDetailRunningFixture, events);
    const rows = [...c.querySelectorAll("ol.steps > li.step")] as HTMLElement[];
    const text = (r: HTMLElement | undefined, sel: string) => r?.querySelector(sel)?.textContent;
    expect(text(rows[0], ".step-where")).toBe("apps/agent で ");
    expect(text(rows[0], ".step-target")).toBe("pnpm test");
    expect(rows[1]?.querySelector(".step-where")).toBeNull();
    expect(text(rows[1], ".step-target")).toBe("git status");
    // 切れた JSON の実行中の行（「いま」）も、生の JSON ではなく同じ見せ方
    expect(text(rows[2], ".step-where")).toBe("apps/gateway で ");
    expect(text(rows[2], ".step-target")).toBe("pnpm exec vitest ru…");
    expect(rows[2]?.getAttribute("data-current")).toBe("true");
    expect(c.textContent).not.toContain("cd /workspace");
    expect(c.textContent).not.toContain('{"command"');
  });

  it("コマンドが失敗した行は失敗の印（fail の行）と終了コード", () => {
    const failing: TaskEventDto[] = [
      {
        seq: 1,
        at: "2026-10-21T05:50:00Z",
        type: "command",
        command: "pnpm test",
        exit_code: 2,
        duration_ms: 1000,
      },
    ];
    const c = mount(taskDetailRunningFixture, failing);
    const row = c.querySelector("li.step") as HTMLElement;
    expect(row.className).toContain("step--fail");
    expect(row.textContent).toContain("終了コード 2");
  });

  it("画面は端末の面: キーボードでスクロールでき、名前を持つ", () => {
    const c = mount();
    expect(screenOf(c).getAttribute("tabindex")).toBe("0");
    expect(screenOf(c).getAttribute("aria-label")).toBeTruthy();
  });

  it("古いイベントを読む（loadOlder）は画面の先頭。読み込み中・失敗の案内もそこに", () => {
    const calls: string[] = [];
    const c = mount(taskDetailRunningFixture, taskEventsFixture.events, {
      hasOlder: true,
      olderError: true,
      onLoadOlder: () => calls.push("older"),
    });
    const screen = screenOf(c);
    const older = screen.querySelector(".older") as HTMLElement;
    expect(older).not.toBeNull();
    expect(screen.firstElementChild).toBe(older);
    expect(older.textContent).toContain("さらに読む");
    expect(older.textContent).toContain("古い手順を読み込めませんでした");
    act(() => (older.querySelector("button") as HTMLButtonElement).click());
    expect(calls).toEqual(["older"]);
  });
});

describe("実行中のコマンド（流れるコンソール）", () => {
  const running: TaskDetailDto = {
    ...taskDetailRunningFixture,
    generated_at: "2026-10-22T01:01:05Z",
    output: {
      tail: "step 1\nstep 2\n",
      command: "pnpm test",
      running: true,
      started_at: "2026-10-22T01:00:00Z",
      redacted: true,
    },
  };

  it("実行中は経過時間と点滅カーソル（装飾。読み上げない）", () => {
    const c = mount(running);
    const mark = c.querySelector(".screen .output-running") as HTMLElement;
    expect(mark.textContent).toContain("実行中");
    expect(mark.textContent).toContain("1 分 5 秒");
    const cursor = mark.querySelector(".cursor") as HTMLElement;
    expect(cursor.getAttribute("aria-hidden")).toBe("true");
    expect(c.querySelector("pre.output")?.textContent).toBe("step 1\nstep 2\n");
    // 実行中のコマンドがある間は、末尾のプロンプトのカーソルは出さない（カーソルは 1 つ）
    expect(c.querySelectorAll(".cursor")).toHaveLength(1);
  });

  it("コマンドが走っていない実行中のタスクは、末尾のプロンプト `$ ` と点滅カーソル", () => {
    const c = mount(taskDetailRunningFixture);
    const line = c.querySelector(".screen .prompt-line") as HTMLElement;
    expect(line.querySelector(".prompt")?.textContent).toBe("$ ");
    expect(line.querySelector(".cursor")).not.toBeNull();
    expect(c.querySelector(".output-running")).toBeNull();
  });

  it("終端のタスクにはカーソルもプロンプトも出さない", () => {
    const done: TaskDetailDto = {
      ...taskDetailRunningFixture,
      task: {
        ...taskDetailRunningFixture.task,
        status: "COMPLETED",
        ended_at: "2026-10-21T06:00:00Z",
      },
      phase: "done",
    };
    const c = mount(done);
    expect(c.querySelector(".cursor")).toBeNull();
    expect(c.querySelector(".prompt-line")).toBeNull();
  });
});

describe("末尾への自動スクロール（追従 / 停止）", () => {
  const more = (n: number): TaskEventDto[] =>
    Array.from({ length: n }, (_, i) => ({
      seq: 100 + i,
      at: "2026-10-21T05:55:00Z",
      type: "command" as const,
      command: `extra-${i}`,
      exit_code: 0,
    }));

  it("最初は末尾までスクロールし、新しい行が来ても末尾に追従する", () => {
    const c = mount();
    const s = fakeScroll(screenOf(c), { scrollHeight: 1000, clientHeight: 400 });
    // 寸法を差し替えたあとの更新で末尾に動く
    s.grow(1200);
    rerender(c, taskDetailRunningFixture, [...taskEventsFixture.events, ...more(2)]);
    expect(s.top).toBe(800);
    s.grow(1400);
    rerender(c, taskDetailRunningFixture, [...taskEventsFixture.events, ...more(4)]);
    expect(s.top).toBe(1000);
    expect(screenOf(c).getAttribute("data-following")).toBe("true");
  });

  it("利用者が上にスクロールしている間は追従しない。「末尾へ」で戻ると追従を再開する", () => {
    const c = mount();
    const s = fakeScroll(screenOf(c), { scrollHeight: 1000, clientHeight: 400 });
    s.grow(1200);
    rerender(c, taskDetailRunningFixture, [...taskEventsFixture.events, ...more(1)]);
    expect(s.top).toBe(800);

    s.userScrollTo(100);
    expect(screenOf(c).getAttribute("data-following")).toBe("false");
    s.grow(1600);
    rerender(c, taskDetailRunningFixture, [...taskEventsFixture.events, ...more(3)]);
    expect(s.top, "追従していないのに動いた").toBe(100);

    const jump = [...c.querySelectorAll("button")].find((b) => b.textContent === "末尾へ");
    expect(jump, "上にいる間は「末尾へ」が出る").toBeDefined();
    act(() => (jump as HTMLButtonElement).click());
    expect(s.top).toBe(1200);
    expect(screenOf(c).getAttribute("data-following")).toBe("true");
    expect([...c.querySelectorAll("button")].some((b) => b.textContent === "末尾へ")).toBe(false);
  });

  it("自分で末尾までスクロールし直したら追従を再開する", () => {
    const c = mount();
    const s = fakeScroll(screenOf(c), { scrollHeight: 1000, clientHeight: 400 });
    s.userScrollTo(0);
    expect(screenOf(c).getAttribute("data-following")).toBe("false");
    s.userScrollTo(600);
    expect(screenOf(c).getAttribute("data-following")).toBe("true");
  });
});

describe("更新の操作（コンソールの下）", () => {
  it("自動で更新する / 今すぐ更新 / 更新時刻", () => {
    const calls: string[] = [];
    const c = mount(taskDetailRunningFixture, taskEventsFixture.events, {
      onRefresh: () => calls.push("refresh"),
      onAutoRefreshChange: (on) => calls.push(`auto:${on}`),
    });
    const box = c.querySelector("input[type='checkbox']") as HTMLInputElement;
    expect(box.closest("label")?.textContent).toContain("自動で更新する");
    act(() => box.click());
    const btn = [...c.querySelectorAll("button")].find((b) => b.textContent === "今すぐ更新");
    act(() => (btn as HTMLButtonElement).click());
    expect(calls).toEqual(["auto:false", "refresh"]);
    expect(c.querySelector(".con-foot")?.textContent).toContain("に更新。");
  });
});
