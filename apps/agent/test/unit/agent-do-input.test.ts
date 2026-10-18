import { abortAllDurableObjects, env, runInDurableObject } from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";
import { clearAgentTestOverrides } from "../../src/agent/deps";
import {
  allEvents,
  ask,
  call,
  done,
  type Fixture,
  makeSpec,
  newFixture,
  report,
  round,
  T0,
  waitForPhase,
  waitForTerminal,
  waitUntil,
} from "./support/agent-fixture";

afterEach(() => clearAgentTestOverrides());

// biome-ignore lint/suspicious/noExplicitAny: private メンバーの観測
type Inst = any;
const runInDO = runInDurableObject as unknown as <T>(
  stub: unknown,
  fn: (inst: Inst) => Promise<T> | T,
) => Promise<T>;

const HOUR = 60 * 60 * 1000;
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** start して、質問で止まる（input_required）まで進める。 */
async function startAndAsk(fx: Fixture, name: string) {
  await fx.stub.start(makeSpec(name));
  await waitForPhase(fx, "input_required");
}

/** Pi に未決の操作が無く、セッションも動いていないこと */
async function piIdle(fx: Fixture): Promise<boolean> {
  return runInDO(fx.stub, async (inst) => {
    const pending = await inst.harness.pending();
    const busy = await inst.harness.session().busy();
    return pending.length === 0 && !busy;
  });
}

async function questionIds(fx: Fixture): Promise<string[]> {
  return (await allEvents(fx))
    .filter((e) => e.type === "question")
    .map((e) => String(e.data.question_id));
}

const typesOf = async (fx: Fixture, type: string) =>
  (await allEvents(fx)).filter((e) => e.type === type);

