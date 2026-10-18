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
  });

  it("未知のモデルは起動時に拒否し、何も始めない", async () => {
    const fx = newFixture("unknown-model", [], { modelId: "anthropic/claude-nonexistent" });
    const res = await fx.stub.start(makeSpec("unknown-model"));
    expect(res).toMatchObject({ status: "rejected" });
    expect(fx.sandbox.readySpecs).toHaveLength(0);
    expect(fx.modelCalls.count).toBe(0);
  });
});

describe("cancel", () => {
  it("start より先に cancel が届くと、start は cancelled を返して何も始めない", async () => {
    const fx = newFixture("cancel-first", [report()]);
    expect(await fx.stub.cancel()).toEqual({ stopped: true });
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
    expect(await fx.stub.cancel()).toEqual({ stopped: true });
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
    expect(await fx.stub.cancel()).toEqual({ stopped: true });
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
    expect(await fx.stub.cancel()).toEqual({ stopped: true });
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
      fx.sandbox.calls.some((c) => c.argv.join(" ") === "git format-patch base000..HEAD --stdout"),
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
    expect(await waitForTerminal(fx)).toBe("failed");
    expect(done(await fx.stub.getResult()).reason).toBe("deadline");
    await waitUntil(() => fx.sandbox.terminateCount >= 1);
    expect(fx.sandbox.stopCount).toBe(0);
    fx.gate.release();
  });

  it("開始から 2 時間を超える deadlineAt は 2 時間に丸める", async () => {
    const fx = newFixture("deadline-clamp", [call("gate")]);
    await fx.stub.start(makeSpec("deadline-clamp", { deadlineAt: T0 + 10 * 60 * 60 * 1000 }));
    const deadline = await runInDurableObject(fx.stub, (inst: { debugDeadlineAt(): number }) =>
      inst.debugDeadlineAt(),
    );
    expect(deadline).toBe(T0 + 2 * 60 * 60 * 1000);
    fx.gate.release();
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
