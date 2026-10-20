import { abortAllDurableObjects, env, runInDurableObject } from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";
import { clearAgentTestOverrides } from "../../src/agent/deps";
import type { UsageDto } from "../../src/agent/types";
import {
  allEvents,
  call,
  done,
  makeSpec,
  newFixture,
  report,
  T0,
  waitForPhase,
  waitForTerminal,
  waitUntil,
} from "./support/agent-fixture";

afterEach(() => clearAgentTestOverrides());

// private メンバーを観測するための薄いラッパ。型の再帰が深くなるので、スタブの型を畳む
// biome-ignore lint/suspicious/noExplicitAny: private メンバーの観測
type Inst = any;
const runInDO = runInDurableObject as unknown as <T>(
  stub: unknown,
  fn: (inst: Inst) => Promise<T> | T,
) => Promise<T>;

describe("start の冪等性", () => {
  it("同一の spec の再送は受理済みを返し、異なる spec は conflict", async () => {
    const fx = newFixture("idem-1", [call("gate")]);
    const spec = makeSpec("idem-1");
    const first = await fx.stub.start(spec);
    expect(first).toMatchObject({ status: "accepted", alreadyAccepted: false });
    const again = await fx.stub.start(spec);
    expect(again).toMatchObject({ status: "accepted", alreadyAccepted: true });
    const other = await fx.stub.start({ ...spec, instructions: "別の指示" });
    expect(other).toEqual({ status: "conflict" });
    // ensureReady は 1 回だけ、WorkspaceSpec は spec から作られる
    expect(fx.sandbox.readySpecs).toHaveLength(1);
    expect(fx.sandbox.readySpecs[0]).toMatchObject({
      repository: "octo/repo",
      baseSha: "base000",
      branch: "agent/task-idem-1",
      deadlineAt: spec.deadlineAt,
    });
    fx.gate.release();
    // 後始末: run を最後まで進めて終端にする（走らせたまま overrides を消すと、本物の SandboxDO を呼んでしまう）
    expect(await waitForTerminal(fx)).toBe("failed");
  });

  it("未知のモデルは起動時に拒否し、何も始めない", async () => {
    const fx = newFixture("unknown-model", [], { modelId: "anthropic/claude-nonexistent" });
    const res = await fx.stub.start(makeSpec("unknown-model"));
    expect(res).toMatchObject({ status: "rejected" });
    expect(fx.sandbox.readySpecs).toHaveLength(0);
    expect(fx.modelCalls.count).toBe(0);
  });
});

describe("タスクごとのモデル（D10）", () => {
  // vitest.config.ts の AGENT_MODELS: sonnet（既定）・haiku・gpt-6-sol

  it("AGENT_MODELS にあるモデルを spec.model に指定すると受理する", async () => {
    const fx = newFixture("model-ok", [report()]);
    const res = await fx.stub.start(makeSpec("model-ok", { model: "anthropic/claude-haiku-5-5" }));
    expect(res).toMatchObject({ status: "accepted" });
    expect(await waitForTerminal(fx)).toBe("completed");
  });

  it("AGENT_MODELS に無いモデル（許可リストにはある gpt-6-astra も、許可リスト外も）は起動時に拒否する", async () => {
    for (const [i, model] of ["openai/gpt-6-astra", "anthropic/claude-opus-5", "x"].entries()) {
      const fx = newFixture(`model-ng-${i}`, []);
      const res = await fx.stub.start(makeSpec(`model-ng-${i}`, { model }));
      expect(res, model).toMatchObject({ status: "rejected" });
      expect((res as { reason: string }).reason, model).toContain("unknown_model");
      expect(fx.sandbox.readySpecs, model).toHaveLength(0);
      expect(fx.modelCalls.count, model).toBe(0);
    }
  });

  it("model の有無は spec の同一性に入る（違えば conflict）", async () => {
    const fx = newFixture("model-fp", [call("gate")]);
    const spec = makeSpec("model-fp", { model: "anthropic/claude-haiku-5-5" });
    expect(await fx.stub.start(spec)).toMatchObject({ status: "accepted" });
    expect(await fx.stub.start({ ...spec, model: "openai/gpt-6-sol" })).toEqual({
      status: "conflict",
    });
    fx.gate.release();
    expect(await waitForTerminal(fx)).toBe("failed");
  });
});

describe("モデルごとの思考レベル（effort）", () => {
  // vitest.config.ts の AGENT_MODELS: sonnet（既定）・haiku・gpt-6-sol。EFFORTS の初期値は sonnet=high / haiku=low / sol=medium

  it("モデルの思考レベルを、Pi のモデル呼び出し（options.reasoning）に毎回渡す。指定が無ければ既定のモデル（sonnet=high）", async () => {
    const cases: [string | undefined, string][] = [
      [undefined, "high"],
      ["anthropic/claude-sonnet-5-5", "high"],
      ["anthropic/claude-haiku-5-5", "low"],
      ["openai/gpt-6-sol", "medium"],
    ];
    for (const [i, [model, level]] of cases.entries()) {
      const fx = newFixture(`effort-${i}`, [report()]);
      await fx.stub.start(makeSpec(`effort-${i}`, model ? { model } : {}));
      expect(await waitForTerminal(fx), model).toBe("completed");
      expect(fx.modelCalls.reasoning.length, model).toBeGreaterThan(0);
      expect(new Set(fx.modelCalls.reasoning), model).toEqual(new Set([level]));
    }
  });

  it("D10b: Workers AI のモデルでもタスクが動き（scripted の経路）、思考レベルが渡る（gpt-oss-120b=low、gemma=high）。AGENT_MODELS の外は拒否", async () => {
    const cases: [string, string][] = [
      ["workers-ai/@cf/openai/gpt-oss-120b", "low"],
      ["workers-ai/@cf/google/gemma-4-26b-a4b-it", "high"],
    ];
    for (const [i, [model, level]] of cases.entries()) {
      const fx = newFixture(`wai-${i}`, [report()]);
      expect(await fx.stub.start(makeSpec(`wai-${i}`, { model })), model).toMatchObject({
        status: "accepted",
      });
      expect(await waitForTerminal(fx), model).toBe("completed");
      expect(new Set(fx.modelCalls.reasoning), model).toEqual(new Set([level]));
    }
    // 許可リストにはあるが、このデプロイの AGENT_MODELS に無い Workers AI のモデルは拒否する
    const fx = newFixture("wai-out", [report()]);
    expect(
      await fx.stub.start(makeSpec("wai-out", { model: "workers-ai/@cf/qwen/qwen3.8-27b" })),
    ).toMatchObject({ status: "rejected" });
  });

  it("MODEL_EFFORTS の上書きが効く。off ならモデル呼び出しに reasoning を渡さない", async () => {
    const fx = newFixture("effort-override", [report()], {
      modelEfforts: "anthropic/claude-sonnet-5-5=medium",
    });
    await fx.stub.start(makeSpec("effort-override"));
    expect(await waitForTerminal(fx)).toBe("completed");
    expect(new Set(fx.modelCalls.reasoning)).toEqual(new Set(["medium"]));

    const off = newFixture("effort-off", [report()], {
      modelEfforts: "anthropic/claude-sonnet-5-5=off",
    });
    await off.stub.start(makeSpec("effort-off"));
    expect(await waitForTerminal(off)).toBe("completed");
    expect(new Set(off.modelCalls.reasoning)).toEqual(new Set([undefined]));
  });

  it("モデルが受け付けない値の上書きは無視して初期値のまま（起動は失敗しない）", async () => {
    const fx = newFixture("effort-bad", [report()], {
      modelEfforts: "anthropic/claude-haiku-5-5=turbo,garbage",
    });
    await fx.stub.start(makeSpec("effort-bad", { model: "anthropic/claude-haiku-5-5" }));
    expect(await waitForTerminal(fx)).toBe("completed");
    expect(new Set(fx.modelCalls.reasoning)).toEqual(new Set(["low"]));
  });

  it("思考を含めても、モデルに渡す出力の上限は DEFAULT / 上書きした maxOutputTokens を超えない", async () => {
    const fx = newFixture("effort-max", [report()], {
      maxOutputTokens: 777,
      modelEfforts: "anthropic/claude-sonnet-5-5=max",
    });
    await fx.stub.start(makeSpec("effort-max"));
    expect(await waitForTerminal(fx)).toBe("completed");
    expect(new Set(fx.modelCalls.reasoning)).toEqual(new Set(["max"]));
    expect(Math.max(...fx.modelCalls.maxTokens.map((n) => n ?? 0))).toBe(777);
  });
});