describe("ask_parent: 質問して止まる", () => {
  it("question イベントと phase input_required を同時に記録し、モデルは再び呼ばれない", async () => {
    const fx = newFixture("ask-1", [ask("どちらにしますか", ["A", "B"]), report()]);
    await startAndAsk(fx, "ask-1");
    const events = await allEvents(fx);
    const q = events.find((e) => e.type === "question");
    expect(q?.data).toEqual({
      question_id: "q-1",
      message: "どちらにしますか",
      options: JSON.stringify(["A", "B"]),
    });
    const phase = events.find((e) => e.type === "phase" && e.data.phase === "input_required");
    expect(phase).toBeDefined();
    // 同じトランザクション: 2 つのイベントの seq は連続する
    expect(Math.abs((phase?.seq ?? 0) - (q?.seq ?? 0))).toBe(1);
    const page = await fx.stub.getEvents(0, 1);
    expect(page.phase).toBe("input_required");
    expect(page.phaseAsOfSeq).toBe(phase?.seq);
    await sleep(300);
    expect(fx.modelCalls.count).toBe(1);
    expect(fx.sandbox.terminateCount).toBe(0);
    expect((await fx.stub.getEvents(0, 1)).phase).toBe("input_required");
  });

  it('options が無ければ "[]"', async () => {
    const fx = newFixture("ask-noopt", [ask("質問"), report()]);
    await startAndAsk(fx, "ask-noopt");
    const q = (await typesOf(fx, "question"))[0];
    expect(q?.data.options).toBe("[]");
  });

  it("質問が出た後に tick や onStart が走っても failed にならず、Sandbox も破棄されない", async () => {
    const fx = newFixture("ask-tick", [ask("質問"), report()]);
    await startAndAsk(fx, "ask-tick");
    await sleep(200);
    await runInDO(fx.stub, async (inst) => {
      await inst.onStart();
      await inst.onJob({ job: { fn: "tick" }, attempt: 1 });
    });
    await sleep(300);
    expect((await fx.stub.getEvents(0, 1)).phase).toBe("input_required");
    expect(fx.sandbox.terminateCount).toBe(0);
    // 再起動（メモリの状態が消える）の後も同じ
    await abortAllDurableObjects();
    fx.stub = env.AGENT_DO.getByName(fx.name);
    expect((await fx.stub.getEvents(0, 1)).phase).toBe("input_required");
    await sleep(300);
    expect((await fx.stub.getEvents(0, 1)).phase).toBe("input_required");
    expect(fx.sandbox.terminateCount).toBe(0);
  });

  it("システムプロンプトに質問してよい条件と上限が書かれる", async () => {
    const fx = newFixture("ask-prompt", [ask("質問"), report()]);
    await fx.stub.start(makeSpec("ask-prompt"));
    const text = await runInDO(fx.stub, (inst) => {
      const sections = inst.promptSections() as { key: string; text?: string }[];
      return sections.find((s) => s.key === "ask_parent")?.text ?? "";
    });
    expect(text).toContain("ask_parent");
    expect(text).toMatch(/contradict/i);
    expect(text).toMatch(/acceptance criteria/i);
    expect(text).toMatch(/destructive/i);
    expect(text).toMatch(/security/i);
    expect(text).toMatch(/trivial/i);
    expect(text).toContain("git_commit");
    expect(text).toContain("4000");
    await waitForPhase(fx, "input_required");
  });

  it("長さの上限: question 4000 文字・options 10 個・各 500 文字。超えたらエラーを返し、質問は記録しない", async () => {
    const fx = newFixture("ask-limit", [
      ask("あ".repeat(4001)),
      ask(
        "q",
        Array.from({ length: 11 }, (_, i) => `o${i}`),
      ),
      ask("q", ["x".repeat(501)]),
      ask(""),
      ask("ok"),
      report(),
    ]);
    await startAndAsk(fx, "ask-limit");
    const ends = (await typesOf(fx, "tool_end")).map((e) => e.data.isError);
    expect(ends).toEqual([true, true, true, true, false]);
    const qs = await typesOf(fx, "question");
    expect(qs).toHaveLength(1);
    expect(qs[0]?.data.message).toBe("ok");
  });

  it("回答待ちの間のフック: onYield は nudge せず、beforeTool は ask_parent 以外を止める", async () => {
    const fx = newFixture("ask-hooks", [ask("質問"), report()]);
    await startAndAsk(fx, "ask-hooks");
    await sleep(200);
    const r = await runInDO(fx.stub, async (inst) => {
      const hooks = inst.piHooks();
      return {
        yield: await hooks.onYield(),
        bash: await hooks.beforeTool({ id: "x", name: "bash", arguments: {} }),
        ask: await hooks.beforeTool({ id: "y", name: "ask_parent", arguments: {} }),
      };
    });
    expect(r.yield).toBeUndefined();
    expect(r.bash).toMatch(/waiting/);
    expect(r.ask).toBeUndefined();
  });

  it("上限ちょうど（4000 文字の質問と 10 個×500 文字の options）はそのまま question に載る", async () => {
    const options = Array.from({ length: 10 }, (_, i) => String(i).repeat(500));
    const question = "質".repeat(4000);
    const fx = newFixture("ask-max", [ask(question, options), report()]);
    await startAndAsk(fx, "ask-max");
    const q = (await typesOf(fx, "question"))[0];
    expect(q?.data.message).toBe(question);
    expect(JSON.parse(String(q?.data.options))).toEqual(options);
  });

  it("未回答の質問があるのに呼ばれたら、同じ「回答待ち」の結果を返し、質問は増やさない", async () => {
    const fx = newFixture("ask-dup", [round(ask("a"), ask("b"))]);
    await startAndAsk(fx, "ask-dup");
    await sleep(300);
    expect(await questionIds(fx)).toEqual(["q-1"]);
    const ends = await typesOf(fx, "tool_end");
    expect(ends.map((e) => e.data.isError)).toEqual([false, false]);
    expect(fx.modelCalls.count).toBe(1);
    expect((await fx.stub.getEvents(0, 1)).phase).toBe("input_required");
  });

  it("未 commit の変更があれば質問を受け付けず、git_commit を促す", async () => {
    const fx = newFixture("ask-dirty", [
      ask("先に聞く"),
      call("write_note", { text: "x" }),
      ask("commit 後に聞く"),
      report(),
    ]);
    fx.statusResults.push({ stdout: " M src/a.ts\n" });
    await startAndAsk(fx, "ask-dirty");
    const ends = await typesOf(fx, "tool_end");
    expect(ends[0]?.data).toMatchObject({ name: "ask_parent", isError: true });
    expect(String(ends[0]?.data.summary)).toContain("git_commit");
    const qs = await typesOf(fx, "question");
    expect(qs).toHaveLength(1);
    expect(qs[0]?.data.message).toBe("commit 後に聞く");
  });

  it("同じラウンドで別のツールも呼ばれたら、後続のツールは止まり、モデルは呼ばれず nudge も出ない", async () => {
    const fx = newFixture("ask-round", [
      round(ask("a"), call("write_note", { text: "x" })),
      report(),
    ]);
    await startAndAsk(fx, "ask-round");
    await sleep(500);
    expect(fx.sandbox.files.size).toBe(0);
    expect(fx.modelCalls.count).toBe(1);
    expect((await fx.stub.getEvents(0, 1)).phase).toBe("input_required");
    expect(fx.sandbox.terminateCount).toBe(0);
    const starts = (await typesOf(fx, "tool_start")).map((e) => e.data.name);
    expect(starts).toEqual(["ask_parent"]);
  });
});

