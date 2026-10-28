import type { ChecksDto } from "@rovo/dashboard-contract";
import {
  checksFailingFixture,
  checksFixture,
  checksNoneFixture,
  checksUnreadableFixture,
  taskDetailRunningFixture,
  taskEventsFixture,
} from "@rovo/dashboard-contract/fixtures";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CiPane } from "../src/ci-pane";
import { CONSOLE_TAB_KEY } from "../src/prefs";
import { TaskView } from "../src/task-view";
import type { ChecksState } from "../src/use-task-checks";
import { inEn, inJa } from "./lang";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const roots: { unmount: () => void }[] = [];
let store: Map<string, string>;
beforeEach(() => {
  store = new Map();
  vi.stubGlobal("localStorage", {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
  });
});
afterEach(() => {
  for (const r of roots.splice(0)) act(() => r.unmount());
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
});

/** matchMedia を差し替える（幅の判定。jsdom は持たない） */
function setWide(wide: boolean) {
  vi.stubGlobal("matchMedia", (q: string) => ({
    matches: q === "(min-width: 1280px)" ? wide : false,
    media: q,
    addEventListener: () => {},
    removeEventListener: () => {},
  }));
}

const ready = (data: ChecksDto, stale = false): ChecksState => ({ phase: "ready", data, stale });

function mountPane(state: ChecksState, wrap = inJa) {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  act(() => {
    root.render(wrap(createElement(CiPane, { state, now: Date.parse("2026-10-21T05:10:00Z") })));
  });
  return container;
}

function mountView(checks: ChecksState | null | undefined, wrap = inJa) {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  act(() => {
    root.render(
      wrap(
        createElement(TaskView, {
          detail: taskDetailRunningFixture,
          events: taskEventsFixture.events,
          hasOlder: false,
          stale: false,
          loadingOlder: false,
          olderError: false,
          autoRefresh: true,
          onAutoRefreshChange: () => {},
          onRefresh: () => {},
          onLoadOlder: () => {},
          ...(checks === undefined ? {} : { checks }),
        }),
      ),
    );
  });
  return container;
}

