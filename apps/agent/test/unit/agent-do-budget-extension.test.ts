import { runInDurableObject } from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";
import { clearAgentTestOverrides } from "../../src/agent/deps";
import {
  allEvents,
  call,
  done,
  type Fixture,
  makeSpec,
  newFixture,
  report,
  waitForPhase,
  waitForTerminal,
} from "./support/agent-fixture";

afterEach(() => clearAgentTestOverrides());

// biome-ignore lint/suspicious/noExplicitAny: private メンバーの観測
type Inst = any;
const runInDO = runInDurableObject as unknown as <T>(
  stub: unknown,
  fn: (inst: Inst) => Promise<T> | T,
) => Promise<T>;
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const HOUR = 60 * 60 * 1000;
const SHA = "d".repeat(40);

/** 1 回のモデル呼び出しで予算（$1）をほぼ使い切る（出力 999,999 トークン = 約 $1）台本の 1 ターン */
const spend = () => ({ ...call("write_note", { text: "x" }), usage: { output: 999_999 } });

const gitCalls = (fx: Fixture, sub: string) =>
  fx.sandbox.calls.filter((c) => c.argv[0] === "git" && c.argv.includes(sub));

async function startAsk(name: string, script: ReturnType<typeof spend>[] | unknown[], over = {}) {
  // biome-ignore lint/suspicious/noExplicitAny: 台本の型
  const fx = newFixture(name, script as any);
  await fx.stub.start(
    makeSpec(name, { budgetUsd: 1.0, budgetPolicy: "ask", verificationCommands: [], ...over }),
  );
  return fx;
}