describe("モデルの 4xx と 5xx の区別（タスク）", () => {
  it("モデルが 4xx（リクエストの中身の問題）で失敗したら、終端の reason は model_rejected（待っても直らない）", async () => {
    const fx = newFixture("rej-4xx", [{ error: "invalid_request_error", status: 400 }]);
    await fx.stub.start(makeSpec("rej-4xx"));
    expect(await waitForTerminal(fx)).toBe("failed");
    expect(done(await fx.stub.getResult()).reason).toMatch(/^model_rejected/);
  });

  it("5xx・status なしは今までどおり model_error", async () => {
    for (const [i, status] of [503, undefined].entries()) {
      const fx = newFixture(`rej-5xx-${i}`, [
        { error: "upstream", ...(status !== undefined ? { status } : {}) },
      ]);
      await fx.stub.start(makeSpec(`rej-5xx-${i}`));
      expect(await waitForTerminal(fx)).toBe("failed");
      expect(done(await fx.stub.getResult()).reason).toMatch(/^model_error/);
    }
  });
});

describe("cancel", () => {
  it("start より先に cancel が届くと、start は cancelled を返して何も始めない", async () => {
    const fx = newFixture("cancel-first", [report()]);
    expect(await fx.stub.cancel()).toMatchObject({ stopped: true });
    expect(await fx.stub.start(makeSpec("cancel-first"))).toEqual({ status: "cancelled" });
    expect(fx.sandbox.readySpecs).toHaveLength(0);
    expect(fx.modelCalls.count).toBe(0);
  });

  it("停止が確かめられなければ stopped:false を返し、再送で true になる", async () => {
    const fx = newFixture("cancel-retry", [call("gate")], { cancelWaitMs: 200 });
    fx.sandbox.terminateResults.push(false);
    await fx.stub.start(makeSpec("cancel-retry"));
    await fx.gate.waitEntered();
    expect(await fx.stub.cancel()).toEqual({ stopped: false });
    fx.gate.release();
    expect(await fx.stub.cancel()).toMatchObject({ stopped: true });
    expect(fx.sandbox.terminateCount).toBeGreaterThanOrEqual(2);
    expect(fx.sandbox.stopCount).toBe(0);
    await waitForPhase(fx, "cancelled");
    const r = done(await fx.stub.getResult());
    expect(r.status).toBe("cancelled");
  });
});

describe("終端停止は terminate を使う", () => {
  it("cancel は terminate を呼び、stop は呼ばない", async () => {
    const fx = newFixture("term-cancel", [call("gate")], { cancelWaitMs: 300 });
    await fx.stub.start(makeSpec("term-cancel"));
    await fx.gate.waitEntered();
    // gate が走っている間は Pi の abort が idle を待つので stopped は false のまま。terminate は呼ばれる
    await fx.stub.cancel();
    expect(fx.sandbox.terminateCount).toBeGreaterThanOrEqual(1);
    expect(fx.sandbox.stopCount).toBe(0);
    fx.gate.release();
    await waitUntil(() => fx.sandbox.terminateCount >= 2); // run が終わった後の片付けも terminate
  });

  it("start より先の cancel（何も始まっていない）でも terminate する", async () => {
    const fx = newFixture("term-cancel-first", []);
    expect(await fx.stub.cancel()).toMatchObject({ stopped: true });
    expect(fx.sandbox.terminateCount).toBe(1);
    expect(fx.sandbox.stopCount).toBe(0);
  });

  it("完了後の片付けも terminate（終端後に sandbox を再開させない）", async () => {
    const fx = newFixture("term-done", [report()]);
    await fx.stub.start(makeSpec("term-done"));
    expect(await waitForTerminal(fx)).toBe("completed");
    await waitUntil(() => fx.sandbox.terminateCount >= 1);
    expect(fx.sandbox.stopCount).toBe(0);
  });

  it("失敗（検証の上限）と予算超過でも terminate する", async () => {
    const failing = newFixture("term-failed", [report(), report(), report(), report()]);
    failing.verifyResults.push(...Array.from({ length: 4 }, () => ({ exitCode: 1, stderr: "ng" })));
    await failing.stub.start(makeSpec("term-failed"));
    expect(await waitForTerminal(failing)).toBe("failed");
    await waitUntil(() => failing.sandbox.terminateCount >= 1);
    expect(failing.sandbox.stopCount).toBe(0);

    const budget = newFixture("term-budget", [report()], { maxOutputTokens: 1_000_000 });
    await budget.stub.start(makeSpec("term-budget", { budgetUsd: 0.5 }));
    expect(await waitForTerminal(budget)).toBe("budget_exceeded");
    await waitUntil(() => budget.sandbox.terminateCount >= 1);
    expect(budget.sandbox.stopCount).toBe(0);
  });

  it("terminate を持たない SandboxPort には stop にフォールバックする", async () => {
    const fx = newFixture("term-fallback", [call("gate")], { cancelWaitMs: 300 });
    Object.defineProperty(fx.sandbox, "terminate", { value: undefined });
    await fx.stub.start(makeSpec("term-fallback"));
    await fx.gate.waitEntered();
    await fx.stub.cancel();
    expect(fx.sandbox.stopCount).toBeGreaterThanOrEqual(1);
    expect(fx.sandbox.terminateCount).toBe(0);
    fx.gate.release();
    await waitUntil(() => fx.sandbox.stopCount >= 2);
  });

  it("terminate が例外なら stopped:false として扱い、再送で確かめ直せる", async () => {
    const fx = newFixture("term-throw", [call("gate")], { cancelWaitMs: 500 });
    let first = true;
    fx.sandbox.terminate = async () => {
      if (first) {
        first = false;
        throw new Error("boom");
      }
      return { stopped: true };
    };
    await fx.stub.start(makeSpec("term-throw"));
    await fx.gate.waitEntered();
    expect(await fx.stub.cancel()).toEqual({ stopped: false });
    fx.gate.release();
    expect(await fx.stub.cancel()).toMatchObject({ stopped: true });
  });
});

