import {
  TASK_STATUSES,
  type TaskDetailDto,
  type TaskEventDto,
  type TaskStatusDto,
  type VisibleTaskDto,
} from "@rovo/dashboard-contract";
import { overviewFixture, taskEventsFixture } from "@rovo/dashboard-contract/fixtures";
import { describe, expect, it } from "vitest";
import { buildSteps, describeEvent, mergeEvents, nowSentence, phaseBand } from "../src/steps";

type Phase = TaskDetailDto["phase"];
type Now = TaskDetailDto["now"];

const at = "2026-10-21T05:50:00Z";
const SHA = "a".repeat(40);
const ev = (seq: number, rest: Record<string, unknown>) =>
  ({ seq, at, ...rest }) as unknown as TaskEventDto;
const task = (over: Partial<VisibleTaskDto> = {}): VisibleTaskDto => ({
  ...(overviewFixture.tasks[0] as VisibleTaskDto),
  ...over,
});
const usage = (seq: number) =>
  ev(seq, {
    type: "usage",
    cost_usd: 1,
    input_tokens: 1,
    output_tokens: 1,
    cache_read_tokens: 0,
    cache_write_tokens: 0,
  });

describe("describeEvent（人の言葉の動詞への変換。全イベントの型 × 成功 / 失敗 / 実行中）", () => {
  it("command: 成功・失敗・実行中", () => {
    const base = { type: "command", command: "pnpm test", exit_code: 0, duration_ms: 42_000 };
    const ok = describeEvent(ev(1, base), { current: false });
    expect(ok).toMatchObject({ what: "コマンドを実行した", target: "pnpm test", tone: "normal" });
    expect(ok?.note).toContain("42 秒");
    const fail = describeEvent(ev(1, { ...base, exit_code: 2 }), { current: false });
    expect(fail).toMatchObject({ what: "コマンドが失敗した", tone: "fail" });
    expect(fail?.note).toContain("終了コード 2");
    const run = describeEvent(ev(1, { ...base, exit_code: null }), { current: true });
    expect(run).toMatchObject({ what: "コマンドを実行中", tone: "normal" });
    const stale = describeEvent(ev(1, { ...base, exit_code: null }), { current: false });
    expect(stale?.what).toBe("コマンドを実行した");
    expect(stale?.note).toContain("終了コード不明");
  });

  it("command: 複数行・制御文字は 1 行にして除く", () => {
    const d = describeEvent(
      ev(1, { type: "command", command: "echo a\nrm‮ -rf\u0007 b", exit_code: 0 }),
      { current: false },
    );
    expect(d?.target).toBe("echo a rm -rf b");
  });

  it("edit: 作った / 編集した / 消した", () => {
    const e = (op: string) =>
      describeEvent(ev(1, { type: "edit", path: "src/a.ts", op, added: 12, removed: 3 }), {
        current: false,
      });
    expect(e("create")).toMatchObject({ what: "ファイルを作った", target: "src/a.ts" });
    expect(e("modify")).toMatchObject({ what: "ファイルを編集した", target: "src/a.ts" });
    expect(e("delete")).toMatchObject({ what: "ファイルを消した", target: "src/a.ts" });
    expect(e("modify")?.note).toBe("12 行追加、3 行削除");
  });

  it("edit: 実行中（current）でも失敗にはならない", () => {
    const d = describeEvent(
      ev(1, { type: "edit", path: "a", op: "modify", added: 0, removed: 0 }),
      {
        current: true,
      },
    );
    expect(d?.tone).toBe("normal");
  });

  it("commit", () => {
    const d = describeEvent(ev(1, { type: "commit", message: "fix: 直す", sha: SHA, files: 2 }), {
      current: false,
    });
    expect(d).toMatchObject({ what: "コミットした", target: "fix: 直す" });
    expect(d?.note).toContain("2 ファイル");
    expect(d?.note).toContain("aaaaaaa");
  });

  it("web: 検索した / ページを読んだ / ページを開いた（host は無くてもよい）", () => {
    const w = (kind: string, host?: string) =>
      describeEvent(ev(1, { type: "web", kind, ...(host ? { host } : {}) }), { current: false });
    expect(w("search", "example.com")).toMatchObject({ what: "検索した", target: "example.com" });
    expect(w("fetch", "registry.npmjs.org")).toMatchObject({ what: "ページを読んだ" });
    expect(w("browse", "example.com")).toMatchObject({ what: "ページを開いた" });
    expect(w("search")?.target).toBe("");
  });

  it("status_changed: 全状態に文がある。reason は note に出る", () => {
    for (const s of TASK_STATUSES) {
      const d = describeEvent(ev(1, { type: "status_changed", to: s }), { current: false });
      expect(d?.what.length, s).toBeGreaterThan(0);
    }
    const f = describeEvent(
      ev(1, { type: "status_changed", to: "FAILED", reason: "base_sha_not_found" }),
      { current: false },
    );
    expect(f).toMatchObject({ what: "失敗した", tone: "fail" });
    expect(f?.note).toContain("base_sha_not_found");
    expect(
      describeEvent(ev(1, { type: "status_changed", to: "COMPLETED" }), { current: false })?.tone,
    ).toBe("normal");
  });

  it("draft_pr_created", () => {
    const d = describeEvent(
      ev(1, { type: "draft_pr_created", pr_number: 23, pr_url: "https://github.com/a/b/pull/23" }),
      { current: false },
    );
    expect(d).toMatchObject({ what: "Draft PR を作った", target: "#23" });
  });

  it("tool_start / tool_end（古い agent。動詞の無い素の一覧）", () => {
    const start = ev(1, { type: "tool_start", call_id: "c", name: "bash", summary: "ls" });
    expect(describeEvent(start, { current: true })).toMatchObject({
      what: "bash を実行中",
      target: "ls",
    });
    expect(describeEvent(start, { current: false })?.what).toBe("bash を実行した");
    const ok = describeEvent(
      ev(2, { type: "tool_end", call_id: "c", is_error: false, summary: "ok" }),
      { current: false },
    );
    expect(ok).toMatchObject({ what: "ツールが終わった", target: "ok", tone: "normal" });
    const bad = describeEvent(
      ev(2, { type: "tool_end", call_id: "c", is_error: true, summary: "x" }),
      { current: false },
    );
    expect(bad).toMatchObject({ what: "ツールが失敗した", tone: "fail" });
  });

  it("agent_event（gateway が知らない型）は型名だけ。usage は進み具合に出さない（null）", () => {
    expect(
      describeEvent(ev(1, { type: "agent_event", agent_type: "future" }), { current: false }),
    ).toMatchObject({ what: "その他の処理", target: "future" });
    expect(describeEvent(usage(1), { current: false })).toBeNull();
  });

  it("fixtures の全イベントを変換できる（usage 以外は null にならない）", () => {
    for (const e of taskEventsFixture.events) {
      const d = describeEvent(e, { current: false });
      if (e.type === "usage") expect(d).toBeNull();
      else expect(d?.what.length, e.type).toBeGreaterThan(0);
    }
  });

  it("<script>・<img onerror>・javascript: のリンク記法は文字のまま。制御文字・双方向文字だけ除く", () => {
    const evil =
      "<script>window.__xss=1</script><img src=x onerror=alert(1)>[x](javascript:alert(1))";
    const d = describeEvent(ev(1, { type: "commit", message: `${evil}‮`, sha: SHA, files: 1 }), {
      current: false,
    });
    expect(d?.target).toBe(evil);
  });
});