describe("budget_policy: ask は予算に近づいたら止めずに親へ聞く", () => {
  it("未 commit の変更を WIP として commit・push してから Sandbox を中断し、INPUT_REQUIRED（kind: budget_extension）にする。質問は数値だけの固定文", async () => {
    const fx = newFixture("bx-ask", [spend(), report()]);
    fx.statusResults.push({ stdout: " M src/a.ts\n" });
    fx.revParse.push(SHA, SHA); // WIP の commit 後の HEAD と、中断の前の確認の HEAD（push 済み）
    await fx.stub.start(
      makeSpec("bx-ask", { budgetUsd: 1.0, budgetPolicy: "ask", verificationCommands: [] }),
    );
    await waitForPhase(fx, "input_required");

    // WIP: commit と push が済んでいる
    expect(gitCalls(fx, "commit")).toHaveLength(1);
    expect(gitCalls(fx, "push")).toHaveLength(1);
    // 中断は WIP の後。WIP が push 済みで作業ツリーが clean なので中断する（snapshot は速く戻すためのもの）
    expect(fx.sandbox.suspendCalls).toEqual([{ allowReclone: true }]);
    expect(fx.sandbox.suspended).toBe(true);

    const events = await allEvents(fx);
    const q = events.find((e) => e.type === "question");
    expect(q?.data).toMatchObject({
      question_id: "q-1",
      kind: "budget_extension",
      budget_spent_usd: expect.any(Number),
      budget_total_usd: 1,
      budget_extension_usd: 1,
      budget_extensions_left: 2,
    });
    const options = JSON.parse(String(q?.data.options)) as string[];
    expect(options).toEqual(["あと $1.00 使って続ける", "ここで止める"]);
    // 固定文: 数値だけで、子の自由文は入らない
    expect(String(q?.data.message)).toBe(
      `タスクの予算 $1.00 のうち $${Number(q?.data.budget_spent_usd).toFixed(2)} を使いました。あと $1.00 使って続けますか。延長できる残り回数: 2 回。`,
    );
    // 中断は特権操作として events（audit）に残る
    expect(events.some((e) => e.type === "audit" && e.data.op === "suspend")).toBe(true);
    // 質問のあと、モデルは呼ばれない
    expect(fx.modelCalls.count).toBe(1);
    await sleep(150);
    expect(fx.modelCalls.count).toBe(1);
  });

  it("extend を受け取ると、予算が増えて続き、完了できる。モデルには rovo が書いた固定文が user メッセージとして渡る", async () => {
    const fx = newFixture("bx-extend", [spend(), spend(), report()]);
    fx.revParse.push("1".repeat(40), "1".repeat(40)); // 質問ごとの中断の前の確認（push 済みの HEAD）
    await fx.stub.start(
      makeSpec("bx-extend", { budgetUsd: 1.0, budgetPolicy: "ask", verificationCommands: [] }),
    );
    await waitForPhase(fx, "input_required");
    expect(await fx.stub.answer("q-1", "extend")).toEqual({ ok: true });
    // 2 回目の spend の後（累計 約 $2 = 延長後の予算）で、もう一度聞かれる
    await waitForPhase(fx, "input_required");
    const events = await allEvents(fx);
    expect(events.filter((e) => e.type === "question")).toHaveLength(2);
    const q2 = events.filter((e) => e.type === "question")[1];
    expect(q2?.data).toMatchObject({ kind: "budget_extension", budget_total_usd: 2 });
    expect(q2?.data.budget_extensions_left).toBe(1);
    // 1 回目の延長で Sandbox は戻っている（exec / writeFile で resume）
    expect(fx.sandbox.resumes).toBe(1);
    expect(
      fx.modelCalls.userTexts.at(-1)?.some((t) => t.includes("extended") && t.includes("$1.00")),
    ).toBe(true);
    expect(await fx.stub.answer("q-2", "extend")).toEqual({ ok: true });
    expect(await waitForTerminal(fx)).toBe("completed");
  });

  it("stop を受け取ると budget_exceeded（reason は budget_exceeded）。中断中の Sandbox を WIP のためだけに起こさない", async () => {
    const fx = newFixture("bx-stop", [spend(), report()]);
    fx.statusResults.push({ stdout: " M src/a.ts\n" });
    fx.revParse.push(SHA, SHA);
    await fx.stub.start(
      makeSpec("bx-stop", { budgetUsd: 1.0, budgetPolicy: "ask", verificationCommands: [] }),
    );
    await waitForPhase(fx, "input_required");
    const commitsBefore = gitCalls(fx, "commit").length;
    expect(await fx.stub.answer("q-1", "stop")).toEqual({ ok: true });
    expect(await waitForTerminal(fx)).toBe("budget_exceeded");
    const r = done(await fx.stub.getResult());
    expect(r.reason).toBe("budget_exceeded");
    // WIP は中断の前に済んでいる。止めるときにもう一度 commit しない
    expect(gitCalls(fx, "commit")).toHaveLength(commitsBefore);
    expect(r.warnings.join("\n")).toContain("WIP");
    expect(fx.modelCalls.count).toBe(1);
  });

  it("extend / stop 以外の答えは止める（お金を使う側には倒さない）", async () => {
    const fx = await startAsk("bx-other", [spend(), report()]);
    await waitForPhase(fx, "input_required");
    await fx.stub.answer("q-1", "yes please continue");
    expect(await waitForTerminal(fx)).toBe("budget_exceeded");
    expect(done(await fx.stub.getResult()).reason).toBe("budget_exceeded");
    expect(fx.modelCalls.count).toBe(1);
  });

  it("延長は 1 タスク 2 回まで。3 回目は聞かずに budget_exceeded で止まる", async () => {
    const fx = await startAsk("bx-limit", [spend(), spend(), spend(), report()]);
    const questions = async () => (await allEvents(fx)).filter((e) => e.type === "question").length;
    const waitQuestions = async (n: number) => {
      for (let i = 0; i < 400 && (await questions()) < n; i++) await sleep(25);
    };
    await waitQuestions(1);
    await fx.stub.answer("q-1", "extend");
    await waitQuestions(2);
    await fx.stub.answer("q-2", "extend");
    expect(await waitForTerminal(fx)).toBe("budget_exceeded");
    const events = await allEvents(fx);
    expect(events.filter((e) => e.type === "question")).toHaveLength(2);
    expect(done(await fx.stub.getResult()).reason).toBe("budget_exceeded");
  });

  it("budget_policy が stop、または無い（古い gateway）なら、今までどおり聞かずに止まる", async () => {
    for (const policy of ["stop", undefined] as const) {
      const name = `bx-nopolicy-${policy ?? "none"}`;
      const fx = newFixture(name, [spend(), report()]);
      await fx.stub.start(
        makeSpec(name, {
          budgetUsd: 1.0,
          verificationCommands: [],
          ...(policy !== undefined ? { budgetPolicy: policy } : {}),
        }),
      );
      expect(await waitForTerminal(fx)).toBe("budget_exceeded");
      expect((await allEvents(fx)).filter((e) => e.type === "question")).toHaveLength(0);
      expect(fx.sandbox.suspendCalls).toHaveLength(0);
    }
  });

  it("答えが無いまま回答待ちの上限（24 時間）に達したら budget_exceeded。reason は budget_extension_timeout", async () => {
    const fx = await startAsk("bx-timeout", [spend(), report()]);
    await waitForPhase(fx, "input_required");
    await sleep(100);
    fx.clock.now += 24 * HOUR + 1000;
    await runInDO(fx.stub, (inst) => inst.onJob({ job: { fn: "input_timeout" }, attempt: 1 }));
    expect(await waitForTerminal(fx)).toBe("budget_exceeded");
    expect(done(await fx.stub.getResult()).reason).toBe("budget_extension_timeout");
  });

  it("上限を過ぎた後に届いた extend では再開せず、budget_extension_timeout で止まる", async () => {
    const fx = await startAsk("bx-late", [spend(), report()]);
    await waitForPhase(fx, "input_required");
    fx.clock.now += 24 * HOUR + 1000;
    expect(await fx.stub.answer("q-1", "extend")).toEqual({ ok: true, ignored: true });
    expect(await waitForTerminal(fx)).toBe("budget_exceeded");
    expect(done(await fx.stub.getResult()).reason).toBe("budget_extension_timeout");
    expect(fx.modelCalls.count).toBe(1);
  });

  it("cancel は予算の質問の待ちにも効く（cancelled が優先）", async () => {
    const fx = await startAsk("bx-cancel", [spend(), report()]);
    await waitForPhase(fx, "input_required");
    expect(await fx.stub.cancel()).toMatchObject({ stopped: true });
    expect(await waitForTerminal(fx)).toBe("cancelled");
  });
});

