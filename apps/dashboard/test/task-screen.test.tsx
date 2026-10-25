import type { TaskDetailDto, TaskEventDto, TaskEventsPageDto } from "@rovo/dashboard-contract";
import {
  legacyTaskEventsFixture,
  taskDetailFailedSetupFixture,
  taskDetailRunningFixture,
  taskEventsFixture,
} from "@rovo/dashboard-contract/fixtures";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDetailCache } from "../src/detail-cache";
import { formatUsd } from "../src/format";
import { TaskScreen } from "../src/task-screen";
import { inJa, tJa } from "./lang";
import { legacyTailEvents } from "./legacy-events";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const ID = taskDetailRunningFixture.task.task_id;
const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/** 時刻・タイマー・可視状態を差し替えたポーリング環境 */
function makeEnv() {
  let now = 0;
  let hidden = false;
  let nextId = 1;
  const timers = new Map<number, { at: number; fn: () => void }>();
  const listeners = new Set<() => void>();
  return {
    deps: {
      setTimer: (fn: () => void, ms: number) => {
        const id = nextId++;
        timers.set(id, { at: now + ms, fn });
        return id;
      },
      clearTimer: (h: unknown) => void timers.delete(h as number),
      isHidden: () => hidden,
      onVisibilityChange: (cb: () => void) => {
        listeners.add(cb);
        return () => void listeners.delete(cb);
      },
    },
    pending: () => [...timers.values()].map((t) => t.at - now),
    async fire() {
      const [id, t] = [...timers.entries()].sort((a, b) => a[1].at - b[1].at)[0] ?? [];
      if (id === undefined || !t) throw new Error("タイマーが無い");
      timers.delete(id);
      now = t.at;
      await act(async () => {
        t.fn();
        await settle();
      });
    },
    async setHidden(h: boolean) {
      hidden = h;
      await act(async () => {
        for (const l of [...listeners]) l();
        await settle();
      });
    },
  };
}

const settle = async () => {
  for (let i = 0; i < 20; i++) await Promise.resolve();
};

type Script = {
  detail: (n: number) => Response;
  events: (url: URL, n: number) => Response;
};

function server(script: Partial<Script> = {}) {
  let detailN = 0;
  let eventsN = 0;
  const calls: string[] = [];
  let inflight = 0;
  let maxInflight = 0;
  const fn = vi.fn(async (input: RequestInfo | URL) => {
    const url = new URL(String(input), "http://localhost");
    calls.push(url.pathname.replace(`/dashboard/api/tasks/${ID}`, "") + url.search);
    inflight++;
    maxInflight = Math.max(maxInflight, inflight);
    await Promise.resolve();
    inflight--;
    if (url.pathname === `/dashboard/api/tasks/${ID}`) {
      return (script.detail ?? (() => json(200, taskDetailRunningFixture)))(detailN++);
    }
    if (url.pathname === `/dashboard/api/tasks/${ID}/events`) {
      return (script.events ?? (() => json(200, legacyTailEvents)))(url, eventsN++);
    }
    return json(404, { error: "not_found" });
  });
  return { fn, calls, maxInflight: () => maxInflight };
}

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
  delete (window as { __xss?: unknown }).__xss;
});

async function mount(
  s: ReturnType<typeof server>,
  env = makeEnv(),
  onUnauthorized: () => void = () => {},
  extra: Partial<Parameters<typeof TaskScreen>[0]> = {},
) {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  await act(async () => {
    root.render(
      inJa(
        createElement(TaskScreen, {
          id: ID,
          onUnauthorized,
          deps: { fetchImpl: s.fn as unknown as typeof fetch, pollerDeps: env.deps },
          ...extra,
        }),
      ),
    );
    await settle();
  });
  return { c: container, env };
}

const text = (c: HTMLElement) => c.textContent ?? "";
const steps = (c: HTMLElement) => [...c.querySelectorAll("[data-seq]")];

