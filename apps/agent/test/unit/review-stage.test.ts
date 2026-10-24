import { describe, expect, it } from "vitest";
import {
  buildReviewInput,
  REVIEW_JSON_ONLY_RETRY,
  REVIEW_SYSTEM_PROMPT,
} from "../../src/review/input";
import {
  type CommandRunner,
  type ModelCaller,
  type ModelCallResult,
  REVIEW_MAX_TOOL_ROUNDS,
  REVIEW_TOOL_RESULT_TOTAL_MAX_BYTES,
  type ReviewMessage,
  reviewWarnings,
  runReviewCommands,
  runReviewModel,
} from "../../src/review/stage";
import type { ReviewToolRunner } from "../../src/review/tools";

const T0 = 1_000_000;

function runner(
  over: Partial<CommandRunner> & {
    results?: { exitCode: number; output?: string; timedOut?: boolean; advanceMs?: number }[];
  } = {},
) {
  const clock = { now: T0 };
  const ran: { argv: string[]; timeoutMs: number }[] = [];
  let prepared = 0;
  const results = [...(over.results ?? [])];
  const r: CommandRunner = {
    now: () => clock.now,
    stopped: () => false,
    prepare: async () => {
      prepared++;
    },
    run: async (cmd, timeoutMs) => {
      ran.push({ argv: cmd.argv, timeoutMs });
      const next = results.shift() ?? { exitCode: 0 };
      clock.now += next.advanceMs ?? 1000;
      return {
        exitCode: next.exitCode,
        timedOut: next.timedOut ?? false,
        output: next.output ?? "",
      };
    },
    ...over,
  };
  return { r, clock, ran, prepared: () => prepared };
}

const cmd = (...argv: string[]) => ({ argv });

describe("runReviewCommands", () => {
  it("コマンドが無ければ Sandbox を用意しない（差分だけのレビュー）", async () => {
    const t = runner();
    const out = await runReviewCommands(t.r, [], T0 + 60_000);
    expect(out).toEqual({ results: [], unavailable: false, timedOut: false, stopped: false });
    expect(t.prepared()).toBe(0);
  });

  it("1 本が失敗しても止めず、全部を順に流す", async () => {
    const t = runner({
      results: [
        { exitCode: 1, output: "boom" },
        { exitCode: 0, output: "ok" },
      ],
    });
    const out = await runReviewCommands(
      t.r,
      [cmd("pnpm", "test"), cmd("pnpm", "lint")],
      T0 + 3_600_000,
    );
    expect(t.ran.map((x) => x.argv)).toEqual([
      ["pnpm", "test"],
      ["pnpm", "lint"],
    ]);
    expect(out.results.map((x) => x.exitCode)).toEqual([1, 0]);
    expect(out.results[0]?.output).toBe("boom");
    expect(out.results[0]?.durationMs).toBe(1000);
    expect(t.prepared()).toBe(1);
  });

  it("Sandbox を用意できなければ、結果なしで unavailable", async () => {
    const t = runner({
      prepare: async () => {
        throw new Error("no container");
      },
    });
    const out = await runReviewCommands(t.r, [cmd("pnpm", "test")], T0 + 3_600_000);
    expect(out).toMatchObject({ results: [], unavailable: true });
    expect(t.ran).toEqual([]);
  });

  it("実行中に Sandbox が例外を投げたコマンドは exit -1 として残し、次へ進む", async () => {
    let n = 0;
    const t = runner({
      run: async () => {
        n++;
        if (n === 1) throw new Error("rpc failed");
        return { exitCode: 0, timedOut: false, output: "" };
      },
    });
    const out = await runReviewCommands(t.r, [cmd("a"), cmd("b")], T0 + 3_600_000);
    expect(out.results.map((x) => x.exitCode)).toEqual([-1, 0]);
    expect(out.results[0]?.output).toMatch(/could not run/);
  });

  it("段の時間の上限を過ぎたら、残りのコマンドを飛ばして timedOut。1 本の時間は残りの時間で頭打ち", async () => {
    const t = runner({ results: [{ exitCode: 0, advanceMs: 10 * 60_000 }] });
    const out = await runReviewCommands(
      t.r,
      [{ argv: ["slow"], timeoutSeconds: 1800 }, cmd("next")],
      T0 + 5 * 60_000,
    );
    expect(t.ran).toHaveLength(1);
    expect(t.ran[0]?.timeoutMs).toBe(5 * 60_000);
    expect(out.timedOut).toBe(true);
    expect(out.results[1]).toMatchObject({ argv: ["next"], skipped: true });
  });

  it("止められたら（cancel など）残りを流さない", async () => {
    let stop = false;
    const t = runner({
      stopped: () => stop,
      run: async () => {
        stop = true;
        return { exitCode: 0, timedOut: false, output: "" };
      },
    });
    const out = await runReviewCommands(t.r, [cmd("a"), cmd("b")], T0 + 3_600_000);
    expect(out.stopped).toBe(true);
    expect(out.results).toHaveLength(1);
  });
});