describe("イベントとページング", () => {
  it("seq は単調増加で、getEvents は hasMore / throughSeq / phaseAsOfSeq を返す", async () => {
    const fx = newFixture("events-1", [
      { ...call("write_note", { text: "x" }), usage: { input: 10 } },
      report(),
    ]);
    await fx.stub.start(makeSpec("events-1"));
    expect(await waitForTerminal(fx)).toBe("completed");
    const events = await allEvents(fx);
    const seqs = events.map((e) => e.seq);
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
    expect(new Set(seqs).size).toBe(seqs.length);
    const types = events.map((e) => e.type);
    expect(types).toContain("tool_start");
    expect(types).toContain("tool_end");
    expect(types).toContain("completion_report");
    expect(types).toContain("usage");
    // 終端の phase イベントが最後で、phaseAsOfSeq がそれを指す
    const last = events[events.length - 1];
    expect(last).toMatchObject({ type: "phase", data: { phase: "completed" } });
    const page = await fx.stub.getEvents(0, 2);
    expect(page.events).toHaveLength(2);
    expect(page.hasMore).toBe(true);
    expect(page.throughSeq).toBe(page.events[1]?.seq);
    expect(page.phase).toBe("completed");
    expect(page.phaseAsOfSeq).toBe(last?.seq);
    const tail = await fx.stub.getEvents(last?.seq ?? 0, 10);
    expect(tail).toMatchObject({ events: [], hasMore: false, throughSeq: last?.seq });
    // phase の遷移順
    const phases = events.filter((e) => e.type === "phase").map((e) => e.data.phase);
    expect(phases).toEqual(["starting", "running", "verifying", "completed"]);
  });
});

describe("完了判定", () => {
  it("report_completion → 検証成功で completed。patch と検証結果が保存される", async () => {
    const fx = newFixture("verify-ok", [call("write_note", { text: "x" }), report("実装した")]);
    await fx.stub.start(makeSpec("verify-ok"));
    expect(await waitForTerminal(fx)).toBe("completed");
    const r = done(await fx.stub.getResult());
    expect(r.status).toBe("completed");
    expect(r.summary).toBe("実装した");
    expect(r.verification.verified).toBe(true);
    expect(r.verification.attempts).toBe(1);
    expect(r.verification.commitSha).toBe("c0ffee");
    expect(r.patch).toBe(fx.patch.value);
    expect(r.patchTooLarge).toBe(false);
    expect(fx.verifyCalls).toEqual([["npm", "test"]]);
    // format-patch は base..HEAD
    expect(
      fx.sandbox.calls.some(
        (c) => c.argv.join(" ") === "git format-patch base000..c0ffee --stdout",
      ),
    ).toBe(true);
  });

  it("検証失敗 → 結果をモデルへ返して修正 → 成功", async () => {
    const fx = newFixture("verify-fix", [
      report("1回目"),
      call("write_note", { text: "fix" }),
      report("2回目"),
    ]);
    fx.verifyResults.push({ exitCode: 1, stdout: "FAIL: 1 test failed" });
    await fx.stub.start(makeSpec("verify-fix"));
    expect(await waitForTerminal(fx)).toBe("completed");
    const r = done(await fx.stub.getResult());
    expect(r.verification.attempts).toBe(2);
    expect(r.summary).toBe("2回目");
    const phases = (await allEvents(fx)).filter((e) => e.type === "phase").map((e) => e.data.phase);
    expect(phases).toEqual([
      "starting",
      "running",
      "verifying",
      "running",
      "verifying",
      "completed",
    ]);
  });

  it("4回（最初 + 修正3回）失敗すると failed", async () => {
    const fx = newFixture("verify-fail", [report("1"), report("2"), report("3"), report("4")]);
    for (let i = 0; i < 4; i++) fx.verifyResults.push({ exitCode: 1, stdout: `fail ${i}` });
    await fx.stub.start(makeSpec("verify-fail"));
    expect(await waitForTerminal(fx)).toBe("failed");
    const r = done(await fx.stub.getResult());
    expect(r.status).toBe("failed");
    expect(r.reason).toBe("verification_failed");
    expect(r.verification.attempts).toBe(4);
    expect(r.verification.verified).toBe(false);
    expect(r.verification.results[0]?.exitCode).toBe(1);
    expect(r.patch).toBe(fx.patch.value);
  });

  it("verification_commands が無ければ申告だけで completed（未検証）", async () => {
    const fx = newFixture("verify-none", [report("申告")]);
    await fx.stub.start(makeSpec("verify-none", { verificationCommands: [] }));
    expect(await waitForTerminal(fx)).toBe("completed");
    const r = done(await fx.stub.getResult());
    expect(r.verification.verified).toBe(false);
    expect(r.warnings.join("\n")).toContain("未検証");
    expect(fx.verifyCalls).toHaveLength(0);
  });

  it("テスト関連ファイルの削除は warnings に記される", async () => {
    const fx = newFixture("verify-warn", [report()]);
    fx.nameStatus.value = "D\ttest/a.test.ts\nM\tsrc/a.ts";
    await fx.stub.start(makeSpec("verify-warn"));
    expect(await waitForTerminal(fx)).toBe("completed");
    const r = done(await fx.stub.getResult());
    expect(r.warnings.join("\n")).toContain("test/a.test.ts");
  });

  it("未 commit の変更があれば検証せずモデルに commit を促す", async () => {
    const fx = newFixture("verify-dirty", [report("1"), report("2")]);
    let n = 0;
    const orig = fx.sandbox.exec.bind(fx.sandbox);
    fx.sandbox.exec = async (argv, options) => {
      if (argv[0] === "git" && argv[1] === "status" && n++ === 0) {
        fx.sandbox.calls.push({ argv, options: options ?? {} });
        return {
          exitCode: 0,
          stdout: " M a.txt\n",
          stderr: "",
          timedOut: false,
          truncated: false,
        };
      }
      return orig(argv, options);
    };
    await fx.stub.start(makeSpec("verify-dirty"));
    expect(await waitForTerminal(fx)).toBe("completed");
    expect(done(await fx.stub.getResult()).verification.attempts).toBe(1);
  });
});