describe("タスク詳細（実行中。値のある now / output）", () => {
  it("見本の構成で出る: 状態・経過・リポジトリ・依頼者・題名・いまは X・帯・進み具合・出力・費用・設定・PR", async () => {
    const { c } = await mount(server());
    const t = taskDetailRunningFixture.task;
    expect(c.querySelector("h1")?.textContent).toBe(t.title);
    expect(text(c)).toContain("実行中");
    expect(c.querySelector(".spin")).not.toBeNull();
    expect(text(c)).toContain("開始から");
    expect(text(c)).toContain(t.repository);
    const ownerFact = [...c.querySelectorAll(".con-head .meta-item")].find(
      (i) => i.querySelector("dt")?.textContent === "依頼者",
    );
    expect(ownerFact?.querySelector("dd")?.textContent).toBe(t.owner_login);
    expect(c.querySelector(".now-line")?.textContent).toBe(
      "いまは pnpm exec vitest run を実行しています。",
    );
    const band = c.querySelector("[data-band]") as HTMLElement;
    expect(band.getAttribute("aria-label")).toBe(
      "段階: 準備は済み、実行はいま、検証はこれから、完了はこれから",
    );
    expect([...band.querySelectorAll("li")].map((li) => li.getAttribute("data-state"))).toEqual([
      "done",
      "now",
      "todo",
      "todo",
    ]);
    expect(steps(c)).toHaveLength(8);
    expect(text(c)).toContain("コマンドを実行した");
    expect(text(c)).toContain("ファイルを編集した");
    expect(text(c)).toContain("scripts/deploy.sh");
    expect(text(c)).toContain("コミットした");
    expect(text(c)).toContain("ページを読んだ");
    // 出力の枠と、秘密を伏せた旨
    const pre = c.querySelector("pre.output") as HTMLElement;
    expect(pre.textContent).toBe(taskDetailRunningFixture.output.tail);
    expect(text(c)).toContain("トークンなどの秘密は伏せて表示しています");
    // 費用・設定・PR
    expect(text(c)).toContain("$0.90");
    expect(text(c)).toContain("入力");
    expect(text(c)).toContain("standard-2");
    expect(text(c)).toContain("全体のテストとレビューはクライアントが行う");
    expect(text(c)).toContain("high");
    const pr = c.querySelector("a[href^='https://github.com/']") as HTMLAnchorElement;
    expect(pr.getAttribute("href")).toBe(t.pr?.url);
    expect(pr.getAttribute("rel")).toBe("noopener noreferrer");
  });

  it("now が「$ コマンド」のときは、$ だけプロンプトの色（コンソールと同じ見た目）", async () => {
    const dto = {
      ...taskDetailRunningFixture,
      now: { kind: "tool", text: "$ sleep 4", at: "2026-10-21T05:50:00Z" },
    } as unknown as TaskDetailDto;
    const { c } = await mount(server({ detail: () => json(200, dto) }));
    const line = c.querySelector(".now-line") as HTMLElement;
    expect(line.textContent).toBe("いまは $ sleep 4 を実行しています。");
    expect(line.querySelector(".prompt")?.textContent).toBe("$ ");
    expect(line.querySelector("strong")?.textContent).toBe("sleep 4");
  });

  it("設定に「モデルの選び方」を 1 行出す（自動なら理由つき）。旧い gateway のように無ければ出さない", async () => {
    const { c } = await mount(server());
    expect(text(c)).toContain("モデルの選び方");
    expect(text(c)).toContain("自動（Clef が内容から選んだ）");
    const failed = await mount(server({ detail: () => json(200, taskDetailFailedSetupFixture) }));
    expect(text(failed.c)).not.toContain("モデルの選び方");
  });

  it("モデルの選び方: 指定したときは「指定」、知らない理由のコードはそのまま出す（自由文でも文字として）", async () => {
    const variants: [TaskDetailDto["settings"]["model_selection"], string][] = [
      [{ mode: "explicit", reason: "explicit" }, "指定（依頼した側が選んだ）"],
      [{ mode: "auto", reason: "fallback_timeout" }, "自動（時間切れで既定のモデル）"],
      [{ mode: "auto", reason: "some_future_code" }, "自動（some_future_code）"],
    ];
    for (const [sel, want] of variants) {
      const dto = {
        ...taskDetailRunningFixture,
        settings: { ...taskDetailRunningFixture.settings, model_selection: sel },
      };
      const { c } = await mount(server({ detail: () => json(200, dto) }));
      expect(text(c), want).toContain(want);
      for (const r of roots.splice(0)) act(() => r.unmount());
      document.body.innerHTML = "";
    }
  });

  it("DTO に無い数字（予約額・モデルの呼び出し回数）は出さない", async () => {
    const { c } = await mount(server());
    expect(text(c)).not.toContain("予約");
    expect(text(c)).not.toContain("呼び出し");
  });

  it("いまの手順（最後）にだけ「いま」の文字と current の印がある（色だけに頼らない）", async () => {
    const { c } = await mount(server());
    const cur = c.querySelectorAll("[data-current='true']");
    expect(cur).toHaveLength(1);
    expect(cur[0]?.getAttribute("data-seq")).toBe("9");
    expect(cur[0]?.textContent).toContain("いま");
  });

  it("img も script も無い。外部リンクは PR の 1 つだけ", async () => {
    const { c } = await mount(server());
    expect(c.querySelector("img, script, iframe")).toBeNull();
    const external = [...c.querySelectorAll("a")].filter((a) => /^https?:/.test(a.href));
    expect(external).toHaveLength(1);
  });
});