const input = () =>
  buildReviewInput({
    header: "Review pull request o/r#1 at x.",
    title: "t",
    body: "",
    diff: "diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1 @@\n-a\n+b\n",
    diffTruncatedUpstream: false,
    commands: [],
    commandsUnavailable: false,
  });

const valid = JSON.stringify({
  summary: "s",
  must_fix: [{ path: "src/a.ts", line: 1, reason: "r", change: "c", severity: "high" }],
  suggestions: [],
});

function caller(answers: ModelCallResult[]) {
  const calls: Parameters<ModelCaller["call"]>[0][] = [];
  const m: ModelCaller = {
    call: async (req) => {
      calls.push(req);
      return answers.shift() ?? { ok: false, code: "model_error" };
    },
  };
  return { m, calls };
}

describe("runReviewModel", () => {
  it("1 回の呼び出しで検査済みの答えを返す（ツールなし。system は固定の指示）", async () => {
    const c = caller([{ ok: true, text: valid, truncated: false }]);
    const out = await runReviewModel(c.m, input());
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.verdict.mustFix).toHaveLength(1);
    expect(c.calls).toHaveLength(1);
    expect(c.calls[0]?.system).toBe(REVIEW_SYSTEM_PROMPT);
    expect(c.calls[0]?.messages).toHaveLength(1);
  });

  it("JSON でなければ 1 回だけ「JSON だけ」と再要求する", async () => {
    const c = caller([
      { ok: true, text: "LGTM", truncated: false },
      { ok: true, text: valid, truncated: false },
    ]);
    const out = await runReviewModel(c.m, input());
    expect(out.ok).toBe(true);
    expect(c.calls).toHaveLength(2);
    const second = c.calls[1]?.messages ?? [];
    expect(second.map((x) => x.role)).toEqual(["user", "assistant", "user"]);
    expect(second[2]).toEqual({ role: "user", blocks: [REVIEW_JSON_ONLY_RETRY] });
  });

  it("再要求しても合わなければ invalid_response（3 回目は呼ばない）", async () => {
    const c = caller([
      { ok: true, text: "LGTM", truncated: false },
      { ok: true, text: "{}", truncated: false },
      { ok: true, text: valid, truncated: false },
    ]);
    const out = await runReviewModel(c.m, input());
    expect(out).toEqual({ ok: false, code: "invalid_response" });
    expect(c.calls).toHaveLength(2);
  });

  it("出力の上限で切れた答えは JSON が閉じていないものとして扱う", async () => {
    const c = caller([
      { ok: true, text: valid, truncated: true },
      { ok: true, text: valid, truncated: true },
    ]);
    expect(await runReviewModel(c.m, input())).toEqual({ ok: false, code: "invalid_response" });
  });

  it("モデルの失敗（5xx・タイムアウト）は 1 回だけ再試行する", async () => {
    const c = caller([
      { ok: false, code: "timeout" },
      { ok: true, text: valid, truncated: false },
    ]);
    expect((await runReviewModel(c.m, input())).ok).toBe(true);
    const c2 = caller([
      { ok: false, code: "model_error" },
      { ok: false, code: "model_error" },
      { ok: true, text: valid, truncated: false },
    ]);
    expect(await runReviewModel(c2.m, input())).toEqual({ ok: false, code: "model_error" });
    expect(c2.calls).toHaveLength(2);
  });

  it("モデルがリクエストを拒否した（4xx）・予算が足りないときは再試行しない", async () => {
    for (const code of ["model_rejected", "budget"] as const) {
      const c = caller([
        { ok: false, code },
        { ok: true, text: valid, truncated: false },
      ]);
      expect(await runReviewModel(c.m, input())).toEqual({ ok: false, code });
      expect(c.calls).toHaveLength(1);
    }
  });
});