describe("patch の保存", () => {
  it("1MiB を超えると diffstat だけを保存する", async () => {
    const fx = newFixture("patch-big", [report()]);
    fx.sandbox.exec = new Proxy(fx.sandbox.exec.bind(fx.sandbox), {
      apply(target, _this, [argv, options]: [string[], never]) {
        if (argv[1] === "format-patch") {
          fx.sandbox.calls.push({ argv, options });
          return Promise.resolve({
            exitCode: 0,
            stdout: "x".repeat(1024 * 1024),
            stderr: "",
            timedOut: false,
            truncated: true,
          });
        }
        return Reflect.apply(target, fx.sandbox, [argv, options]);
      },
    });
    await fx.stub.start(makeSpec("patch-big"));
    expect(await waitForTerminal(fx)).toBe("completed");
    const r = done(await fx.stub.getResult());
    expect(r.patchTooLarge).toBe(true);
    expect(r.patch).toBeUndefined();
    expect(r.diffstat).toContain("a.txt");
  });

  it("大きめの patch（分割保存が必要）も欠けずに取り出せる", async () => {
    const fx = newFixture("patch-chunks", [report()]);
    fx.patch.value = `${"line of patch\n".repeat(30_000)}END\n`; // 約 420KB
    await fx.stub.start(makeSpec("patch-chunks"));
    expect(await waitForTerminal(fx)).toBe("completed");
    expect(done(await fx.stub.getResult()).patch).toBe(fx.patch.value);
  });
});

describe("getResult", () => {
  it("終端でなければ not_ready", async () => {
    const fx = newFixture("not-ready", [call("gate"), report()]);
    await fx.stub.start(makeSpec("not-ready"));
    await fx.gate.waitEntered();
    expect(await fx.stub.getResult()).toEqual({ status: "not_ready" });
    fx.gate.release();
    await waitForTerminal(fx);
  });
});

describe("予算", () => {
  it("次の呼び出しの見積もりが残予算を超えるなら、モデルを呼ばずに budget_exceeded", async () => {
    const fx = newFixture("budget-first", [report()], { maxOutputTokens: 1_000_000 });
    // 見積もり: 出力上限 1M トークン × $1/M = $1 > 予算 $0.5
    await fx.stub.start(makeSpec("budget-first", { budgetUsd: 0.5 }));
    expect(await waitForTerminal(fx)).toBe("budget_exceeded");
    expect(fx.modelCalls.count).toBe(0);
    expect(done(await fx.stub.getResult()).status).toBe("budget_exceeded");
  });

  it("実費（usage）を積み上げ、残予算で次の呼び出しを払えなくなったら止まる", async () => {
    const fx = newFixture(
      "budget-second",
      [{ ...call("write_note", { text: "x" }), usage: { input: 900_000 } }, report()],
      { maxOutputTokens: 200_000 },
    );
    // 1 回目: 見積もり約 $0.2 <= $1.0 で実行、実費 $0.9。2 回目: 0.9 + 0.2 > 1.0 で停止
    await fx.stub.start(makeSpec("budget-second", { budgetUsd: 1.0 }));
    expect(await waitForTerminal(fx)).toBe("budget_exceeded");
    expect(fx.modelCalls.count).toBe(1);
    const r = done(await fx.stub.getResult());
    expect(r.usage.costUsd).toBeCloseTo(0.9, 6);
    expect(r.usage.inputTokens).toBe(900_000);
    // usage はイベントにも載る
    const usageEvents = (await allEvents(fx)).filter((e) => e.type === "usage");
    expect(usageEvents.length).toBeGreaterThan(0);
    const lastUsage = usageEvents[usageEvents.length - 1]?.data as unknown as UsageDto;
    expect(lastUsage.costUsd).toBeCloseTo(0.9, 6);
  });
});

describe("usage が返らない成功の呼び出し（少なく数えない）", () => {
  it("成功なのに usage が 0 のターンは、その呼び出しの見積額（上限側）を費用に積む。usage があるターンは実費のまま", async () => {
    const fx = newFixture("usage-missing", [call("write_note", { text: "x" }), report()], {
      maxOutputTokens: 200_000,
    });
    // 単価は $1/100万トークン。1 回の見積もりは出力上限 200,000 分だけで $0.2 以上
    await fx.stub.start(makeSpec("usage-missing", { budgetUsd: 10 }));
    expect(await waitForTerminal(fx)).toBe("completed");
    expect(fx.modelCalls.count).toBe(2);
    const r = done(await fx.stub.getResult());
    expect(r.usage.costUsd).toBeGreaterThanOrEqual(0.4);
    expect(r.usage.costUsd).toBeLessThan(1);
  });

  it("積んだ見積額で予算の判定が働く（usage が返らないモデルでも予算を超えて走り続けない）", async () => {
    const fx = newFixture(
      "usage-missing-budget",
      [call("write_note", { text: "a" }), call("write_note", { text: "b" }), report()],
      { maxOutputTokens: 200_000 },
    );
    // 1 回 $0.2 以上。予算 $0.5 では 3 回目の前に 0.4 + 0.2 > 0.5 で止まる
    await fx.stub.start(makeSpec("usage-missing-budget", { budgetUsd: 0.5 }));
    expect(await waitForTerminal(fx)).toBe("budget_exceeded");
    expect(fx.modelCalls.count).toBe(2);
  });
});