describe("タスク詳細（now / output が null）", () => {
  const nullDetail: TaskDetailDto = {
    ...taskDetailRunningFixture,
    now: null,
    output: { tail: null, redacted: true },
  };
  it("状態に応じた文を出し、出力の枠は出さず、秘密を伏せた旨は出す", async () => {
    const { c } = await mount(server({ detail: () => json(200, nullDetail) }));
    expect(c.querySelector(".now-line")?.textContent).toContain("作業を進めています");
    expect(c.querySelector("pre")).toBeNull();
    expect(text(c)).toContain("トークンなどの秘密は伏せて表示しています");
  });
  it("INPUT_REQUIRED の waiting は固定の日本語（英語の text を出さない）", async () => {
    const d: TaskDetailDto = {
      ...nullDetail,
      task: { ...nullDetail.task, status: "INPUT_REQUIRED" },
      now: { kind: "waiting", text: "waiting for input" },
    };
    const { c } = await mount(server({ detail: () => json(200, d) }));
    expect(c.querySelector(".now-line")?.textContent).toBe("入力を待っています。");
    expect(text(c)).not.toContain("waiting for input");
    expect(text(c)).toContain("入力待ち");
  });
});

describe("タスク詳細（準備で失敗・終端）", () => {
  it("failure_phase が setup: 準備で止まった表示。理由コード。events が空なら空の文。出力の枠なし", async () => {
    const empty: TaskEventsPageDto = {
      task_id: ID,
      events: [],
      oldest_seq: null,
      newest_seq: null,
      has_older: false,
    };
    const { c } = await mount(
      server({
        detail: () => json(200, taskDetailFailedSetupFixture),
        events: () => json(200, empty),
      }),
    );
    const band = c.querySelector("[data-band]") as HTMLElement;
    expect([...band.querySelectorAll("li")].map((li) => li.getAttribute("data-state"))).toEqual([
      "stopped",
      "todo",
      "todo",
      "todo",
    ]);
    expect(band.getAttribute("aria-label")).toContain("準備は失敗");
    expect(text(c)).toContain("base_sha_not_found");
    expect(text(c)).toContain("失敗");
    expect(c.querySelector(".spin")).toBeNull();
    expect(c.querySelector("pre")).toBeNull();
    expect(text(c)).toContain("進み具合はまだありません");
    expect(text(c)).toContain("所要");
    expect(c.querySelector("[data-current='true']")).toBeNull();
  });

  it("COMPLETED + PR: 一覧と同じ印と文字（マージ済み）", async () => {
    const t = taskDetailRunningFixture.task;
    const d: TaskDetailDto = {
      ...taskDetailRunningFixture,
      phase: "done",
      task: {
        ...t,
        status: "COMPLETED",
        ended_at: "2026-10-21T05:59:00Z",
        pr: { ...(t.pr as NonNullable<typeof t.pr>), merged: true, state: "merged" },
      },
    };
    const { c } = await mount(server({ detail: () => json(200, d) }));
    const prSection = c.querySelector("[data-pr]") as HTMLElement;
    expect(prSection.textContent).toContain("マージ済み");
    expect(prSection.querySelector("[data-mark='merged']")).not.toBeNull();
  });

  it("古い agent の履歴（構造化イベントなし）も縮退して出る。成功の tool_end は出さない", async () => {
    const { c } = await mount(server({ events: () => json(200, legacyTaskEventsFixture) }));
    expect(steps(c)).toHaveLength(2);
    expect(text(c)).toContain("コマンドを実行した");
    expect(text(c)).toContain("pnpm exec vitest run");
    expect(text(c)).not.toContain("ツールが終わった");
    expect(text(c)).not.toContain('{"command"');
  });

  it("出力の枠の見出しは、output.command があれば「<command> の出力（末尾）」", async () => {
    const withCmd: TaskDetailDto = {
      ...taskDetailRunningFixture,
      output: { tail: "ok", command: "pnpm test", redacted: true },
    };
    const a = await mount(server({ detail: () => json(200, withCmd) }));
    expect(a.c.querySelector(".output-box h3")?.textContent).toBe("pnpm test の出力（末尾）");
    const noCmd: TaskDetailDto = {
      ...taskDetailRunningFixture,
      output: { tail: null, redacted: true },
    };
    const b = await mount(server({ detail: () => json(200, noCmd) }));
    expect(b.c.querySelector(".output-box h3")?.textContent).toBe("出力の末尾");
  });
});