describe("answer", () => {
  it("回答で再開し、回答と続きの台本が進んで完了する。期限の延長は submit より前", async () => {
    const fx = newFixture("ans-1", [ask("Q?"), report("done")]);
    await startAndAsk(fx, "ans-1");
    await fx.answerGate.hold();
    const pending = fx.stub.answer("q-1", "Aにして");
    await fx.answerGate.waitEntered();
    // submit の直前には、すでに SandboxDO の期限を延ばし終えている
    expect(fx.sandbox.extended).toEqual([T0 + 2 * HOUR]);
    fx.answerGate.release();
    expect(await pending).toEqual({ ok: true });
    expect(await waitForTerminal(fx)).toBe("completed");
    const events = await allEvents(fx);
    expect(events.filter((e) => e.type === "answered").map((e) => e.data)).toEqual([
      { question_id: "q-1" },
    ]);
    const phases = events.filter((e) => e.type === "phase").map((e) => e.data.phase);
    expect(phases).toEqual([
      "starting",
      "running",
      "input_required",
      "running",
      "verifying",
      "completed",
    ]);
    expect(fx.modelCalls.count).toBe(2);
    expect(fx.modelCalls.userTexts[1]?.some((t) => t.includes("Aにして"))).toBe(true);
  });

  it("冪等: 同じ questionId の 2 回目以降は ok:true で、二重に再開しない", async () => {
    const fx = newFixture("ans-idem", [ask("Q?"), call("gate"), report()]);
    await startAndAsk(fx, "ans-idem");
    expect(await fx.stub.answer("q-1", "A")).toEqual({ ok: true });
    await fx.gate.waitEntered();
    expect(await fx.stub.answer("q-1", "A")).toEqual({ ok: true });
    expect(await fx.stub.answer("q-1", "別の回答")).toEqual({ ok: true });
    expect((await typesOf(fx, "answered")).length).toBe(1);
    expect(fx.sandbox.extended).toHaveLength(1);
    fx.gate.release();
    expect(await waitForTerminal(fx)).toBe("completed");
    expect(fx.modelCalls.count).toBe(3);
  });

  it("知らない questionId は何もせず ignored", async () => {
    const fx = newFixture("ans-unknown", [ask("Q?"), report()]);
    await startAndAsk(fx, "ans-unknown");
    expect(await fx.stub.answer("q-99", "A")).toEqual({ ok: true, ignored: true });
    expect((await fx.stub.getEvents(0, 1)).phase).toBe("input_required");
    expect(await typesOf(fx, "answered")).toHaveLength(0);
  });

  it("期限の延長に失敗したら ok:false で何も変えず、再送で成功する", async () => {
    const fx = newFixture("ans-extend-fail", [ask("Q?"), report()]);
    await startAndAsk(fx, "ans-extend-fail");
    fx.sandbox.extendError = new Error("sandbox unavailable");
    expect(await fx.stub.answer("q-1", "A")).toEqual({ ok: false });
    expect((await fx.stub.getEvents(0, 1)).phase).toBe("input_required");
    expect(await typesOf(fx, "answered")).toHaveLength(0);
    expect(await fx.stub.answer("q-1", "A")).toEqual({ ok: true });
    expect(await waitForTerminal(fx)).toBe("completed");
  });

  it("Pi への submit に失敗したら ok:false。状態は回答済みのまま失敗にならず、再送で再開する", async () => {
    const fx = newFixture("ans-submit-fail", [ask("Q?"), report()]);
    await startAndAsk(fx, "ans-submit-fail");
    fx.answerGate.throwOnce();
    expect(await fx.stub.answer("q-1", "A")).toEqual({ ok: false });
    // 回答は記録済み（answered）だが、Pi にはまだ渡っていない。ここで失敗にも片付けにもならない
    expect((await fx.stub.getEvents(0, 1)).phase).toBe("running");
    expect(await typesOf(fx, "answered")).toHaveLength(1);
    expect(fx.modelCalls.count).toBe(1);
    await sleep(300);
    expect((await fx.stub.getEvents(0, 1)).phase).toBe("running");
    expect(fx.sandbox.terminateCount).toBe(0);
    expect(await fx.stub.answer("q-1", "A")).toEqual({ ok: true });
    expect(await waitForTerminal(fx)).toBe("completed");
    expect((await typesOf(fx, "answered")).length).toBe(1);
    expect(fx.modelCalls.count).toBe(2);
  });

  it("Pi への submit に失敗しても、tick が再送なしで再開を完了させる", async () => {
    const fx = newFixture("ans-submit-tick", [ask("Q?"), report()]);
    await startAndAsk(fx, "ans-submit-tick");
    fx.answerGate.throwOnce();
    expect(await fx.stub.answer("q-1", "A")).toEqual({ ok: false });
    await runInDO(fx.stub, (inst) => inst.onJob({ job: { fn: "tick" }, attempt: 1 }));
    expect(await waitForTerminal(fx)).toBe("completed");
    expect((await typesOf(fx, "answered")).length).toBe(1);
    expect(fx.modelCalls.count).toBe(2);
  });

  it("run が終わる前に回答が届いても、古い run の完了で failed にならず回答の run が進む", async () => {
    const fx = newFixture("ans-early", [ask("Q?"), report("done")]);
    fx.questionGate.hold();
    await fx.stub.start(makeSpec("ans-early"));
    await fx.questionGate.waitEntered();
    // 質問は記録済みで、ask_parent の run はまだ終わっていない
    expect((await fx.stub.getEvents(0, 1)).phase).toBe("input_required");
    expect(await fx.stub.answer("q-1", "早い回答")).toEqual({ ok: true });
    fx.questionGate.release();
    expect(await waitForTerminal(fx)).toBe("completed");
    expect(fx.modelCalls.userTexts.at(-1)?.some((t) => t.includes("早い回答"))).toBe(true);
  });
});