describe("期限", () => {
  it("期限を過ぎたら次のモデル呼び出しの前に failed（理由 deadline）", async () => {
    const fx = newFixture("deadline-1", [call("advance_clock", { ms: 5000 }), report()]);
    await fx.stub.start(makeSpec("deadline-1", { deadlineAt: T0 + 1000 }));
    expect(await waitForTerminal(fx)).toBe("failed");
    const r = done(await fx.stub.getResult());
    expect(r.reason).toBe("deadline");
    expect(fx.modelCalls.count).toBe(1);
  });

  it("期限の job（alarm）が発火すると、処理中でも failed（理由 deadline）にする", async () => {
    const fx = newFixture("deadline-job", [call("gate"), report()]);
    await fx.stub.start(makeSpec("deadline-job", { deadlineAt: T0 + 1000 }));
    await fx.gate.waitEntered();
    fx.clock.now = T0 + 5000;
    await runInDurableObject(fx.stub, (inst: { onJob(c: unknown): Promise<unknown> }) =>
      inst.onJob({ job: { fn: "deadline" }, attempt: 1 }),
    );
    // Sandbox の破棄は直ちに始まる。公開する終端は、モデル（ツール）の停止を待ってから確定する
    await waitUntil(() => fx.sandbox.terminateCount >= 1);
    expect((await fx.stub.getEvents(0, 1)).phase).toBe("running");
    fx.gate.release();
    expect(await waitForTerminal(fx)).toBe("failed");
    expect(done(await fx.stub.getResult()).reason).toBe("deadline");
    expect(fx.sandbox.stopCount).toBe(0);
  });

  it("開始から 2 時間を超える deadlineAt は 2 時間に丸める", async () => {
    const fx = newFixture("deadline-clamp", [call("gate")]);
    await fx.stub.start(makeSpec("deadline-clamp", { deadlineAt: T0 + 10 * 60 * 60 * 1000 }));
    const deadline = await runInDurableObject(fx.stub, (inst: { debugDeadlineAt(): number }) =>
      inst.debugDeadlineAt(),
    );
    expect(deadline).toBe(T0 + 2 * 60 * 60 * 1000);
    fx.gate.release();
    // 後始末: run を最後まで進めて終端にする（走らせたまま overrides を消すと、本物の SandboxDO を呼んでしまう）
    expect(await waitForTerminal(fx)).toBe("failed");
  });
});

describe("再起動（evict）", () => {
  it("phase・期限・usage を引き継ぎ、台本の続きから進む", async () => {
    const fx = newFixture("evict-1", [
      { ...call("write_note", { text: "a" }), usage: { input: 100_000 } },
      call("gate"),
      report("再開後に完了"),
    ]);
    await fx.stub.start(makeSpec("evict-1"));
    await fx.gate.waitEntered();
    const before = await fx.stub.getEvents(0, 100);
    expect(before.phase).toBe("running");
    expect(before.usage.inputTokens).toBe(100_000);
    const deadlineBefore = await runInDurableObject(fx.stub, (i: { debugDeadlineAt(): number }) =>
      i.debugDeadlineAt(),
    );

    // 処理中（ツール実行中）に DO を強制的に落とす。evict は処理の完了を待ってしまうので abort を使う
    await abortAllDurableObjects();
    fx.stub = env.AGENT_DO.getByName(fx.name);
    fx.gate.release();

    // 再起動後に phase / 期限 / usage が残っている
    const after = await fx.stub.getEvents(0, 100);
    expect(after.usage.inputTokens).toBe(100_000);
    expect(after.events.slice(0, before.events.length)).toEqual(before.events);
    const deadlineAfter = await runInDurableObject(fx.stub, (i: { debugDeadlineAt(): number }) =>
      i.debugDeadlineAt(),
    );
    expect(deadlineAfter).toBe(deadlineBefore);

    expect(await waitForTerminal(fx)).toBe("completed");
    const r = done(await fx.stub.getResult());
    expect(r.summary).toBe("再開後に完了");
    expect(r.usage.inputTokens).toBe(100_000);
    // ensureReady は再起動でやり直さない
    expect(fx.sandbox.readySpecs).toHaveLength(1);
  });
});

describe("cancel の契約: stopped:true なら最終 usage を含む全イベントが永続化済み", () => {
  it("モデル呼び出しの途中で cancel しても、abort 後に増えた usage がイベントに入り、finalSeq の後にイベントは無い", async () => {
    const fx = newFixture("cancel-usage", [
      { ...call("write_note", { text: "x" }), usage: { input: 100_000 } },
      { text: "遅い応答", usage: { input: 500_000 }, delayMs: 1500 },
    ]);
    await fx.stub.start(makeSpec("cancel-usage"));
    await waitUntil(() => fx.modelCalls.count === 2);
    await new Promise((r) => setTimeout(r, 400)); // 2 回目の呼び出しが進行中
    const res = await fx.stub.cancel();
    expect(res.stopped).toBe(true);
    expect(res.finalSeq).toBeGreaterThan(0);
    // 最終 usage（abort の後に確定した分）が、終端より前のイベントとして入っている
    const events = await allEvents(fx);
    const last = events[events.length - 1];
    expect(last).toMatchObject({ seq: res.finalSeq, type: "phase", data: { phase: "cancelled" } });
    const usageEvents = events.filter((e) => e.type === "usage");
    const finalUsage = usageEvents[usageEvents.length - 1]?.data as unknown as UsageDto;
    expect(finalUsage.inputTokens).toBe(600_000);
    expect(done(await fx.stub.getResult()).usage.inputTokens).toBe(600_000);
    // stopped:true の後はイベントが増えない
    await new Promise((r) => setTimeout(r, 1000));
    const page = await fx.stub.getEvents(res.finalSeq ?? 0, 100);
    expect(page.events).toEqual([]);
  });

  it("終端（completed）の後の cancel も stopped:true と finalSeq を返す", async () => {
    const fx = newFixture("cancel-after-done", [report()]);
    await fx.stub.start(makeSpec("cancel-after-done"));
    expect(await waitForTerminal(fx)).toBe("completed");
    const events = await allEvents(fx);
    const res = await fx.stub.cancel();
    expect(res).toEqual({ stopped: true, finalSeq: events[events.length - 1]?.seq });
    expect((await allEvents(fx)).length).toBe(events.length);
  });

  it("start より先の cancel は finalSeq 0", async () => {
    const fx = newFixture("cancel-first-seq", []);
    expect(await fx.stub.cancel()).toEqual({ stopped: true, finalSeq: 0 });
  });

  it("モデルがまだ止まっていなければ stopped:false（finalSeq なし）", async () => {
    const fx = newFixture("cancel-notyet", [call("gate")], { cancelWaitMs: 200 });
    await fx.stub.start(makeSpec("cancel-notyet"));
    await fx.gate.waitEntered();
    expect(await fx.stub.cancel()).toEqual({ stopped: false });
    fx.gate.release();
    const again = await fx.stub.cancel();
    expect(again.stopped).toBe(true);
    expect(again.finalSeq).toBeGreaterThan(0);
  });
});