describe("出力の枠: 実行中のコマンド", () => {
  it("running のときは「実行中」の印と、generated_at からの経過時間を出す。終わったコマンドの出力には出さない", async () => {
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
    const a = await mount(server({ detail: () => json(200, running) }));
    const mark = a.c.querySelector(".output-box .output-running");
    expect(mark?.textContent).toContain("実行中");
    expect(mark?.textContent).toContain("1 分 5 秒");
    expect(a.c.querySelector("pre.output")?.textContent).toBe("step 1\nstep 2\n");
    expect(a.c.querySelector(".output-box h3")?.textContent).toBe("pnpm test の出力（途中）");

    const finished: TaskDetailDto = {
      ...taskDetailRunningFixture,
      output: { tail: "ok", command: "pnpm test", redacted: true },
    };
    const b = await mount(server({ detail: () => json(200, finished) }));
    expect(b.c.querySelector(".output-running")).toBeNull();
    expect(b.c.querySelector(".output-box h3")?.textContent).toBe("pnpm test の出力（末尾）");
  });
});

describe("404 / 401 / 取得失敗", () => {
  it("404: 「このタスクは見られません」だけ。題名の断片も出さない", async () => {
    const { c } = await mount(
      server({
        detail: () => json(404, { error: "not_found" }),
        events: () => json(404, { error: "not_found" }),
      }),
    );
    expect(text(c)).toContain("このタスクは見られません");
    expect(text(c)).not.toContain(taskDetailRunningFixture.task.title);
    expect(text(c)).not.toContain(taskDetailRunningFixture.task.title.slice(0, 4));
    expect(c.querySelector("a[href='/dashboard/']")).not.toBeNull();
  });

  it("権限を失った（更新中に events が 404）: 画面を 404 に切り替え、前の内容を残さない", async () => {
    let n = 0;
    const s = server({
      events: (_u) =>
        n++ === 0 ? json(200, taskEventsFixture) : json(404, { error: "not_found" }),
    });
    const { c, env } = await mount(s);
    expect(c.querySelector("h1")?.textContent).toBe(taskDetailRunningFixture.task.title);
    await env.fire();
    expect(text(c)).toContain("このタスクは見られません");
    expect(text(c)).not.toContain(taskDetailRunningFixture.task.title);
    expect(env.pending()).toHaveLength(0);
  });

  it("401: onUnauthorized を呼び、止まる", async () => {
    const onUnauthorized = vi.fn();
    const s = server({ detail: () => json(401, { error: "unauthorized" }) });
    const { env } = await mount(s, makeEnv(), onUnauthorized);
    expect(onUnauthorized).toHaveBeenCalled();
    expect(env.pending()).toHaveLength(0);
  });

  it("最初の取得失敗は再読み込みの案内。自動で再試行する（backoff）", async () => {
    const s = server({ detail: () => json(500, {}) });
    const { c, env } = await mount(s);
    expect(c.querySelector("[role='alert']")?.textContent).toContain("読み込めませんでした");
    expect(env.pending()).toEqual([10_000]);
  });

  it("更新に失敗しても前の内容を出し続け、お知らせを出す", async () => {
    let n = 0;
    const s = server({
      detail: () => (n++ === 0 ? json(200, taskDetailRunningFixture) : json(500, {})),
    });
    const { c, env } = await mount(s);
    await env.fire();
    expect(c.querySelector("h1")?.textContent).toBe(taskDetailRunningFixture.task.title);
    expect(text(c)).toContain("更新できませんでした");
  });
});