describe("待つ間の Sandbox", () => {
  it("WIP が push まで成功していない（push 失敗）なら中断せず、コンテナを止めずに待つ。質問は出て、結果の warnings に固定文が出る", async () => {
    const fx = newFixture("bx-wip-fail", [spend(), report()]);
    fx.statusResults.push({ stdout: " M src/a.ts\n" }, { stdout: " M src/a.ts\n" });
    fx.pushResults.push({ exitCode: 1, stderr: "remote: denied" });
    fx.revParse.push(SHA, SHA);
    await fx.stub.start(
      makeSpec("bx-wip-fail", { budgetUsd: 1.0, budgetPolicy: "ask", verificationCommands: [] }),
    );
    await waitForPhase(fx, "input_required");
    expect(fx.sandbox.suspendCalls).toHaveLength(0);
    expect(fx.sandbox.suspended).toBe(false);
    await fx.stub.answer("q-1", "stop");
    expect(await waitForTerminal(fx)).toBe("budget_exceeded");
    const r = done(await fx.stub.getResult());
    expect(r.warnings).toContain(
      "途中の作業を push できなかったため、承認を待つ間も Sandbox を止めなかった",
    );
  });

  it("作業ツリーが dirty のまま（WIP が見送られた）でも中断しない", async () => {
    const fx = newFixture("bx-dirty", [spend(), report()]);
    // WIP の status、中断の前の確認の status のどちらも dirty。秘密らしき文字列で WIP は見送り
    fx.statusResults.push({ stdout: " M src/a.ts\n" }, { stdout: " M src/a.ts\n" });
    await fx.stub.start(
      makeSpec("bx-dirty", { budgetUsd: 1.0, budgetPolicy: "ask", verificationCommands: [] }),
    );
    await waitForPhase(fx, "input_required");
    expect(fx.sandbox.suspendCalls).toHaveLength(0);
    expect(fx.sandbox.suspended).toBe(false);
  });

  it("中断したときは、warnings に「止めなかった」の文は出ない", async () => {
    const fx = newFixture("bx-suspend-nowarn", [spend(), report()]);
    fx.revParse.push("1".repeat(40));
    await fx.stub.start(
      makeSpec("bx-suspend-nowarn", {
        budgetUsd: 1.0,
        budgetPolicy: "ask",
        verificationCommands: [],
      }),
    );
    await waitForPhase(fx, "input_required");
    expect(fx.sandbox.suspendCalls).toHaveLength(1);
    await fx.stub.answer("q-1", "stop");
    expect(await waitForTerminal(fx)).toBe("budget_exceeded");
    expect(done(await fx.stub.getResult()).warnings.join("\n")).not.toContain("止めなかった");
  });

  it("作業ツリーが clean で HEAD が push 済みのときだけ中断する。スナップショットに失敗しても止めてよい（allowReclone: true。再 clone しても何も失わない）", async () => {
    const fx = newFixture("bx-reclone", [spend(), report()]);
    fx.revParse.push("1".repeat(40)); // makeSpec の initialSha
    await fx.stub.start(
      makeSpec("bx-reclone", { budgetUsd: 1.0, budgetPolicy: "ask", verificationCommands: [] }),
    );
    await waitForPhase(fx, "input_required");
    expect(fx.sandbox.suspendCalls).toEqual([{ allowReclone: true }]);
  });

  it("suspend が例外・running を返しても質問は出る（コンテナは止めずに待つ。fail-soft）", async () => {
    for (const result of [new Error("boom"), { mode: "running" as const }]) {
      const name = `bx-suspend-fail-${result instanceof Error ? "throw" : "running"}`;
      const fx = newFixture(name, [spend(), report()]);
      fx.sandbox.suspendResult = result;
      fx.revParse.push("1".repeat(40));
      await fx.stub.start(
        makeSpec(name, { budgetUsd: 1.0, budgetPolicy: "ask", verificationCommands: [] }),
      );
      await waitForPhase(fx, "input_required");
      expect(fx.sandbox.suspended).toBe(false);
      expect(fx.sandbox.suspendCalls.length).toBeGreaterThan(0);
    }
  });

  it("Sandbox を一度も使っていないタスクは、中断もしない（起動しない）", async () => {
    // 台本の最初のターンが Sandbox を使わないツール（echo）で、予算を使い切る
    const fx = newFixture("bx-noboot", [
      { ...call("echo", { text: "x" }), usage: { output: 999_999 } },
      report(),
    ]);
    await fx.stub.start(
      makeSpec("bx-noboot", { budgetUsd: 1.0, budgetPolicy: "ask", verificationCommands: [] }),
    );
    await waitForPhase(fx, "input_required");
    expect(fx.sandbox.suspendCalls).toHaveLength(0);
    expect(fx.sandbox.calls).toHaveLength(0);
  });
});