describe("終端の確定順序: cancel > deadline > budget_exceeded > failed > completed", () => {
  const fireDeadline = (fx: { stub: unknown }) =>
    (runInDurableObject as unknown as (s: unknown, f: (i: unknown) => unknown) => Promise<unknown>)(
      fx.stub,
      (inst: unknown) =>
        (inst as { onJob(c: unknown): Promise<unknown> }).onJob({
          job: { fn: "deadline" },
          attempt: 1,
        }),
    );

  it("completed の finalize（patch 取得の await）中に deadline が来たら failed（deadline）", async () => {
    const fx = newFixture("prio-completed-deadline", [report()]);
    fx.patchGate.hold();
    await fx.stub.start(makeSpec("prio-completed-deadline", { deadlineAt: T0 + 1000 }));
    await fx.patchGate.waitEntered();
    fx.clock.now = T0 + 5000;
    await fireDeadline(fx);
    fx.patchGate.release();
    expect(await waitForTerminal(fx)).toBe("failed");
    const r = done(await fx.stub.getResult());
    expect(r.reason).toBe("deadline");
    // 破棄済みの Sandbox から取った patch は残さない
    expect(r.patch).toBeUndefined();
    expect(fx.sandbox.terminateCount).toBeGreaterThanOrEqual(1);
  });

  it("deadline の後に cancel が来たら cancelled が勝つ", async () => {
    const fx = newFixture("prio-cancel-deadline", [call("gate")], { cancelWaitMs: 200 });
    await fx.stub.start(makeSpec("prio-cancel-deadline", { deadlineAt: T0 + 1000 }));
    await fx.gate.waitEntered();
    fx.clock.now = T0 + 5000;
    await fireDeadline(fx);
    await fx.stub.cancel();
    fx.gate.release();
    expect(await waitForTerminal(fx)).toBe("cancelled");
  });

  it("停止の意図があるとき、report_completion は受け付けない", async () => {
    const fx = newFixture("prio-no-report", [call("gate"), report()], { cancelWaitMs: 200 });
    await fx.stub.start(makeSpec("prio-no-report", { deadlineAt: T0 + 1000 }));
    await fx.gate.waitEntered();
    fx.clock.now = T0 + 5000;
    await fireDeadline(fx);
    fx.gate.release();
    expect(await waitForTerminal(fx)).toBe("failed");
    expect(done(await fx.stub.getResult()).reason).toBe("deadline");
    expect(fx.verifyCalls).toHaveLength(0);
  });
});

describe("予算: UTF-8 バイト数でのハードキャップ", () => {
  it("CJK の長文は文字数/3 の見積もりなら通るが、バイト数の見積もりでは呼ばない", async () => {
    const fx = newFixture("budget-cjk", [report()]);
    // 15 万文字 = 45 万バイト ≈ 最大 $0.45（$1/M）。文字数/3 なら $0.05
    await fx.stub.start(
      makeSpec("budget-cjk", { budgetUsd: 0.4, instructions: "漢".repeat(150_000) }),
    );
    expect(await waitForTerminal(fx)).toBe("budget_exceeded");
    expect(fx.modelCalls.count).toBe(0);
  });
});

describe("検証の固定", () => {
  it("保存済みの試行回数が上限に達していたら、実行せずに failed", async () => {
    const fx = newFixture("verify-cap", [call("gate"), report()]);
    await fx.stub.start(makeSpec("verify-cap"));
    await fx.gate.waitEntered();
    await runInDurableObject(fx.stub, (inst: unknown) =>
      (inst as { store: { setMeta(k: string, v: unknown): void } }).store.setMeta("verification", {
        commands: [{ argv: ["npm", "test"] }],
        results: [],
        verified: false,
        attempts: 4,
      }),
    );
    fx.gate.release();
    expect(await waitForTerminal(fx)).toBe("failed");
    const r = done(await fx.stub.getResult());
    expect(r.reason).toBe("verification_failed");
    expect(fx.verifyCalls).toHaveLength(0);
  });

  it("固定した SHA を checkout して検証し、patch は base..検証済み SHA、検証後はブランチを SHA に戻す", async () => {
    const fx = newFixture("verify-pin", [report()]);
    await fx.stub.start(makeSpec("verify-pin"));
    expect(await waitForTerminal(fx)).toBe("completed");
    const cmds = fx.sandbox.calls.map((c) => c.argv.join(" "));
    const co = cmds.indexOf("git checkout -q --detach c0ffee");
    const test = cmds.indexOf("npm test");
    const back = cmds.indexOf("git switch -q -C agent/task-verify-pin c0ffee");
    expect(co).toBeGreaterThanOrEqual(0);
    expect(test).toBeGreaterThan(co);
    expect(back).toBeGreaterThan(test);
    expect(cmds).toContain("git format-patch base000..c0ffee --stdout");
    expect(cmds.some((c) => c.endsWith("HEAD --stdout"))).toBe(false);
  });

  it("検証の後に HEAD が動いていたら、検証は無効（失敗扱い）で、モデルに伝える", async () => {
    const fx = newFixture("verify-head-moved", [report("1"), report("2")]);
    // 1 回目: 検証前の HEAD 確認 c0ffee、検証後は別の SHA。2 回目以降は c0ffee
    fx.revParse.push("c0ffee", "c0ffee", "deadbeef");
    await fx.stub.start(makeSpec("verify-head-moved"));
    expect(await waitForTerminal(fx)).toBe("completed");
    const r = done(await fx.stub.getResult());
    expect(r.verification.attempts).toBe(2);
  });

  it("git status が失敗（終了コード≠0）したら clean 扱いせず、検証しない", async () => {
    const fx = newFixture("verify-status-fail", [report("1"), report("2")]);
    fx.statusResults.push({ exitCode: 128, stderr: "fatal: not a git repository" });
    await fx.stub.start(makeSpec("verify-status-fail"));
    expect(await waitForTerminal(fx)).toBe("completed");
    const r = done(await fx.stub.getResult());
    expect(r.verification.attempts).toBe(1); // 1 回目の report は検証に進まず、2 回目だけが検証した
    expect(fx.verifyCalls).toHaveLength(1);
    const reports = (await allEvents(fx)).filter((e) => e.type === "completion_report");
    expect(reports).toHaveLength(2);
  });

  it("git status がタイムアウト・切り詰めでも clean 扱いしない", async () => {
    const fx = newFixture("verify-status-trunc", [report("1"), report("2"), report("3")]);
    fx.statusResults.push({ timedOut: true }, { truncated: true });
    await fx.stub.start(makeSpec("verify-status-trunc"));
    expect(await waitForTerminal(fx)).toBe("completed");
    expect(fx.verifyCalls).toHaveLength(1);
    const reports = (await allEvents(fx)).filter((e) => e.type === "completion_report");
    expect(reports).toHaveLength(3);
  });
});