describe("自動更新（D15）", () => {
  it("最初は events を末尾から（cursor なし）。5 秒後は cursor=最後の seq の差分だけ", async () => {
    const more: TaskEventsPageDto = {
      task_id: ID,
      events: [
        { seq: 10, at: "2026-10-21T05:55:00Z", type: "web", kind: "search", host: "example.com" },
      ],
      oldest_seq: 10,
      newest_seq: 10,
      has_older: false,
    };
    const s = server({ events: (_u, n) => json(200, n === 0 ? taskEventsFixture : more) });
    const { c, env } = await mount(s);
    // 開いた最初の 1 回の詳細だけ fresh（D6）。以降のポーリングは付けない
    expect(s.calls).toEqual(["?fresh=1", "/events"]);
    expect(env.pending()).toEqual([5000]);
    await env.fire();
    expect(s.calls.slice(2)).toEqual(["", "/events?cursor=9"]);
    expect(steps(c).map((e) => e.getAttribute("data-seq"))).toEqual([
      "1",
      "2",
      "3",
      "4",
      "5",
      "6",
      "7",
      "9",
      "10",
    ]);
    // 「いま」は新しい最後の手順に移る
    expect(c.querySelector("[data-current='true']")?.getAttribute("data-seq")).toBe("10");
  });

  it("サーバーが重複して返しても同じ seq を 2 回積まない", async () => {
    const s = server({ events: () => json(200, taskEventsFixture) });
    const { c, env } = await mount(s);
    await env.fire();
    await env.fire();
    expect(steps(c)).toHaveLength(8);
  });

  it("1 ページ 200 件ちょうどなら、続きがあるとみて続けて取る", async () => {
    const mk = (from: number, n: number): TaskEventDto[] =>
      Array.from({ length: n }, (_, i) => ({
        seq: from + i,
        at: "2026-10-21T05:40:00Z",
        type: "agent_event" as const,
        agent_type: `t${from + i}`,
      }));
    const page = (evs: TaskEventDto[], hasOlder = false): TaskEventsPageDto => ({
      task_id: ID,
      events: evs,
      oldest_seq: evs[0]?.seq ?? null,
      newest_seq: evs.at(-1)?.seq ?? null,
      has_older: hasOlder,
    });
    const s = server({
      events: (_u, n) =>
        json(200, n === 0 ? page(mk(1, 3)) : n === 1 ? page(mk(4, 200)) : page(mk(204, 5))),
    });
    const { c, env } = await mount(s);
    await env.fire();
    expect(s.calls.filter((x) => x.startsWith("/events"))).toEqual([
      "/events",
      "/events?cursor=3",
      "/events?cursor=203",
    ]);
    expect(steps(c)).toHaveLength(208);
  });

  it("hidden の間は取らず、戻ったら即取る", async () => {
    const s = server();
    const { env } = await mount(s);
    await env.setHidden(true);
    expect(env.pending()).toHaveLength(0);
    const before = s.calls.length;
    await env.setHidden(false);
    expect(s.calls.length).toBe(before + 2);
  });

  it("最初の詳細の取得が失敗したら、成功するまで fresh を付け続ける（成功のあとは付けない）", async () => {
    const s = server({
      detail: (n) =>
        n === 0 ? json(503, { error: "unavailable" }) : json(200, taskDetailRunningFixture),
    });
    const { env } = await mount(s);
    await env.fire();
    await env.fire();
    expect(s.calls.filter((x) => !x.startsWith("/events"))).toEqual(["?fresh=1", "?fresh=1", ""]);
  });

  it("手動の更新（今すぐ更新）や hidden からの復帰は fresh を付けない", async () => {
    const s = server();
    const { env } = await mount(s);
    await env.setHidden(true);
    await env.setHidden(false);
    expect(s.calls.filter((x) => !x.startsWith("/events"))).toEqual(["?fresh=1", ""]);
  });

  it("detail と events を同時に走らせない（常に 1 本）", async () => {
    const s = server();
    const { env } = await mount(s);
    await env.fire();
    await env.fire();
    expect(s.maxInflight()).toBe(1);
  });

  it("終端のタスクは、終端になってから 30 秒だけ追って止まる", async () => {
    const ended = Date.parse("2026-10-21T05:59:00Z");
    const detailAt = (secs: number): TaskDetailDto => ({
      ...taskDetailRunningFixture,
      generated_at: new Date(ended + secs * 1000).toISOString().replace(".000Z", "Z"),
      task: {
        ...taskDetailRunningFixture.task,
        status: "COMPLETED",
        ended_at: "2026-10-21T05:59:00Z",
      },
      phase: "done",
    });
    const secs = [10, 20, 30];
    const s = server({ detail: (n) => json(200, detailAt(secs[n] ?? 40)) });
    const { env } = await mount(s);
    expect(env.pending()).toEqual([5000]);
    await env.fire();
    expect(env.pending()).toEqual([5000]);
    await env.fire(); // generated_at が終端から 30 秒に達した
    expect(env.pending()).toHaveLength(0);
  });

  it("すでに 30 秒以上前に終端のタスクは、最初の 1 回で止まる", async () => {
    const d: TaskDetailDto = {
      ...taskDetailRunningFixture,
      generated_at: "2026-10-21T06:00:00Z",
      task: {
        ...taskDetailRunningFixture.task,
        status: "FAILED",
        ended_at: "2026-10-21T05:00:00Z",
      },
      phase: "done",
    };
    const { env } = await mount(server({ detail: () => json(200, d) }));
    expect(env.pending()).toHaveLength(0);
  });

  it("「自動で更新する」を切ると止まり、状態は localStorage に保存。今すぐ更新で取れる", async () => {
    const s = server();
    const { c, env } = await mount(s);
    const box = c.querySelector("input[type='checkbox']") as HTMLInputElement;
    expect(box.checked).toBe(true);
    await act(async () => {
      box.click();
      await settle();
    });
    expect(env.pending()).toHaveLength(0);
    expect(store.get("rovo.dashboard.autoRefresh")).toBe("0");
    const before = s.calls.length;
    const btn = [...c.querySelectorAll("button")].find((b) => b.textContent === "今すぐ更新");
    await act(async () => {
      btn?.click();
      await settle();
    });
    expect(s.calls.length).toBe(before + 2);
  });
});