describe("reviewWarnings", () => {
  it("段の状況から warnings の固定コードを作る", () => {
    expect(
      reviewWarnings({ unavailable: true, timedOut: true, redacted: true, failure: undefined }),
    ).toEqual(["review_commands_unavailable", "review_timeout", "review_redacted"]);
    expect(
      reviewWarnings({
        unavailable: false,
        timedOut: false,
        redacted: false,
        failure: "model_error",
      }),
    ).toEqual(["review_failed: model_error"]);
    expect(
      reviewWarnings({ unavailable: false, timedOut: false, redacted: false, failure: "budget" }),
    ).toEqual(["review_skipped_budget"]);
    expect(
      reviewWarnings({ unavailable: false, timedOut: false, redacted: false, failure: undefined }),
    ).toEqual([]);
  });
});

// ---- 道具の往復 ----

const toolCall = (id: string, name = "read_file", args: unknown = { path: "src/a.ts" }) => ({
  ok: true as const,
  text: "",
  truncated: false,
  toolCalls: [{ id, name, arguments: args }],
});
const jsonAnswer = { ok: true as const, text: valid, truncated: false };

function toolRunner(text = "<wrapped result>") {
  const ran: { name: string; arguments: unknown }[] = [];
  const runner: ReviewToolRunner = {
    definitions: [
      { name: "read_file", description: "d", parameters: {} },
      { name: "list_files", description: "d", parameters: {} },
      { name: "search", description: "d", parameters: {} },
    ],
    run: async (call) => {
      ran.push(call);
      return { text, isError: false };
    },
    redacted: () => false,
  };
  return { runner, ran };
}