describe("start の事前検証", () => {
  it("test 環境以外で AI_GATEWAY_ID が空なら ai_gateway_not_configured", async () => {
    const { aiGatewayRejection } = await import("../../src/agent/config");
    expect(aiGatewayRejection({ ENVIRONMENT: "production", AI_GATEWAY_ID: "" })).toBe(
      "ai_gateway_not_configured",
    );
    expect(aiGatewayRejection({ ENVIRONMENT: "production" })).toBe("ai_gateway_not_configured");
    expect(aiGatewayRejection({ ENVIRONMENT: "production", AI_GATEWAY_ID: "gw" })).toBeUndefined();
    expect(aiGatewayRejection({ ENVIRONMENT: "test", AI_GATEWAY_ID: "" })).toBeUndefined();
  });
});

describe("report_completion の sandbox RPC 中に停止が割り込んでも循環待ちにならない", () => {
  /** cancel を再送して、有限時間で stopped:true に収束することを確かめる */
  async function cancelUntilStopped(fx: ReturnType<typeof newFixture>, timeoutMs = 3000) {
    const end = Date.now() + timeoutMs;
    for (;;) {
      const res = await fx.stub.cancel();
      if (res.stopped) return res;
      if (Date.now() > end) throw new Error("cancel が stopped:true に収束しない");
      await new Promise((r) => setTimeout(r, 50));
    }
  }

  it("検証コマンドなし: git status の await 中に cancel → RPC 成功後も cancelled に収束する", async () => {
    const fx = newFixture("cycle-nocmd", [report()], { cancelWaitMs: 300 });
    fx.execGate.status.hold();
    await fx.stub.start(makeSpec("cycle-nocmd", { verificationCommands: [] }));
    await fx.execGate.status.waitEntered();
    expect(await fx.stub.cancel()).toEqual({ stopped: false });
    fx.execGate.status.release();
    const res = await cancelUntilStopped(fx);
    expect(res.finalSeq).toBeGreaterThan(0);
    expect(await waitForTerminal(fx)).toBe("cancelled");
  });

  it("検証コマンドあり: git switch（検証後のブランチ復元）の await 中に cancel → cancelled に収束する", async () => {
    const fx = newFixture("cycle-cmd", [report()], { cancelWaitMs: 300 });
    fx.execGate.switch.hold();
    await fx.stub.start(makeSpec("cycle-cmd"));
    await fx.execGate.switch.waitEntered();
    expect(await fx.stub.cancel()).toEqual({ stopped: false });
    fx.execGate.switch.release();
    await cancelUntilStopped(fx);
    expect(await waitForTerminal(fx)).toBe("cancelled");
  });

  it("検証コマンドあり: git status の await 中に cancel → cancelled に収束する", async () => {
    const fx = newFixture("cycle-cmd-status", [report()], { cancelWaitMs: 300 });
    fx.execGate.status.hold();
    await fx.stub.start(makeSpec("cycle-cmd-status"));
    await fx.execGate.status.waitEntered();
    expect(await fx.stub.cancel()).toEqual({ stopped: false });
    fx.execGate.status.release();
    await cancelUntilStopped(fx);
    expect(await waitForTerminal(fx)).toBe("cancelled");
  });
});

describe("検証中に sandbox が例外を投げたとき", () => {
  it("phase は verifying のまま残らず running に戻り、例外の内容が非信頼データとしてモデルへ返る", async () => {
    const fx = newFixture("verify-throw", [report(), report()]);
    const orig = fx.sandbox.exec.bind(fx.sandbox);
    let thrown = false;
    fx.sandbox.exec = async (argv, options) => {
      if (argv[1] === "status" && !thrown) {
        thrown = true;
        throw new Error("container exploded");
      }
      return orig(argv, options);
    };
    await fx.stub.start(makeSpec("verify-throw"));
    expect(await waitForTerminal(fx)).toBe("completed");
    const phases = (await allEvents(fx)).filter((e) => e.type === "phase").map((e) => e.data.phase);
    // 例外の後に running へ戻り、その後で 2 回目の report_completion が verifying になる
    const first = phases.indexOf("verifying");
    expect(phases.slice(first, first + 3)).toEqual(["verifying", "running", "verifying"]);
    const toolEnds = (await allEvents(fx)).filter((e) => e.type === "tool_end");
    const err = toolEnds.find((e) => e.data.isError === true);
    expect(JSON.stringify(err?.data)).toContain("container exploded");
  });
});

describe("start は Sandbox の準備を待たない", () => {
  it("ensureReady が終わらなくても accepted を返し、その間の cancel でも start は例外にならない", async () => {
    const fx = newFixture("start-async", [report()], { cancelWaitMs: 300 });
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    fx.sandbox.ensureReady = async (spec) => {
      fx.sandbox.readySpecs.push(spec);
      await gate;
    };
    const started = await Promise.race([
      fx.stub.start(makeSpec("start-async")),
      new Promise<string>((r) => setTimeout(() => r("blocked"), 1500)),
    ]);
    expect(started).toMatchObject({ status: "accepted" });
    await waitUntil(() => fx.sandbox.readySpecs.length === 1);
    await fx.stub.cancel();
    release();
    expect(await waitForTerminal(fx)).toBe("cancelled");
    expect(fx.modelCalls.count).toBe(0);
  });
});