describe("さらに読む（before で遡る）", () => {
  const older = (from: number, to: number): TaskEventDto[] =>
    Array.from({ length: to - from + 1 }, (_, i) => ({
      seq: from + i,
      at: "2026-10-21T05:30:00Z",
      type: "agent_event" as const,
      agent_type: `old${from + i}`,
    }));
  const tail: TaskEventsPageDto = {
    task_id: ID,
    events: older(5, 7),
    oldest_seq: 5,
    newest_seq: 7,
    has_older: true,
  };

  it("has_older なら「さらに読む」。押すと before=最古の seq で取り、前に足す。尽きたらボタンが消える", async () => {
    const s = server({
      events: (_u, n) =>
        json(
          200,
          n === 0
            ? tail
            : {
                task_id: ID,
                events: older(3, 4),
                oldest_seq: 3,
                newest_seq: 4,
                has_older: false,
              },
        ),
    });
    const { c } = await mount(s);
    expect(steps(c).map((e) => e.getAttribute("data-seq"))).toEqual(["5", "6", "7"]);
    const btn = [...c.querySelectorAll("button")].find((b) => b.textContent === "さらに読む");
    expect(btn).toBeDefined();
    await act(async () => {
      btn?.click();
      await settle();
    });
    expect(s.calls.at(-1)).toBe("/events?before=5");
    expect(steps(c).map((e) => e.getAttribute("data-seq"))).toEqual(["3", "4", "5", "6", "7"]);
    expect([...c.querySelectorAll("button")].some((b) => b.textContent === "さらに読む")).toBe(
      false,
    );
  });

  it("遡りの取得に失敗したら、案内を出してボタンは残る", async () => {
    const s = server({
      events: (_u, n) => (n === 0 ? json(200, tail) : json(500, {})),
    });
    const { c } = await mount(s);
    const btn = [...c.querySelectorAll("button")].find((b) => b.textContent === "さらに読む");
    await act(async () => {
      btn?.click();
      await settle();
    });
    expect(text(c)).toContain("古い手順を読み込めませんでした");
    expect([...c.querySelectorAll("button")].some((b) => b.textContent === "さらに読む")).toBe(
      true,
    );
  });

  it("遡りが 404 なら 404 画面へ、401 なら onUnauthorized を呼んで止まる", async () => {
    for (const [status, code] of [
      [404, "not_found"],
      [401, "unauthorized"],
    ] as const) {
      const onUnauthorized = vi.fn();
      const s = server({
        events: (_u, n) => (n === 0 ? json(200, tail) : json(status, { error: code })),
      });
      const { c, env } = await mount(s, makeEnv(), onUnauthorized);
      const btn = [...c.querySelectorAll("button")].find((b) => b.textContent === "さらに読む");
      await act(async () => {
        btn?.click();
        await settle();
      });
      if (status === 404) expect(text(c)).toContain("このタスクは見られません");
      else expect(onUnauthorized).toHaveBeenCalled();
      expect(env.pending()).toHaveLength(0);
      for (const r of roots.splice(0)) act(() => r.unmount());
      document.body.innerHTML = "";
    }
  });

  it("遡ったあとの差分取得は、最後の seq の cursor のまま（古い側に引きずられない）", async () => {
    const s = server({
      events: (u, n) =>
        n === 0
          ? json(200, tail)
          : u.searchParams.has("before")
            ? json(200, {
                task_id: ID,
                events: older(3, 4),
                oldest_seq: 3,
                newest_seq: 4,
                has_older: false,
              })
            : json(200, {
                task_id: ID,
                events: [],
                oldest_seq: null,
                newest_seq: null,
                has_older: false,
              }),
    });
    const { c, env } = await mount(s);
    const btn = [...c.querySelectorAll("button")].find((b) => b.textContent === "さらに読む");
    await act(async () => {
      btn?.click();
      await settle();
    });
    await env.fire();
    expect(s.calls.at(-1)).toBe("/events?cursor=7");
    expect(steps(c)).toHaveLength(5);
  });
});