describe("mergeEvents（seq で重複排除・昇順）", () => {
  const e = (seq: number) => ev(seq, { type: "agent_event", agent_type: `t${seq}` });
  it("重複を積まない。順序は seq の昇順", () => {
    const merged = mergeEvents([e(3), e(4)], [e(5), e(4), e(3), e(6)]);
    expect(merged.map((x) => x.seq)).toEqual([3, 4, 5, 6]);
  });
  it("古い側（before）を前に足せる", () => {
    expect(mergeEvents([e(5), e(6)], [e(3), e(4)]).map((x) => x.seq)).toEqual([3, 4, 5, 6]);
  });
  it("同じ seq は後から来た方で置き換える", () => {
    const a = ev(1, { type: "agent_event", agent_type: "old" });
    const b = ev(1, { type: "agent_event", agent_type: "new" });
    const m = mergeEvents([a], [b]);
    expect(m).toHaveLength(1);
    expect((m[0] as { agent_type: string }).agent_type).toBe("new");
  });
  it("元の配列を変えない", () => {
    const prev = [e(2)];
    mergeEvents(prev, [e(1)]);
    expect(prev.map((x) => x.seq)).toEqual([2]);
  });
});

describe("buildSteps", () => {
  it("時系列で、実行中のタスクは最後の手順が「いま」。usage は含めない", () => {
    const steps = buildSteps(taskEventsFixture.events, true);
    expect(steps.map((s) => s.seq)).toEqual([1, 2, 3, 4, 5, 6, 7, 9]);
    expect(steps.filter((s) => s.current).map((s) => s.seq)).toEqual([9]);
  });
  it("終端のタスクには「いま」が無い", () => {
    expect(buildSteps(taskEventsFixture.events, false).some((s) => s.current)).toBe(false);
  });
  it("最後が usage でも、その前の手順が「いま」", () => {
    const evs = [ev(1, { type: "web", kind: "search" }), usage(2)];
    expect(buildSteps(evs, true).map((s) => [s.seq, s.current])).toEqual([[1, true]]);
  });
  it("空なら空", () => {
    expect(buildSteps([], true)).toEqual([]);
  });
});

