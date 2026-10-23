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
import { inJa, tJa } from "./lang";

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
      inJa(
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
      ),
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

/** 要約のカードの「小さなラベルと値」の並び。ラベル（dt）→ 値の要素（dd） */
function fact(c: HTMLElement, label: string): HTMLElement | null {
  const item = [...c.querySelectorAll(".con-head .meta-item")].find(
    (i) => i.querySelector("dt")?.textContent === label,
  );
  return (item?.querySelector("dd") as HTMLElement | null) ?? null;
}

describe("コンソールの要約のカード（今の表の情報をここに出す）", () => {
  it("印付きの題名と、状態・モデル（選び方）・開始から・費用・リポジトリ・依頼者・PR が、小さなラベルと値の並び", () => {
    const c = mount();
    const head = c.querySelector(".con-head") as HTMLElement;
    const t = taskDetailRunningFixture.task;
    const h1 = head.querySelector("h1") as HTMLElement;
    expect(h1.textContent).toBe(t.title);
    // 題名の印は状態の印（装飾。隣に題名と状態の文字がある）
    expect(h1.querySelector("svg.mark-sym")?.getAttribute("data-mark")).toBe("running");
    expect(h1.querySelector("svg.mark-sym")?.getAttribute("aria-hidden")).toBe("true");
    expect([...head.querySelectorAll(".meta-item dt")].map((dt) => dt.textContent)).toEqual([
      "状態",
      "モデル",
      "開始から",
      "費用",
      "リポジトリ",
      "依頼者",
      "PR",
    ]);
    expect(fact(c, "モデル")?.textContent).toContain("自動（Clef が内容から選んだ）");
    expect(fact(c, "モデル")?.querySelector("[data-model]")?.getAttribute("title")).toBe(t.model);
    expect(fact(c, "開始から")?.textContent).toBe("20 分 0 秒");
    expect(fact(c, "費用")?.textContent).toBe("$0.90");
    expect(fact(c, "リポジトリ")?.textContent).toBe(t.repository);
    expect(fact(c, "依頼者")?.textContent).toBe(t.owner_login);
    expect(fact(c, "PR")?.querySelector("[data-pr]")).not.toBeNull();
  });

  it("状態は印（レール・凡例と同じ記号）+ 短い label。走行中は回る輪（spin）で、title は label", () => {
    const c = mount();
    const state = c.querySelector(".con-head .state-name") as HTMLElement;
    expect(state.textContent).toBe("実行中");
    const mark = state.querySelector("svg.mark-sym") as SVGElement;
    expect(mark.getAttribute("data-mark")).toBe("running");
    expect(mark.getAttribute("data-shape")).toBe("spinner");
    expect(mark.getAttribute("aria-hidden")).toBe("true"); // 隣に文字があるので読み上げは二重にしない
    expect(mark.classList.contains("spin")).toBe(true);
    expect(state.getAttribute("title")).toBe("実行中");
  });

  it("閉じた PR: 見出しとバッジの label は短い「閉じた」のまま、title で「閉じた（マージせず）」", () => {
    const t = taskDetailRunningFixture.task;
    const detail: TaskDetailDto = {
      ...taskDetailRunningFixture,
      task: {
        ...t,
        status: "COMPLETED",
        ended_at: "2026-10-21T05:59:00Z",
        pr: { ...(t.pr as NonNullable<typeof t.pr>), merged: false, state: "closed" },
      },
    };
    const c = mount(detail, []);
    const state = c.querySelector(".con-head .state-name") as HTMLElement;
    expect(state.textContent).toBe("閉じた");
    expect(state.getAttribute("title")).toBe("閉じた（マージせず）");
    expect(state.querySelector("svg.mark-sym")?.getAttribute("data-mark")).toBe("closed");
    expect(state.querySelector("svg.mark-sym.spin")).toBeNull();
    const badge = c.querySelector("[data-pr] .status") as HTMLElement;
    expect(badge.textContent).toBe("閉じた");
    expect(badge.getAttribute("title")).toBe("閉じた（マージせず）");
    expect(badge.querySelector("svg.mark-sym")?.getAttribute("data-mark")).toBe("closed");
  });

  it("終端のタスクは「所要」", () => {
    const c = mount(taskDetailFailedSetupFixture, []);
    expect(fact(c, "所要")?.textContent).toBe("20 秒");
    expect(fact(c, "開始から")).toBeNull();
    // 失敗の理由は理由コードのまま、ラベル付きで出す
    expect(fact(c, "理由")?.textContent).toBe("base_sha_not_found");
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

  it("「設定と費用の内訳」はログの箱の見出しの右に置く。畳んである（情報を消さない）", () => {
    const c = mount();
    const more = c.querySelector("details.con-more") as HTMLDetailsElement;
    expect(more.closest(".logbox .loghd")).not.toBeNull();
    expect(more.closest(".con-head")).toBeNull();
    expect(more.querySelector("summary")?.textContent).toBe("設定と費用の内訳");
    expect(more.open).toBe(false);
    expect(more.textContent).toContain("入力");
    expect(more.textContent).toContain("standard-2");
    expect(more.textContent).toContain("人のレビューを待つ");
  });
});

describe("段階の帯（job の箱を線でつないだ図。準備 → 実行 → 検証 → 完了）", () => {
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

  it("段階ごとに data-state が付く。止まった段階は stopped", () => {
    const c = mount(stopped);
    const states = [...c.querySelectorAll("[data-band] li")].map((li) =>
      li.getAttribute("data-state"),
    );
    expect(states).toEqual(["done", "done", "stopped", "todo"]);
    expect(c.querySelector("[data-band] li[data-state='stopped']")?.className).toContain(
      "band-item--stopped",
    );
  });

  it("各箱に印がある: 済み=✓、いま=回る輪、止まった=✕、これから=点線の輪（形で区別する）", () => {
    const c = mount(stopped);
    const shapes = [...c.querySelectorAll("[data-band] li")].map((li) =>
      li.querySelector(".job svg.mark-sym")?.getAttribute("data-shape"),
    );
    expect(shapes).toEqual(["check", "check", "cross", "queued"]);
    const running = mount();
    const live = [...running.querySelectorAll("[data-band] li")].map((li) =>
      li.querySelector(".job svg.mark-sym")?.getAttribute("data-shape"),
    );
    expect(live).toEqual(["check", "spinner", "queued", "queued"]);
    expect(running.querySelector("[data-band] li[data-state='now'] svg.spin")).not.toBeNull();
  });

  it("箱を線（edge）でつなぐ。済んだ区間の線は done、まだの区間は done でない", () => {
    const c = mount(); // 準備は済み、実行がいま
    const lis = [...c.querySelectorAll("[data-band] li")];
    // 先頭の箱の前には線が無い。2 つ目からは、直前の段階が済んでいるときだけ done
    expect(lis[0]?.querySelector(".band-edge")).toBeNull();
    expect(
      lis.slice(1).map((li) => li.querySelector(".band-edge")?.classList.contains("done")),
    ).toEqual([true, false, false]);
    for (const li of lis.slice(1))
      expect(li.querySelector(".band-edge")?.getAttribute("aria-hidden")).toBe("true");
  });

  it("各箱の所要は status_changed の時刻から（準備 = 2 分、実行 = 今までの経過で …）。データに無い段階には出さない", () => {
    const c = mount();
    const small = [...c.querySelectorAll("[data-band] li")].map(
      (li) => li.querySelector(".job small")?.textContent,
    );
    // 準備: 05:38 → 05:40 = 2 分 0 秒。実行: 05:40 → 更新時刻 06:00 の経過 20 分 0 秒…。検証・完了は所要が無く、文字（これから）
    expect(small).toEqual(["2 分 0 秒", "20 分 0 秒…", "これから", "これから"]);
  });

  it("所要が無い箱でも、状態の文字を出す（止まった・入力待ち・復旧中は所要の前に文字を足す）", () => {
    const c = mount(stopped, taskEventsFixture.events);
    const small = [...c.querySelectorAll("[data-band] li")].map(
      (li) => li.querySelector(".job small")?.textContent,
    );
    // FAILED の status_changed が無い（events は途中まで）ので、止まった段階に終わりの記録が無く、文字だけ
    expect(small[2]).toBe("失敗");
    expect(small[3]).toBe("これから");
  });

  it("aria-label は段階ごとの状態を文章で持つ", () => {
    const c = mount();
    expect(c.querySelector("[data-band]")?.getAttribute("aria-label")).toBe(
      "段階: 準備は済み、実行はいま、検証はこれから、完了はこれから",
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
      formatClockSeconds(Date.parse(taskEventsFixture.events[0]?.at as string), tJa),
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
      {
        seq: 1,
        at,
        type: "command",
        command: "cd /workspace/apps/agent && pnpm test",
        exit_code: 0,
      },
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

  it("行は「▸・印・内容・時刻・所要」。印: 済み=✓、いま=回る輪、失敗=✕。いまの行だけ「いま」の文字", () => {
    const c = mount();
    const rows = [...c.querySelectorAll("ol.steps > li.step")] as HTMLElement[];
    const shape = (r: HTMLElement) =>
      r.querySelector(".step-row svg.mark-sym")?.getAttribute("data-shape");
    expect(rows.map(shape)).toEqual([
      "check",
      "check",
      "check",
      "check",
      "check",
      "check",
      "check",
      "spinner",
    ]);
    expect(rows.at(-1)?.querySelector("svg.spin")).not.toBeNull();
    expect(rows.at(-1)?.querySelector(".step-tag")?.textContent).toBe("いま");
    expect(c.querySelectorAll(".step-tag")).toHaveLength(1);
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
    const f = mount(taskDetailRunningFixture, failing);
    expect(f.querySelector("li.step svg.mark-sym")?.getAttribute("data-shape")).toBe("cross");
  });

  it("入力待ちのタスクの「いま」の行は、回る輪ではなく ！（止まって待っている）", () => {
    const waiting: TaskDetailDto = {
      ...taskDetailRunningFixture,
      task: { ...taskDetailRunningFixture.task, status: "INPUT_REQUIRED" },
    };
    const c = mount(waiting);
    const last = [...c.querySelectorAll("ol.steps > li.step")].at(-1) as HTMLElement;
    expect(last.querySelector("svg.mark-sym")?.getAttribute("data-shape")).toBe("bang");
    expect(last.querySelector("svg.spin")).toBeNull();
  });

  it("行ごとの所要は次の行の時刻との差。いまの行は更新時刻までの経過に「…」", () => {
    const c = mount();
    const dur = [...c.querySelectorAll("ol.steps > li.step")].map(
      (r) => r.querySelector(".step-dur")?.textContent,
    );
    expect(dur).toEqual([
      "2 分 0 秒",
      "1 分 0 秒",
      "1 分 0 秒",
      "2 分 0 秒",
      "6 分 0 秒",
      "2 分 0 秒",
      "2 分 0 秒",
      "6 分 0 秒…",
    ]);
    // 時刻（HH:MM:SS）は、所要の左に残す
    expect(c.querySelectorAll("ol.steps > li.step .step-time")).toHaveLength(8);
    // 終わったタスクの最後の行は、次が無いので所要を出さない
    const done = mount({
      ...taskDetailRunningFixture,
      task: {
        ...taskDetailRunningFixture.task,
        status: "COMPLETED",
        ended_at: "2026-10-21T05:59:00Z",
      },
      phase: "done",
    });
    const last = [...done.querySelectorAll("ol.steps > li.step")].at(-1) as HTMLElement;
    expect(last.querySelector(".step-dur")?.textContent).toBe("");
    expect(last.querySelector(".step-dur--none")).not.toBeNull();
  });

  it("過去の行は、note（行数・終了コード・所要・SHA など）があるときだけ開ける（▸）。無ければ ▸ も details も出さない", () => {
    const c = mount();
    const rows = [...c.querySelectorAll("ol.steps > li.step")] as HTMLElement[];
    const bySeq = (n: number) =>
      rows.find((r) => r.getAttribute("data-seq") === String(n)) as HTMLElement;
    // 5 = ファイル編集（12 行追加、3 行削除）、6 = コマンド、7 = コミット
    for (const n of [5, 6, 7]) {
      const r = bySeq(n);
      expect(r.querySelector("details"), String(n)).not.toBeNull();
      expect(r.querySelector("summary .step-car")?.textContent, String(n)).toBe("▸");
      expect((r.querySelector("details") as HTMLDetailsElement).open, String(n)).toBe(false);
    }
    expect(bySeq(5).querySelector(".step-detail")?.textContent).toBe("12 行追加、3 行削除");
    expect(bySeq(6).querySelector(".step-detail")?.textContent).toBe("42 秒");
    expect(bySeq(7).querySelector(".step-detail")?.textContent).toBe("2 ファイル、0123456");
    // 中身が無い行（状態の変化・Draft PR・web・agent_event）には ▸ を出さない
    for (const n of [1, 2, 3, 4, 9]) {
      const r = bySeq(n);
      expect(r.querySelector("details"), String(n)).toBeNull();
      expect(r.querySelector(".step-car"), String(n)).toBeNull();
    }
    expect(c.querySelectorAll(".step-car")).toHaveLength(3);
  });

  it("開いた行は ▸ をクリックして開閉できる。失敗した行は最初から開いて理由が見える", () => {
    const c = mount();
    const d = c.querySelector("li.step[data-seq='6'] details") as HTMLDetailsElement;
    act(() => {
      (d.querySelector("summary") as HTMLElement).click();
    });
    expect(d.open).toBe(true);
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
    const f = mount(taskDetailRunningFixture, failing);
    const fd = f.querySelector("li.step details") as HTMLDetailsElement;
    expect(fd.open).toBe(true);
    expect(fd.querySelector(".step-detail")?.textContent).toBe("終了コード 2、1 秒");
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

  describe("出力の末尾は、いま実行中のコマンドの行の下に、行番号付きで開いて見せる", () => {
    const commandRunning: TaskEventDto[] = [
      ...taskEventsFixture.events,
      {
        seq: 20,
        at: "2026-10-22T01:00:00Z",
        type: "command",
        command: "pnpm test",
        exit_code: null,
      },
    ];

    it("実行中のコマンドの行（いまの行）の中に、開いた状態で出る。標準の出力の枠は別に出さない", () => {
      const c = mount(running, commandRunning);
      const row = c.querySelector("li.step[data-seq='20']") as HTMLElement;
      expect(row.getAttribute("data-current")).toBe("true");
      const details = row.querySelector("details") as HTMLDetailsElement;
      expect(details.open).toBe(true);
      expect(details.querySelector(".output-box h3")?.textContent).toBe("pnpm test の出力（途中）");
      expect(details.querySelector(".output-running")?.textContent).toContain("1 分 5 秒");
      // 出力の枠は 1 つだけ（行の外に重ねて出さない）
      expect(c.querySelectorAll(".output-box")).toHaveLength(1);
      expect(c.querySelectorAll("pre.output")).toHaveLength(1);
    });

    it("出力は 1 行 1 要素（.out-line）。行番号は CSS の counter で付け、文字列にしない。元の文字列はそのまま", () => {
      const c = mount(running, commandRunning);
      const pre = c.querySelector("pre.output") as HTMLElement;
      const lines = [...pre.querySelectorAll(".out-line")];
      expect(lines.map((l) => l.textContent)).toEqual(["step 1\n", "step 2\n"]);
      expect(pre.textContent).toBe("step 1\nstep 2\n");
      // 末尾に改行が無い最後の行も 1 行
      const noNl = mount(
        { ...running, output: { ...running.output, tail: "a\nb" } },
        commandRunning,
      );
      expect([...noNl.querySelectorAll("pre.output .out-line")].map((l) => l.textContent)).toEqual([
        "a\n",
        "b",
      ]);
    });

    it("出力は sanitize を通す（制御文字・双方向の制御文字を除き、HTML は文字として出る）", () => {
      const evil = "\u0007‮gpj<img src=x onerror=alert(1)>\nok\n";
      const c = mount({ ...running, output: { ...running.output, tail: evil } }, commandRunning);
      expect(c.querySelector("img")).toBeNull();
      const t = c.querySelector("pre.output")?.textContent ?? "";
      expect(t.includes("\u0007")).toBe(false);
      expect(/[‪-‮⁦-⁩]/.test(t)).toBe(false);
      expect(t).toContain("<img src=x onerror=alert(1)>");
    });

    it("出力が終わったコマンドの末尾（running でない）は、手順の外の出力の枠に出す（どの行のものか決めつけない）", () => {
      const finished: TaskDetailDto = {
        ...taskDetailRunningFixture,
        output: { tail: "ok\n", command: "pnpm test", redacted: true },
      };
      const c = mount(finished);
      expect(c.querySelector("ol.steps .output-box")).toBeNull();
      expect(c.querySelector(".screen > .output-box pre.output")?.textContent).toBe("ok\n");
    });
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