describe("期限", () => {
  it("回答待ちの間は期限を止める: 元の期限を過ぎても deadline の job や tick で止まらない。回答で待った分だけ延びる", async () => {
    const fx = newFixture("dl-pause", [ask("Q?"), report()]);
    await startAndAsk(fx, "dl-pause");
    await sleep(200);
    fx.clock.now += 5 * HOUR; // 元の期限（T0+2h）を過ぎる
    await runInDO(fx.stub, async (inst) => {
      await inst.onJob({ job: { fn: "deadline" }, attempt: 1 });
      await inst.onJob({ job: { fn: "tick" }, attempt: 1 });
    });
    await sleep(300);
    expect((await fx.stub.getEvents(0, 1)).phase).toBe("input_required");
    expect(fx.sandbox.terminateCount).toBe(0);
    expect(await fx.stub.answer("q-1", "A")).toEqual({ ok: true });
    expect(fx.sandbox.extended).toEqual([T0 + 7 * HOUR]);
    expect(await runInDO(fx.stub, (inst) => inst.debugDeadlineAt())).toBe(T0 + 7 * HOUR);
    // 再起動しても期限は変わらない（再起動では延長しない）
    await abortAllDurableObjects();
    fx.stub = env.AGENT_DO.getByName(fx.name);
    expect(await runInDO(fx.stub, (inst) => inst.debugDeadlineAt())).toBe(T0 + 7 * HOUR);
    expect(await waitForTerminal(fx)).toBe("completed");
  });

  it("回答の後の本来の期限（待った分を足した期限）を過ぎれば、通常どおり deadline で止まる", async () => {
    const fx = newFixture("dl-after", [ask("Q?"), call("gate"), report()]);
    await startAndAsk(fx, "dl-after");
    fx.clock.now += 3 * HOUR;
    await fx.stub.answer("q-1", "A");
    await fx.gate.waitEntered();
    fx.clock.now += 3 * HOUR; // T0+6h > T0+5h
    await runInDO(fx.stub, async (inst) => {
      await inst.onJob({ job: { fn: "deadline" }, attempt: 1 });
    });
    fx.gate.release();
    expect(await waitForTerminal(fx)).toBe("failed");
    expect(done(await fx.stub.getResult()).reason).toBe("deadline");
  });

  it("回答待ちが 24 時間を超えたら failed(input_timeout)。cancel の契約も守る", async () => {
    const fx = newFixture("dl-input-timeout", [ask("Q?"), report()]);
    await startAndAsk(fx, "dl-input-timeout");
    await sleep(200);
    fx.clock.now += 24 * HOUR - 1000;
    await runInDO(fx.stub, (inst) => inst.onJob({ job: { fn: "input_timeout" }, attempt: 1 }));
    await sleep(200);
    expect((await fx.stub.getEvents(0, 1)).phase).toBe("input_required"); // まだ 24 時間に届かない
    fx.clock.now += 2000;
    await runInDO(fx.stub, (inst) => inst.onJob({ job: { fn: "input_timeout" }, attempt: 1 }));
    expect(await waitForTerminal(fx)).toBe("failed");
    const r = done(await fx.stub.getResult());
    expect(r.reason).toBe("input_timeout");
    expect(fx.sandbox.terminateCount).toBeGreaterThanOrEqual(1);
    const cancel = await fx.stub.cancel();
    expect(cancel).toMatchObject({ stopped: true });
    const events = await allEvents(fx);
    expect(cancel.finalSeq).toBe(events[events.length - 1]?.seq);
    expect(events[events.length - 1]).toMatchObject({ type: "phase", data: { phase: "failed" } });
  });

  it("tick でも 24 時間を検知する。待ちの累計が 24 時間を超える 2 回目の質問も同じ", async () => {
    const fx = newFixture("dl-cumulative", [ask("Q1"), ask("Q2"), report()]);
    await startAndAsk(fx, "dl-cumulative");
    fx.clock.now += 20 * HOUR;
    expect(await fx.stub.answer("q-1", "A1")).toEqual({ ok: true });
    await waitUntil(() => fx.modelCalls.count >= 2);
    await waitUntil(() => fx.sandbox.extended.length === 1);
    // 2 回目の質問が記録されるまで待つ
    for (let i = 0; i < 100 && (await questionIds(fx)).length < 2; i++) await sleep(50);
    expect(await questionIds(fx)).toEqual(["q-1", "q-2"]);
    await sleep(200);
    fx.clock.now += 4 * HOUR + 1000; // 累計 24 時間 + 1 秒
    await runInDO(fx.stub, (inst) => inst.onJob({ job: { fn: "tick" }, attempt: 1 }));
    expect(await waitForTerminal(fx)).toBe("failed");
    expect(done(await fx.stub.getResult()).reason).toBe("input_timeout");
  });
});