describe("表示の安全（D14）: 悪意ある文字列は文字として出る", () => {
  const EVIL_SCRIPT = "<script>window.__xss=1</script>";
  const EVIL_IMG = '<img src=x onerror="window.__xss=2">';
  const EVIL_LINK = "[x](javascript:window.__xss=3)";
  const evil = `${EVIL_SCRIPT}${EVIL_IMG}${EVIL_LINK}`;

  const detail: TaskDetailDto = {
    ...taskDetailRunningFixture,
    task: {
      ...taskDetailRunningFixture.task,
      title: `題名${evil}`,
      pr: {
        number: 1,
        // 契約を通らない値が来ても（壊れた gateway でも）リンクにしない
        url: "javascript:window.__xss=4" as never,
        draft: true,
        merged: false,
        state: "open",
      },
    },
    now: { kind: "command", text: `cmd ${evil}` },
    output: { tail: `out\n${evil}\n‮evil\u0007`, redacted: true },
  };
  const events: TaskEventsPageDto = {
    task_id: ID,
    events: [
      {
        seq: 1,
        at: "2026-10-21T05:50:00Z",
        type: "command",
        command: `echo ${evil}`,
        exit_code: 0,
        output_tail: evil,
      },
      {
        seq: 2,
        at: "2026-10-21T05:51:00Z",
        type: "edit",
        path: `a/${evil}`,
        op: "create",
        added: 1,
        removed: 0,
      },
      {
        seq: 3,
        at: "2026-10-21T05:52:00Z",
        type: "commit",
        message: evil,
        sha: "a".repeat(40),
        files: 1,
      },
      { seq: 4, at: "2026-10-21T05:53:00Z", type: "web", kind: "fetch", host: "example.com" },
      {
        seq: 5,
        at: "2026-10-21T05:54:00Z",
        type: "tool_start",
        call_id: "c",
        name: "bash",
        summary: evil,
      },
    ],
    oldest_seq: 1,
    newest_seq: 5,
    has_older: false,
  };

  it("題名・now・command・path・commit・出力は、タグも記法もそのまま文字。要素にならず、実行されない", async () => {
    const { c } = await mount(
      server({ detail: () => json(200, detail), events: () => json(200, events) }),
    );
    expect(c.querySelector("script, img, iframe, object, embed")).toBeNull();
    expect(c.querySelector("a[href^='javascript:']")).toBeNull();
    expect((window as { __xss?: unknown }).__xss).toBeUndefined();
    expect(c.querySelector("h1")?.textContent).toBe(`題名${evil}`);
    expect(c.querySelector(".now-line")?.textContent).toContain(`cmd ${evil}`);
    const pre = c.querySelector("pre.output")?.textContent ?? "";
    expect(pre).toContain(evil);
    expect(pre).not.toContain("‮");
    expect(pre).not.toContain("\u0007");
    const stepText = steps(c)
      .map((e) => e.textContent)
      .join("\n");
    expect(stepText).toContain(`echo ${evil}`);
    expect(stepText).toContain(`a/${evil}`);
    expect(stepText).toContain(evil);
  });

  it("PR の URL が許可の形でなければ、リンクにせず番号だけを文字で出す", async () => {
    const { c } = await mount(
      server({ detail: () => json(200, detail), events: () => json(200, events) }),
    );
    expect(c.querySelector("[data-pr] a")).toBeNull();
    expect(c.querySelector("[data-pr]")?.textContent).toContain("#1");
    expect(c.querySelector("[data-pr]")?.textContent).not.toContain("javascript:");
  });

  it("github.com.evil.com などもリンクにしない", async () => {
    const d: TaskDetailDto = {
      ...detail,
      task: {
        ...detail.task,
        pr: {
          ...(detail.task.pr as NonNullable<typeof detail.task.pr>),
          url: "https://github.com.evil.com/a/b/pull/1" as never,
        },
      },
    };
    const { c } = await mount(
      server({ detail: () => json(200, d), events: () => json(200, events) }),
    );
    expect(c.querySelector("[data-pr] a")).toBeNull();
  });
});