const click = (el: Element | null) => {
  expect(el).not.toBeNull();
  act(() => {
    (el as HTMLElement).dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
};

describe("CiPane（CI のペインの中身）", () => {
  it("見出し「CI」と head の短い SHA（7 桁）", () => {
    const c = mountPane(ready(checksFixture));
    expect(c.querySelector("h2")?.textContent).toContain("CI");
    expect(c.querySelector("[data-ci-sha]")?.textContent).toBe("0123456");
  });

  it("一覧は 失敗 → 実行中 → 待ち → 成功 → skipped の順。各行に状態の文字（読み上げ用）・名前・所要", () => {
    const base = {
      kind: "check_run",
      status: "completed",
      conclusion: "success",
      started_at: "2026-10-21T05:00:00Z",
      completed_at: "2026-10-21T05:01:30Z",
      url: null,
    } as const;
    const data: ChecksDto = {
      ...checksFixture,
      state: "failing",
      checks: [
        { ...base, name: "ok-1" },
        { ...base, name: "skip-1", conclusion: "skipped" },
        {
          ...base,
          name: "queued-1",
          status: "queued",
          conclusion: null,
          started_at: null,
          completed_at: null,
        },
        { ...base, name: "bad-1", conclusion: "failure" },
        {
          ...base,
          name: "run-1",
          status: "in_progress",
          conclusion: null,
          started_at: "2026-10-21T05:09:30Z",
          completed_at: null,
        },
      ],
    };
    const c = mountPane(ready(data));
    const rows = [...c.querySelectorAll("li.ci-row")];
    expect(rows.map((r) => r.querySelector(".ci-name")?.textContent)).toEqual([
      "bad-1",
      "run-1",
      "queued-1",
      "ok-1",
      "skip-1",
    ]);
    expect(rows.map((r) => r.getAttribute("data-class"))).toEqual([
      "fail",
      "run",
      "queued",
      "ok",
      "skip",
    ]);
    expect(rows.map((r) => r.querySelector(".sr-only")?.textContent)).toEqual([
      "失敗",
      "実行中",
      "待ち",
      "成功",
      "スキップ",
    ]);
    // 所要: 完了した check run は開始と終了の差（1 分 30 秒）。実行中は経過（30 秒）に … を付ける。待ちは出さない
    const dur = rows.map((r) => r.querySelector(".ci-dur")?.textContent ?? "");
    expect(dur[0]).toBe("1 分 30 秒");
    expect(dur[1]).toBe("30 秒…");
    expect(dur[2]).toBe("");
  });

  it("細い帯は check 1 つが 1 区画で、一覧と同じ並び（装飾。読み上げない）", () => {
    const c = mountPane(ready(checksFailingFixture));
    const strip = c.querySelector(".ci-strip") as HTMLElement;
    expect(strip.getAttribute("aria-hidden")).toBe("true");
    expect([...strip.children].map((s) => s.getAttribute("data-class"))).toEqual([
      "fail",
      "queued",
      "ok",
    ]);
  });

  it("細い帯: 24 件までは 1 件 1 区画、超えたら状態ごとの区画（失敗 → 実行中 → 待ち → 成功 → skipped）で、件数に比例した幅", () => {
    const base = checksFixture.checks[0] as ChecksDto["checks"][number];
    const mk = (
      n: number,
      status: "completed" | "in_progress" | "queued",
      conclusion: string | null,
    ) =>
      Array.from({ length: n }, (_, i) => ({
        ...base,
        name: `${status}-${conclusion}-${i}`,
        status,
        conclusion,
      }));
    const few = mountPane(
      ready({
        ...checksFixture,
        checks: [...mk(20, "completed", "success"), ...mk(4, "completed", "failure")],
      }),
    );
    const fewStrip = few.querySelector(".ci-strip") as HTMLElement;
    expect(fewStrip.hasAttribute("data-grouped")).toBe(false);
    expect(fewStrip.querySelectorAll(".ci-seg")).toHaveLength(24);

    const many = mountPane(
      ready({
        ...checksFixture,
        checks: [
          ...mk(30, "completed", "success"),
          ...mk(2, "completed", "skipped"),
          ...mk(1, "queued", null),
          ...mk(6, "completed", "failure"),
          ...mk(1, "in_progress", null),
        ],
      }),
    );
    const strip = many.querySelector(".ci-strip") as HTMLElement;
    expect(strip.getAttribute("aria-hidden")).toBe("true");
    expect(strip.hasAttribute("data-grouped")).toBe(true);
    const segs = [...strip.querySelectorAll(".ci-seg")];
    expect(segs.map((e) => e.getAttribute("data-class"))).toEqual([
      "fail",
      "run",
      "queued",
      "ok",
      "skip",
    ]);
    expect(segs.map((e) => e.getAttribute("data-count"))).toEqual(["6", "1", "1", "30", "2"]);
    // 幅は件数に比例（1 件でも見える最小幅あり）
    const w = segs.map((e) => Number(e.getAttribute("width")));
    expect(w[3]).toBeGreaterThan(w[0] ?? 0);
    expect(w[0]).toBeGreaterThan(w[1] ?? 0);
    expect(Math.min(...w)).toBeGreaterThan(0);
    // 0 件の状態は出さない
    const only = mountPane(ready({ ...checksFixture, checks: mk(30, "completed", "success") }));
    expect(only.querySelectorAll(".ci-strip .ci-seg")).toHaveLength(1);
  });

  it("リンクは url があるときだけ。新しいタブ・noopener noreferrer。github.com 以外は画面でもリンクにしない", () => {
    const data: ChecksDto = {
      ...checksFixture,
      checks: [
        { ...checksFixture.checks[0], name: "a", url: "https://github.com/o/r/runs/1" },
        { ...checksFixture.checks[0], name: "b", url: null },
        { ...checksFixture.checks[0], name: "c", url: "javascript:alert(1)" },
        { ...checksFixture.checks[0], name: "d", url: "https://evil.example/x" },
      ] as ChecksDto["checks"],
    };
    const c = mountPane(ready(data));
    const links = [...c.querySelectorAll("a")];
    expect(links).toHaveLength(1);
    const a = links[0] as HTMLAnchorElement;
    expect(a.getAttribute("href")).toBe("https://github.com/o/r/runs/1");
    expect(a.getAttribute("target")).toBe("_blank");
    expect(a.getAttribute("rel")).toBe("noopener noreferrer");
    expect(a.getAttribute("aria-label")).toBe("a を GitHub で開く");
  });

  it("名前は外部の入力。テキストとしてだけ描く（HTML として解釈しない）。長い名前は省略表示のために title を付ける", () => {
    const evil = '<img src=x onerror="alert(1)"><script>alert(2)</script>';
    const long = "x".repeat(180);
    const data: ChecksDto = {
      ...checksFixture,
      checks: [
        { ...checksFixture.checks[0], name: evil },
        { ...checksFixture.checks[0], name: long },
      ] as ChecksDto["checks"],
    };
    const c = mountPane(ready(data));
    expect(c.querySelector("img")).toBeNull();
    expect(c.querySelector("script")).toBeNull();
    const names = [...c.querySelectorAll(".ci-name")];
    expect(names[0]?.textContent).toBe(evil);
    expect(names[1]?.getAttribute("title")).toBe(long);
  });

  it("CI がまだ無い（none）・読めない（unreadable）・読み込み中・取得失敗の文言", () => {
    expect(mountPane(ready(checksNoneFixture)).textContent).toContain(
      "この PR にはまだ CI がありません",
    );
    expect(mountPane(ready(checksUnreadableFixture)).textContent).toContain(
      "CI を読めません。GitHub App に Checks と Commit statuses の読み取りの権限が要ります",
    );
    expect(mountPane({ phase: "loading" }).textContent).toContain("読み込み中");
    expect(mountPane({ phase: "error" }).textContent).toContain("CI を取得できませんでした");
    // 読めない・無いときは一覧も帯も出さない
    const c = mountPane(ready(checksUnreadableFixture));
    expect(c.querySelector(".ci-strip")).toBeNull();
    expect(c.querySelector("li.ci-row")).toBeNull();
  });

  it("truncated は「最初の N 件だけを表示しています」、partial と stale も文言を出す", () => {
    const c = mountPane(ready({ ...checksFixture, truncated: true, partial: true }, true));
    const text = c.textContent ?? "";
    expect(text).toContain("最初の 4 件だけを表示しています");
    expect(text).toContain("CI の一部しか読めていません");
    expect(text).toContain("前の結果を表示しています");
  });

  it("英語", () => {
    const c = mountPane(ready(checksUnreadableFixture), inEn);
    expect(c.textContent).toContain(
      "Cannot read CI. The GitHub App needs read access to Checks and Commit statuses.",
    );
    expect(mountPane(ready(checksNoneFixture), inEn).textContent).toContain(
      "This PR has no CI yet.",
    );
    expect(mountPane(ready({ ...checksFixture, truncated: true }), inEn).textContent).toContain(
      "Showing only the first 4 checks.",
    );
  });
});

describe("TaskView と CI（PR があるときだけ）", () => {
  it("checks が null / 未指定（PR が無い）なら、チップもタブもペインも出さない", () => {
    for (const checks of [null, undefined]) {
      setWide(true);
      const c = mountView(checks);
      expect(c.querySelector(".ci-chip")).toBeNull();
      expect(c.querySelector("[role=tablist]")).toBeNull();
      expect(c.querySelector(".ci-pane")).toBeNull();
      expect(c.querySelector(".con-split")).toBeNull();
      // 段階の帯とログの箱は今までどおりコンソールの直下
      expect(c.querySelector(".console > [data-band]")).not.toBeNull();
      expect(c.querySelector(".console > .logbox")).not.toBeNull();
    }
  });

  it("見出しの PR の隣に要約チップ（✓ 成功・✗ 失敗・◌ 実行中や待ち。0 は出さない）。色だけに頼らず数と aria-label で伝える", () => {
    setWide(false);
    const c = mountView(ready(checksFixture));
    const chip = c.querySelector(".con-head .ci-chip") as HTMLElement;
    expect(chip).not.toBeNull();
    expect(chip.closest(".meta-item")?.querySelector("[data-pr]")).not.toBeNull();
    expect(chip.getAttribute("aria-label")).toBe("CI: 成功 3、実行中・待ち 1。CI を表示する");
    expect([...chip.querySelectorAll("[data-n]")].map((n) => n.getAttribute("data-kind"))).toEqual([
      "ok",
      "pending",
    ]);
    expect(chip.textContent).toBe("CI31");
    const failing = mountView(ready(checksFailingFixture));
    const chip2 = failing.querySelector(".con-head .ci-chip") as HTMLElement;
    expect(chip2.getAttribute("aria-label")).toBe(
      "CI: 成功 1、失敗 1、実行中・待ち 1。CI を表示する",
    );
    expect([...chip2.querySelectorAll("[data-n]")].map((n) => n.getAttribute("data-kind"))).toEqual(
      ["ok", "fail", "pending"],
    );
  });

  it("チップは CI が無い・読めない・読み込み中・取得失敗でも出る（状態を aria-label で伝える）", () => {
    setWide(false);
    const label = (s: ChecksState) =>
      mountView(s).querySelector(".con-head .ci-chip")?.getAttribute("aria-label");
    expect(label(ready(checksNoneFixture))).toBe("CI: まだありません。CI を表示する");
    expect(label(ready(checksUnreadableFixture))).toBe("CI: 読めません。CI を表示する");
    expect(label({ phase: "loading" })).toBe("CI: 読み込み中。CI を表示する");
    expect(label({ phase: "error" })).toBe("CI: 取得できません。CI を表示する");
  });

  it("幅が足りない（1280px 未満）: 「コンソール / CI」のタブ。既定はコンソール。CI のタブの見出しに失敗の数", () => {
    setWide(false);
    const c = mountView(ready(checksFailingFixture));
    const tabs = [...c.querySelectorAll("[role=tablist] [role=tab]")];
    expect(tabs.map((t) => t.textContent)).toEqual(["コンソール", "CI1"]);
    // 「✗」の文字ではなく、要約チップと同じ失敗の記号
    expect(tabs[1]?.querySelector("svg.mark-sym--bad[data-shape='cross']")).not.toBeNull();
    expect(tabs[1]?.getAttribute("aria-label")).toBe("CI、失敗 1 件");
    expect(tabs.map((t) => t.getAttribute("aria-selected"))).toEqual(["true", "false"]);
    const consolePanel = c.querySelector("#con-panel-console") as HTMLElement;
    const ciPanel = c.querySelector("#con-panel-ci") as HTMLElement;
    expect(consolePanel.hidden).toBe(false);
    expect(ciPanel.hidden).toBe(true);
    // 失敗が無ければ数は付けない
    const ok = mountView(ready(checksFixture));
    expect([...ok.querySelectorAll("[role=tab]")].map((t) => t.textContent)).toEqual([
      "コンソール",
      "CI",
    ]);
  });

  it("タブを押すと切り替わり、選んだタブを localStorage に覚える。次に開くとそのタブ", () => {
    setWide(false);
    const c = mountView(ready(checksFixture));
    click(c.querySelectorAll("[role=tab]")[1] ?? null);
    expect((c.querySelector("#con-panel-ci") as HTMLElement).hidden).toBe(false);
    expect((c.querySelector("#con-panel-console") as HTMLElement).hidden).toBe(true);
    expect(store.get(CONSOLE_TAB_KEY)).toBe("ci");
    const again = mountView(ready(checksFixture));
    expect(again.querySelectorAll("[role=tab]")[1]?.getAttribute("aria-selected")).toBe("true");
    click(again.querySelectorAll("[role=tab]")[0] ?? null);
    expect(store.get(CONSOLE_TAB_KEY)).toBe("console");
  });

  it("localStorage が使えなくても動く（タブの切り替えは画面の中で効く）", () => {
    setWide(false);
    vi.stubGlobal("localStorage", {
      getItem: () => {
        throw new Error("denied");
      },
      setItem: () => {
        throw new Error("denied");
      },
    });
    const c = mountView(ready(checksFixture));
    click(c.querySelectorAll("[role=tab]")[1] ?? null);
    expect((c.querySelector("#con-panel-ci") as HTMLElement).hidden).toBe(false);
  });

  it("タブの時にチップを押すと CI のタブに切り替わり、CI のパネルに焦点が移る", () => {
    setWide(false);
    const c = mountView(ready(checksFixture));
    click(c.querySelector(".ci-chip"));
    expect(c.querySelectorAll("[role=tab]")[1]?.getAttribute("aria-selected")).toBe("true");
    expect(document.activeElement).toBe(c.querySelector("#con-panel-ci"));
  });

  it("タブは矢印キーで移れる（← → ）", () => {
    setWide(false);
    const c = mountView(ready(checksFixture));
    const first = c.querySelectorAll("[role=tab]")[0] as HTMLElement;
    act(() => {
      first.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
    });
    expect(c.querySelectorAll("[role=tab]")[1]?.getAttribute("aria-selected")).toBe("true");
    act(() => {
      (c.querySelectorAll("[role=tab]")[1] as HTMLElement).dispatchEvent(
        new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true }),
      );
    });
    expect(c.querySelectorAll("[role=tab]")[0]?.getAttribute("aria-selected")).toBe("true");
  });

  it("幅が足りる（1280px 以上）: タブは無く、左にコンソール・右に CI のペインが並ぶ。両方見えている", () => {
    setWide(true);
    store.set(CONSOLE_TAB_KEY, "ci"); // 保存されたタブは、並びのときは効かない
    const c = mountView(ready(checksFixture));
    expect(c.querySelector("[role=tablist]")).toBeNull();
    const split = c.querySelector(".con-split") as HTMLElement;
    expect(split.getAttribute("data-wide")).toBe("true");
    const main = split.querySelector(".con-main") as HTMLElement;
    const pane = split.querySelector(".ci-pane") as HTMLElement;
    expect(main.querySelector("[data-band]")).not.toBeNull();
    expect(main.querySelector(".logbox")).not.toBeNull();
    expect(main.hidden).toBe(false);
    expect(pane.hidden).toBe(false);
    expect(main.nextElementSibling).toBe(pane);
  });

  it("並びの時にチップを押すと CI のペインに焦点が移る（スクロールして見せる）", () => {
    setWide(true);
    const scrollIntoView = vi.fn();
    (HTMLElement.prototype as { scrollIntoView?: unknown }).scrollIntoView = scrollIntoView;
    const c = mountView(ready(checksFixture));
    click(c.querySelector(".ci-chip"));
    const pane = c.querySelector(".ci-pane") as HTMLElement;
    expect(document.activeElement).toBe(pane);
    expect(pane.getAttribute("tabindex")).toBe("-1");
    expect(scrollIntoView).toHaveBeenCalled();
  });
});