describe("cancel と回答", () => {
  it("回答待ちの間の cancel: stopped:true と finalSeq に収束し、以後の回答は ignored", async () => {
    const fx = newFixture("c-wait", [ask("Q?"), report()]);
    await startAndAsk(fx, "c-wait");
    await sleep(200);
    const res = await fx.stub.cancel();
    expect(res).toMatchObject({ stopped: true });
    const events = await allEvents(fx);
    expect(res.finalSeq).toBe(events[events.length - 1]?.seq);
    expect(events[events.length - 1]).toMatchObject({
      type: "phase",
      data: { phase: "cancelled" },
    });
    expect(await fx.stub.answer("q-1", "A")).toEqual({ ok: true, ignored: true });
    expect(fx.modelCalls.count).toBe(1);
    expect(await fx.stub.cancel()).toMatchObject({ stopped: true, finalSeq: res.finalSeq });
  });

  it("回答の submit 中に cancel が届いても、どちらの順序でも cancelled に収束し Pi の run が残らない", async () => {
    const fx = newFixture("c-race", [ask("Q?"), report()]);
    await startAndAsk(fx, "c-race");
    await sleep(200);
    fx.answerGate.hold();
    const answering = fx.stub.answer("q-1", "A");
    await fx.answerGate.waitEntered();
    const cancelling = fx.stub.cancel();
    await sleep(50);
    fx.answerGate.release();
    expect(await answering).toEqual({ ok: true, ignored: true });
    await cancelling;
    const res = await fx.stub.cancel();
    expect(res).toMatchObject({ stopped: true });
    expect((await fx.stub.getEvents(0, 1)).phase).toBe("cancelled");
    const events = await allEvents(fx);
    expect(res.finalSeq).toBe(events[events.length - 1]?.seq);
    await waitUntil(() => true);
    for (let i = 0; i < 100; i++) {
      if (await piIdle(fx)) break;
      await sleep(50);
    }
    expect(await piIdle(fx)).toBe(true);
    expect(fx.modelCalls.count).toBe(1);
  });

  it("cancel が先に確定した後の回答は ignored で、Pi に何も渡さない", async () => {
    const fx = newFixture("c-first", [ask("Q?"), report()]);
    await startAndAsk(fx, "c-first");
    await fx.stub.cancel();
    expect(await fx.stub.answer("q-1", "A")).toEqual({ ok: true, ignored: true });
    expect(fx.sandbox.extended).toHaveLength(0);
    expect(await piIdle(fx)).toBe(true);
  });
});