describe("停止の確定は Pi の abort を無期限には待たない", () => {
  const pendingAbort = (fx: ReturnType<typeof newFixture>) =>
    runInDO<boolean>(fx.stub, (inst) => inst.aborting !== undefined);

  it("上限を超えたら、呼び出し前の見積額を usage に含めて確定する。cancel は上限内に abort が終わらなければ stopped:false、再送で abort の完了後に true", async () => {
    // 確定の上限 100ms、abort の完了は abort の 150ms 後、cancel の待ちは 120ms
    const fx = newFixture(
      "finalize-cap",
      [{ text: "遅い応答", usage: { input: 500_000 }, delayMs: 4000 }],
      { cancelWaitMs: 120, finalizeWaitMs: 100 },
    );
    await fx.stub.start(makeSpec("finalize-cap"));
    await waitUntil(() => fx.modelCalls.count === 1);
    await new Promise((r) => setTimeout(r, 300)); // 生成の途中経過（usage）が Pi に届くまで
    // 1 回目: abort が終わる前に待ちの上限が来る
    expect(await fx.stub.cancel()).toEqual({ stopped: false });
    expect(await pendingAbort(fx)).toBe(true);
    // モデルの応答（4 秒）を待たずに確定する
    expect(await waitForTerminal(fx, 2000)).toBe("cancelled");
    const r = done(await fx.stub.getResult());
    expect(r.usage.costUsd).toBeGreaterThan(0); // 見積額（上限側）が計上されている
    const events = await allEvents(fx);
    const last = events[events.length - 1];
    expect(last).toMatchObject({ type: "phase", data: { phase: "cancelled" } });
    // 再送で true になった時点では、abort は終わっている
    const end = Date.now() + 3000;
    let again = await fx.stub.cancel();
    while (!again.stopped && Date.now() < end) {
      await new Promise((r) => setTimeout(r, 30));
      again = await fx.stub.cancel();
    }
    expect(again.stopped).toBe(true);
    expect(again.finalSeq).toBe(last?.seq);
    expect(await pendingAbort(fx)).toBe(false);
    // 確定の後に遅れて届く実費でイベントは増えない
    await new Promise((r) => setTimeout(r, 300));
    expect((await allEvents(fx)).length).toBe(events.length);
  });

  it("確定の後に遅れて戻った usage の読み取りは、実費が見積額を超えていてもイベントを積まない", async () => {
    // 見積額（約 $0.004）より実費（$0.5）が大きい。読み取りを止めたまま確定させ、確定の後で解放する
    const fx = newFixture(
      "late-usage",
      [{ text: "遅い応答", usage: { input: 500_000 }, delayMs: 4000 }],
      { cancelWaitMs: 300, finalizeWaitMs: 100, usageReadWaitMs: 100, maxOutputTokens: 1000 },
    );
    await fx.stub.start(makeSpec("late-usage"));
    await waitUntil(() => fx.modelCalls.count === 1);
    await new Promise((r) => setTimeout(r, 300)); // 生成の途中経過（usage）が Pi に届くまで
    fx.usageGate.hold();
    await fx.stub.cancel();
    expect(await waitForTerminal(fx, 3000)).toBe("cancelled");
    await fx.usageGate.waitEntered(); // 確定の中の読み取りが止まっている
    const settled = done(await fx.stub.getResult());
    expect(settled.usage.costUsd).toBeGreaterThan(0);
    expect(settled.usage.costUsd).toBeLessThan(0.1); // 確定した値は見積額
    const events = await allEvents(fx);
    // abort が終わって実費が確定した後で、止めていた読み取りを戻す
    await new Promise((r) => setTimeout(r, 400));
    fx.usageGate.release();
    await new Promise((r) => setTimeout(r, 400));
    expect((await allEvents(fx)).length).toBe(events.length);
    expect(done(await fx.stub.getResult()).usage).toEqual(settled.usage);
  });

  it("モデルの応答が返った後（ツール実行中）に cancel が上限を超えたら、見積額ではなく実費で確定する", async () => {
    // 見積額は約 $1、実費は $0.1。応答は返っていて実費が分かっているので、見積額で上書きしない
    const fx = newFixture(
      "finalize-actual",
      [{ ...call("gate"), usage: { input: 100_000 } }, report()],
      { cancelWaitMs: 300, finalizeWaitMs: 100, maxOutputTokens: 1_000_000 },
    );
    await fx.stub.start(makeSpec("finalize-actual"));
    await fx.gate.waitEntered();
    await fx.stub.cancel();
    expect(await waitForTerminal(fx, 3000)).toBe("cancelled");
    expect(done(await fx.stub.getResult()).usage.costUsd).toBeCloseTo(0.1, 6);
    fx.gate.release();
  });
});

describe("launch の投入中に cancel が確定した場合", () => {
  it("submit が戻った後に launched を書かず、投入した run を abort する", async () => {
    const fx = newFixture("launch-cancel", [report()], { cancelWaitMs: 300 });
    fx.submitGate.hold();
    await fx.stub.start(makeSpec("launch-cancel"));
    await fx.submitGate.waitEntered();
    // ensureReady の後、submit の直前で止まっている
    // 何も投入されていない間に cancel が確定する（started=true なので cancelled で確定する）
    await fx.stub.cancel();
    expect(await waitForTerminal(fx, 3000)).toBe("cancelled");
    let aborts = 0;
    await runInDO(fx.stub, (inst) => {
      const orig = inst.harness.abort.bind(inst.harness);
      inst.harness.abort = (...a: unknown[]) => {
        aborts += 1;
        return orig(...a);
      };
    });
    fx.submitGate.release(); // この後 submit が走る
    await waitUntil(() => aborts >= 1, 2000);
    const launched = await runInDO(fx.stub, (inst) => inst.store.meta("launched"));
    expect(launched).toBeUndefined();
    expect(done(await fx.stub.getResult()).status).toBe("cancelled");
    expect(fx.modelCalls.count).toBe(0);
  });
});

describe("終端の後に検証イベントを積まない", () => {
  it("確定が先に走った後で git switch が戻っても verification イベントは終端の phase より後に出ない", async () => {
    const fx = newFixture("verify-after-terminal", [report()], {
      cancelWaitMs: 200,
      finalizeWaitMs: 100,
    });
    fx.execGate.switch.hold();
    await fx.stub.start(makeSpec("verify-after-terminal"));
    await fx.execGate.switch.waitEntered();
    await fx.stub.cancel();
    expect(await waitForTerminal(fx, 3000)).toBe("cancelled");
    fx.execGate.switch.release();
    await new Promise((r) => setTimeout(r, 300));
    const events = await allEvents(fx);
    const terminalSeq = events.find((e) => e.type === "phase" && e.data.phase === "cancelled")?.seq;
    expect(events.filter((e) => e.type === "verification" && e.seq > (terminalSeq ?? 0))).toEqual(
      [],
    );
    expect(events[events.length - 1]?.type).toBe("phase");
  });
});
