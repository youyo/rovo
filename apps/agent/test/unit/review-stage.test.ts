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
  type ReviewMessage,
  reviewWarnings,
  runReviewCommands,
  runReviewModel,
} from "../../src/review/stage";

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
  const calls: { system: string; messages: ReviewMessage[] }[] = [];
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