describe("steer", () => {
  it("実行中の steer は Pi に渡り、モデルへのメッセージに含まれる。冪等で、steer_accepted は 1 回", async () => {
    const fx = newFixture("st-run", [call("gate"), report()]);
    await fx.stub.start(makeSpec("st-run"));
    await fx.gate.waitEntered();
    expect(await fx.stub.steer("s1", "pnpm を使って")).toEqual({ ok: true });
    expect(await fx.stub.steer("s1", "別の文面")).toEqual({ ok: true });
    fx.gate.release();
    expect(await waitForTerminal(fx)).toBe("completed");
    const accepted = (await typesOf(fx, "steer_accepted")).map((e) => e.data);
    expect(accepted).toEqual([{ steer_id: "s1" }]);
    expect(fx.modelCalls.userTexts.at(-1)?.some((t) => t.includes("pnpm を使って"))).toBe(true);
    expect(fx.modelCalls.userTexts.at(-1)?.some((t) => t.includes("別の文面"))).toBe(false);
    // 終端の後は ignored
    expect(await fx.stub.steer("s2", "遅い")).toEqual({ ok: true, ignored: true });
  });

  it("cancel の後（tombstone）の steer は ignored", async () => {
    const fx = newFixture("st-cancel", [call("gate"), report()], { cancelWaitMs: 300 });
    await fx.stub.start(makeSpec("st-cancel"));
    await fx.gate.waitEntered();
    await fx.stub.cancel();
    expect(await fx.stub.steer("s1", "x")).toEqual({ ok: true, ignored: true });
    fx.gate.release();
  });

  it("starting の間に届いた steer は buffered になり、最初の submit のメッセージに添えられる", async () => {
    const fx = newFixture("st-start", [report()]);
    fx.submitGate.hold();
    await fx.stub.start(makeSpec("st-start"));
    await fx.submitGate.waitEntered();
    expect(await fx.stub.steer("s0", "最初に伝える")).toEqual({ ok: true });
    expect(await typesOf(fx, "steer_accepted")).toHaveLength(0);
    fx.submitGate.release();
    expect(await waitForTerminal(fx)).toBe("completed");
    expect(fx.modelCalls.userTexts[0]?.some((t) => t.includes("最初に伝える"))).toBe(true);
    expect((await typesOf(fx, "steer_accepted")).map((e) => e.data)).toEqual([{ steer_id: "s0" }]);
    expect(done(await fx.stub.getResult()).status).toBe("completed");
  });

  it("input_required の間に届いた steer は回答とみなさず、再開の submit に添えられる", async () => {
    const fx = newFixture("st-wait", [ask("Q?"), report()]);
    await startAndAsk(fx, "st-wait");
    await sleep(200);
    expect(await fx.stub.steer("s1", "補足の指示")).toEqual({ ok: true });
    await sleep(300);
    expect(fx.modelCalls.count).toBe(1);
    expect((await fx.stub.getEvents(0, 1)).phase).toBe("input_required");
    expect(await typesOf(fx, "steer_accepted")).toHaveLength(0);
    expect(await fx.stub.answer("q-1", "回答です")).toEqual({ ok: true });
    expect(await waitForTerminal(fx)).toBe("completed");
    const last = fx.modelCalls.userTexts.at(-1) ?? [];
    expect(last.some((t) => t.includes("回答です"))).toBe(true);
    expect(last.some((t) => t.includes("補足の指示"))).toBe(true);
    expect((await typesOf(fx, "steer_accepted")).map((e) => e.data)).toEqual([{ steer_id: "s1" }]);
  });

  it("ask_parent の直前に Pi へ渡した steer は引き戻され、質問の後にモデルは呼ばれない。次の submit に添えられる", async () => {
    const fx = newFixture("st-queued", [ask("Q?"), report()]);
    fx.askGate.hold();
    await fx.stub.start(makeSpec("st-queued"));
    await fx.askGate.waitEntered();
    expect(await fx.stub.steer("s1", "遅れて届いた指示")).toEqual({ ok: true });
    fx.askGate.release();
    await waitForPhase(fx, "input_required");
    await sleep(500);
    expect(fx.modelCalls.count).toBe(1);
    expect(await piIdle(fx)).toBe(true);
    expect(await fx.stub.answer("q-1", "回答")).toEqual({ ok: true });
    expect(await waitForTerminal(fx)).toBe("completed");
    const last = fx.modelCalls.userTexts.at(-1) ?? [];
    expect(last.some((t) => t.includes("遅れて届いた指示"))).toBe(true);
    expect((await typesOf(fx, "steer_accepted")).length).toBe(1);
  });

  it("steer の submit の最中に質問が確定しても、モデルは呼ばれず、steer は次の submit に回る", async () => {
    const fx = newFixture("st-inflight", [ask("Q?"), report()]);
    fx.askGate.hold();
    await fx.stub.start(makeSpec("st-inflight"));
    await fx.askGate.waitEntered();
    fx.steerGate.hold();
    const steering = fx.stub.steer("s1", "飛び込みの指示");
    await fx.steerGate.waitEntered();
    fx.askGate.release();
    await waitForPhase(fx, "input_required");
    await sleep(300);
    fx.steerGate.release();
    expect(await steering).toEqual({ ok: true });
    await sleep(500);
    expect(fx.modelCalls.count).toBe(1);
    expect((await fx.stub.getEvents(0, 1)).phase).toBe("input_required");
    for (let i = 0; i < 100 && !(await piIdle(fx)); i++) await sleep(50);
    expect(await piIdle(fx)).toBe(true);
    expect(await fx.stub.answer("q-1", "回答")).toEqual({ ok: true });
    expect(await waitForTerminal(fx)).toBe("completed");
    expect(fx.modelCalls.userTexts.at(-1)?.some((t) => t.includes("飛び込みの指示"))).toBe(true);
  });
});