describe("runReviewModel: 道具の往復", () => {
  it("往復の上限は 20 回（定数）", () => {
    expect(REVIEW_MAX_TOOL_ROUNDS).toBe(20);
  });

  it("道具を 1 回呼んでから JSON を返す。道具の定義を渡し、結果は次の呼び出しの会話に入る", async () => {
    const c = caller([toolCall("t1"), jsonAnswer]);
    const t = toolRunner();
    const out = await runReviewModel(c.m, input(), { tools: t.runner });
    expect(out.ok).toBe(true);
    expect(t.ran).toEqual([{ name: "read_file", arguments: { path: "src/a.ts" } }]);
    expect(c.calls).toHaveLength(2);
    expect(c.calls[0]?.tools?.map((d) => d.name)).toEqual(["read_file", "list_files", "search"]);
    const second = c.calls[1]?.messages ?? [];
    expect(second.map((m) => m.role)).toEqual(["user", "assistant", "tool"]);
    expect(second[2]).toEqual({
      role: "tool",
      results: [{ id: "t1", name: "read_file", text: "<wrapped result>", isError: false }],
    });
  });

  it("道具を渡さなければ、これまでと同じ 1 回呼び（tools は渡さない）", async () => {
    const c = caller([jsonAnswer]);
    await runReviewModel(c.m, input());
    expect(c.calls[0]?.tools).toBeUndefined();
  });

  it("20 回往復しても JSON が出なければ、道具を外して 1 回だけ「JSON だけ」と求め、返れば成功", async () => {
    const answers: ModelCallResult[] = [];
    for (let i = 0; i < REVIEW_MAX_TOOL_ROUNDS; i++) answers.push(toolCall(`t${i}`));
    answers.push(jsonAnswer);
    const c = caller(answers);
    const t = toolRunner();
    const out = await runReviewModel(c.m, input(), { tools: t.runner });
    expect(out.ok).toBe(true);
    expect(t.ran).toHaveLength(REVIEW_MAX_TOOL_ROUNDS);
    expect(c.calls).toHaveLength(REVIEW_MAX_TOOL_ROUNDS + 1);
    // 20 回目までは道具つき、最後の 1 回は道具なし
    for (const call of c.calls.slice(0, REVIEW_MAX_TOOL_ROUNDS)) expect(call.tools).toBeDefined();
    const last = c.calls[REVIEW_MAX_TOOL_ROUNDS];
    expect(last?.tools).toBeUndefined();
    // 道具なしの求めの会話は、道具の呼び出し・結果のブロックを含まず（道具の定義が無いため）、最後は「JSON だけ」
    expect(last?.messages.every((m) => m.role === "user" || m.role === "assistant")).toBe(true);
    const lastMsg = last?.messages.at(-1);
    expect(lastMsg?.role).toBe("user");
    expect(lastMsg?.role === "user" && lastMsg.blocks.join("\n")).toContain(REVIEW_JSON_ONLY_RETRY);
  });

  it("最後の求めでも JSON にならなければ tool_rounds_exceeded（それ以上は呼ばない）", async () => {
    const answers: ModelCallResult[] = [];
    for (let i = 0; i < REVIEW_MAX_TOOL_ROUNDS; i++) answers.push(toolCall(`t${i}`));
    answers.push({ ok: true, text: "I need to look more", truncated: false });
    answers.push(jsonAnswer);
    const c = caller(answers);
    const out = await runReviewModel(c.m, input(), { tools: toolRunner().runner });
    expect(out).toEqual({ ok: false, code: "tool_rounds_exceeded" });
    expect(c.calls).toHaveLength(REVIEW_MAX_TOOL_ROUNDS + 1);
  });

  it("最後の求めで道具を呼んできても、実行せず tool_rounds_exceeded", async () => {
    const answers: ModelCallResult[] = [];
    for (let i = 0; i <= REVIEW_MAX_TOOL_ROUNDS; i++) answers.push(toolCall(`t${i}`));
    const t = toolRunner();
    const out = await runReviewModel(caller(answers).m, input(), { tools: t.runner });
    expect(out).toEqual({ ok: false, code: "tool_rounds_exceeded" });
    expect(t.ran).toHaveLength(REVIEW_MAX_TOOL_ROUNDS);
  });

  it("道具の結果が大きくなりすぎたら、残りの往復を待たずに道具を外して JSON を求める", async () => {
    const big = "x".repeat(REVIEW_TOOL_RESULT_TOTAL_MAX_BYTES + 1);
    const c = caller([toolCall("t1"), jsonAnswer]);
    const out = await runReviewModel(c.m, input(), { tools: toolRunner(big).runner });
    expect(out.ok).toBe(true);
    expect(c.calls).toHaveLength(2);
    expect(c.calls[1]?.tools).toBeUndefined();
  });

  it("1 回の応答で複数の道具を呼ぶと、順に実行して結果を 1 つにまとめて返す（1 往復と数える）", async () => {
    const two = {
      ok: true as const,
      text: "",
      truncated: false,
      toolCalls: [
        { id: "a", name: "list_files", arguments: {} },
        { id: "b", name: "search", arguments: { pattern: "x" } },
      ],
    };
    const c = caller([two, jsonAnswer]);
    const t = toolRunner();
    await runReviewModel(c.m, input(), { tools: t.runner });
    expect(t.ran.map((r) => r.name)).toEqual(["list_files", "search"]);
    const msg = c.calls[1]?.messages.at(-1);
    expect(msg?.role === "tool" && msg.results.map((r) => r.id)).toEqual(["a", "b"]);
  });

  it("道具の往復のあとに JSON でない答えが来たら、道具なしで 1 回だけ「JSON だけ」と再要求する", async () => {
    const c = caller([toolCall("t1"), { ok: true, text: "LGTM", truncated: false }, jsonAnswer]);
    const out = await runReviewModel(c.m, input(), { tools: toolRunner().runner });
    expect(out.ok).toBe(true);
    expect(c.calls).toHaveLength(3);
    expect(c.calls[2]?.tools).toBeUndefined();
  });

  it("往復の途中で予算が足りなくなったら budget で打ち切り、会話を持ち帰る（再開できる）", async () => {
    const c = caller([toolCall("t1"), { ok: false, code: "budget" }, jsonAnswer]);
    const t = toolRunner();
    const out = await runReviewModel(c.m, input(), { tools: t.runner });
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.code).toBe("budget");
    expect(c.calls).toHaveLength(2);
    expect(out.resume?.rounds).toBe(1);
    expect(out.resume?.messages.map((m) => m.role)).toEqual(["user", "assistant", "tool"]);
    // 続きから: 会話と往復の数を引き継いで、もう一度呼ぶ
    const c2 = caller([jsonAnswer]);
    const again = await runReviewModel(c2.m, input(), { tools: t.runner, resume: out.resume });
    expect(again.ok).toBe(true);
    expect(c2.calls[0]?.messages.map((m) => m.role)).toEqual(["user", "assistant", "tool"]);
  });

  it("道具の往復の途中のモデルの失敗は 1 回だけ再試行する", async () => {
    const c = caller([toolCall("t1"), { ok: false, code: "timeout" }, jsonAnswer]);
    const out = await runReviewModel(c.m, input(), { tools: toolRunner().runner });
    expect(out.ok).toBe(true);
    expect(c.calls).toHaveLength(3);
  });
});

describe("reviewWarnings: tool_rounds_exceeded", () => {
  it("review_failed: tool_rounds_exceeded になる", () => {
    expect(
      reviewWarnings({
        unavailable: false,
        timedOut: false,
        redacted: false,
        failure: "tool_rounds_exceeded",
      }),
    ).toEqual(["review_failed: tool_rounds_exceeded"]);
  });
});