describe("画面の中での切り替え（fresh を付けない・キャッシュ・一覧の行の表示）", () => {
  const never = () => new Promise<Response>(() => {});

  it("fresh={false}: 最初の取得にも ?fresh=1 を付けない。ポーリングにも付けない", async () => {
    const s = server();
    const { env } = await mount(s, makeEnv(), () => {}, { fresh: false });
    expect(s.calls).toEqual(["", "/events"]);
    await env.fire();
    expect(s.calls.slice(2)).toEqual(["", "/events?cursor=9"]);
  });

  it("fresh を指定しなければ、これまでどおり最初の取得に付く（単体で開いたとき）", async () => {
    const s = server();
    await mount(s);
    expect(s.calls[0]).toBe("?fresh=1");
  });

  it("取れた詳細と events をキャッシュに入れる（最後の詳細）", async () => {
    const cache = createDetailCache();
    const s = server();
    await mount(s, makeEnv(), () => {}, { cache });
    const got = cache.get(ID);
    expect(got?.detail).toEqual(taskDetailRunningFixture);
    expect(got?.events).toEqual(legacyTailEvents.events);
    expect(got?.hasOlder).toBe(false);
  });

  it("キャッシュにあれば、取得を待たずにすぐ描く（進み具合・出力）", async () => {
    const cache = createDetailCache();
    cache.set(ID, {
      detail: {
        ...taskDetailRunningFixture,
        output: { tail: "CACHED-TAIL", redacted: true },
      },
      events: legacyTailEvents.events,
      hasOlder: false,
    });
    // 詳細が返らない間の表示を見る（events は返る）
    const hold = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).includes("/events")) return json(200, legacyTailEvents);
      return never();
    });
    const { c } = await mount({ ...server(), fn: hold }, makeEnv(), () => {}, {
      cache,
      fresh: false,
    });
    expect(c.querySelector("h1")?.textContent).toBe(taskDetailRunningFixture.task.title);
    expect(c.querySelector(".output")?.textContent).toContain("CACHED-TAIL");
    expect(steps(c)).toHaveLength(8); // fixture の 9 件のうち、画面に出る手順
    expect(text(c)).not.toContain("読み込み中");
  });

  it("キャッシュからの表示のあと、届いた詳細で差し替わり、events は cursor（最後の seq）の差分だけ取る", async () => {
    const cache = createDetailCache();
    cache.set(ID, {
      detail: { ...taskDetailRunningFixture, output: { tail: "CACHED-TAIL", redacted: true } },
      events: legacyTailEvents.events,
      hasOlder: false,
    });
    const s = server({
      detail: () =>
        json(200, { ...taskDetailRunningFixture, output: { tail: "NEW-TAIL", redacted: true } }),
      events: () => json(200, { ...taskEventsFixture, events: [] }),
    });
    const { c } = await mount(s, makeEnv(), () => {}, { cache, fresh: false });
    expect(s.calls).toEqual(["", "/events?cursor=9"]);
    expect(c.querySelector(".output")?.textContent).toContain("NEW-TAIL");
    expect(steps(c)).toHaveLength(8);
  });

  it("取り直しが 404 / 401 なら、キャッシュのその詳細を捨てる", async () => {
    for (const status of [404, 401]) {
      const cache = createDetailCache();
      cache.set(ID, { detail: taskDetailRunningFixture, events: [], hasOlder: false });
      const s = server({ detail: () => json(status, { error: "x" }) });
      const { c } = await mount(s, makeEnv(), () => {}, { cache, fresh: false });
      expect(cache.get(ID), String(status)).toBeUndefined();
      expect(text(c), String(status)).not.toContain(taskDetailRunningFixture.task.title);
      act(() => roots.pop()?.unmount());
      document.body.innerHTML = "";
    }
  });

  it("キャッシュが無く、一覧の行（preview）があれば、詳細が届く前に行の題名・状態・費用・リポジトリを描く。届いたら差し替わる", async () => {
    const row = taskDetailRunningFixture.task;
    let release: (r: Response) => void = () => {};
    const gate = new Promise<Response>((r) => {
      release = r;
    });
    const hold = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).includes("/events")) return json(200, taskEventsFixture);
      return gate;
    });
    const { c } = await mount({ ...server(), fn: hold }, makeEnv(), () => {}, {
      preview: { task: row, at: Date.parse("2026-10-21T06:00:00Z") },
      fresh: false,
    });
    expect(c.querySelector("h1")?.textContent).toBe(row.title);
    const head = c.querySelector(".con-head")?.textContent ?? "";
    expect(head).toContain("実行中");
    expect(head).toContain(formatUsd(row.cost.cost_usd, tJa));
    expect(head).toContain(row.repository);
    expect(head).toContain(row.owner_login);
    expect(text(c)).toContain("読み込み中");
    expect(c.querySelector(".output")).toBeNull();
    await act(async () => {
      release(json(200, taskDetailRunningFixture));
      await settle();
    });
    expect(c.querySelector(".output")).not.toBeNull();
    expect(text(c)).not.toContain("読み込み中");
  });

  it("preview に悪意ある題名があっても、詳細と同じ整形（制御文字を除き、HTML は文字）", async () => {
    const row = {
      ...taskDetailRunningFixture.task,
      title: "‮gpj.exe\u0007<img src=x onerror=alert(1)>\n改行",
    };
    const hold = vi.fn(async () => never());
    const { c } = await mount({ ...server(), fn: hold }, makeEnv(), () => {}, {
      preview: { task: row, at: 0 },
    });
    expect(c.querySelector("img")).toBeNull();
    const t = c.querySelector("h1")?.textContent ?? "";
    expect(t.includes("\u0007")).toBe(false);
    expect(/[‪-‮⁦-⁩]/.test(t)).toBe(false);
    expect(t).toContain("<img src=x onerror=alert(1)>");
  });

  it("preview が無ければ、これまでどおり「タスクの詳細 / 読み込み中」", async () => {
    const hold = vi.fn(async () => never());
    const { c } = await mount({ ...server(), fn: hold });
    expect(c.querySelector("h1")?.textContent).toBe("タスクの詳細");
    expect(text(c)).toContain("読み込み中");
  });

  it("画面を離れる（別のタスクへ切り替える）と、前の取得を止める（AbortController）", async () => {
    const signals: (AbortSignal | undefined)[] = [];
    const hold = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      signals.push(init?.signal ?? undefined);
      return never();
    });
    await mount({ ...server(), fn: hold });
    expect(signals).toHaveLength(1);
    expect(signals[0]?.aborted).toBe(false);
    act(() => roots.pop()?.unmount());
    expect(signals[0]?.aborted).toBe(true);
  });
});