describe("phaseBand（準備 → 実行 → 検証 → 完了）", () => {
  const states = (s: TaskStatusDto, over: Partial<VisibleTaskDto> = {}, phase: Phase = "run") =>
    phaseBand(task({ status: s, ...over }), phase).map((b) => b.state);
  it("名前は 準備・実行・検証・完了 の 4 つ", () => {
    expect(phaseBand(task({ status: "RUNNING" }), "run").map((b) => b.name)).toEqual([
      "準備",
      "実行",
      "検証",
      "完了",
    ]);
  });
  it("CREATING → 準備がいま", () => {
    expect(states("CREATING", {}, "prepare")).toEqual(["now", "todo", "todo", "todo"]);
  });
  it("RUNNING → 実行がいま", () => {
    expect(states("RUNNING")).toEqual(["done", "now", "todo", "todo"]);
  });
  it("VERIFYING → 検証がいま", () => {
    expect(states("VERIFYING", {}, "verify")).toEqual(["done", "done", "now", "todo"]);
  });
  it("INPUT_REQUIRED → 実行で止まって入力待ち（waiting）", () => {
    expect(states("INPUT_REQUIRED")).toEqual(["done", "waiting", "todo", "todo"]);
  });
  it("RECOVERING → 実行のまま復旧中（recovering）", () => {
    expect(states("RECOVERING")).toEqual(["done", "recovering", "todo", "todo"]);
  });
  it("COMPLETED → すべて済み", () => {
    expect(states("COMPLETED", {}, "done")).toEqual(["done", "done", "done", "done"]);
  });
  it("failure_phase が setup → 準備で止まった（stopped）", () => {
    expect(
      states("FAILED", { failure_phase: "setup", reason: "base_sha_not_found" }, "prepare"),
    ).toEqual(["stopped", "todo", "todo", "todo"]);
    // サーバーの phase が done でも、failure_phase が優先
    expect(states("FAILED", { failure_phase: "setup" }, "done")).toEqual([
      "stopped",
      "todo",
      "todo",
      "todo",
    ]);
  });
  it("実行中に失敗 / 予算超過 / キャンセル → サーバーの phase の段階で止まった", () => {
    for (const s of ["FAILED", "BUDGET_EXCEEDED", "CANCELLED"] as const) {
      expect(states(s, {}, "run"), s).toEqual(["done", "stopped", "todo", "todo"]);
      expect(states(s, {}, "verify"), s).toEqual(["done", "done", "stopped", "todo"]);
    }
  });
  it("終端で phase が done のとき: VERIFYING に入った記録があれば検証で、無ければ実行で止まった", () => {
    const withVerify = phaseBand(task({ status: "FAILED" }), "done", new Set(["VERIFYING"]));
    expect(withVerify.map((b) => b.state)).toEqual(["done", "done", "stopped", "todo"]);
    const without = phaseBand(
      task({ status: "FAILED", started_at: "2026-10-21T01:06:10Z" }),
      "done",
    );
    expect(without.map((b) => b.state)).toEqual(["done", "stopped", "todo", "todo"]);
    const never = phaseBand(task({ status: "CANCELLED", started_at: null }), "done");
    expect(never.map((b) => b.state)).toEqual(["stopped", "todo", "todo", "todo"]);
  });
  it("全状態で、色に頼らない文字（label）が全段にある", () => {
    for (const s of TASK_STATUSES) {
      for (const b of phaseBand(task({ status: s }), "run")) {
        expect(b.label.length, `${s}/${b.name}`).toBeGreaterThan(0);
      }
    }
  });
  it("止まった段の文字は状態ごとに違う（失敗 / 予算超過 / キャンセル）", () => {
    const l = (s: TaskStatusDto) =>
      phaseBand(task({ status: s }), "run").find((b) => b.state === "stopped")?.label;
    expect(new Set([l("FAILED"), l("BUDGET_EXCEEDED"), l("CANCELLED")]).size).toBe(3);
  });
});

describe("nowSentence（「いまは X を実行しています」）", () => {
  const now = (kind: string, text: string) => ({ kind, text }) as unknown as Now;
  const sentence = (n: Now, s: TaskStatusDto) => nowSentence(n, s);
  it("now がある: 種類ごとの動詞", () => {
    expect(sentence(now("command", "npm ci"), "RUNNING")).toEqual({
      before: "いまは ",
      target: "npm ci",
      after: " を実行しています。",
    });
    expect(sentence(now("edit", "a.ts"), "RUNNING").after).toBe(" を編集しています。");
    expect(sentence(now("commit", "m"), "RUNNING").after).toBe(" をコミットしています。");
    expect(sentence(now("web", "example.com"), "RUNNING").after).toBe(" を調べています。");
    expect(sentence(now("tool", "x"), "RUNNING").after).toBe(" を実行しています。");
  });
  it("waiting は固定の文（英語の text をそのまま出さない）", () => {
    expect(sentence(now("waiting", "waiting for input"), "INPUT_REQUIRED")).toEqual({
      before: "入力を待っています。",
      target: "",
      after: "",
    });
  });
  it("now が null: 状態ごとの文", () => {
    for (const s of TASK_STATUSES) {
      const n = sentence(null, s);
      expect(`${n.before}${n.target}${n.after}`.length, s).toBeGreaterThan(0);
      expect(n.target).toBe("");
    }
    expect(sentence(null, "INPUT_REQUIRED").before).toContain("待");
    expect(sentence(null, "COMPLETED").before).toContain("完了");
  });
  it("target は制御文字を除いた 1 行", () => {
    expect(sentence(now("command", "a\nb‮"), "RUNNING").target).toBe("a b");
  });
});
