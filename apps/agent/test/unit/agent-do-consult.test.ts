import { env, runInDurableObject } from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";
import { clearAgentTestOverrides, setAgentTestOverrides } from "../../src/agent/deps";
import type { ConsultRequest, ConsultResult } from "../../src/agent/types";

afterEach(() => clearAgentTestOverrides());

// vitest.config.ts の AGENT_MODELS: sonnet（既定）・haiku・gpt-6-sol。test 環境のモデルは台本付き fake
// （単価は TEST_MODEL_PRICES: 入出力 $1/100万、cacheRead $0.1、cacheWrite $1.25）。

let seq = 0;
/** consult-<26 桁の Crockford base32>（数字だけで足りる） */
function newName(): string {
  return `consult-${String(++seq).padStart(26, "0")}`;
}

type Observed = {
  userTexts: string[][];
  maxTokens: (number | undefined)[];
  metadata: (Record<string, unknown> | undefined)[];
  systemTexts: (string | undefined)[];
};

function setup(over: Partial<ConsultRequest> = {}) {
  const name = newName();
  const seen: Observed = { userTexts: [], maxTokens: [], metadata: [], systemTexts: [] };
  setAgentTestOverrides(name, {
    onModelCall: (ctx) => {
      seen.userTexts.push(ctx?.userTexts ?? []);
      seen.maxTokens.push(ctx?.maxTokens);
      seen.metadata.push(ctx?.metadata);
      seen.systemTexts.push(ctx?.systemText);
    },
  });
  const stub = env.AGENT_DO.getByName(name);
  const question = `question for ${name}`;
  const request: ConsultRequest = {
    consultId: name,
    userId: "42",
    model: "anthropic/claude-sonnet-5-5",
    system: "You are an architect.",
    messages: [{ role: "user", content: question }],
    budgetUsd: 0.5,
    ...over,
  };
  return { name, stub, seen, request, question };
}

const asOk = (r: ConsultResult) => {
  if (!r.ok) throw new Error(`consult failed: ${r.code}: ${r.message}`);
  return r;
};

describe("AgentDO.consult", () => {
  it("1 回で完結する。応答のテキスト・usage（キャッシュ込み）・実費を返す", async () => {
    const q = "design question 1";
    const t = setup({ messages: [{ role: "user", content: q }] });
    await t.stub.setScript(q, [
      {
        text: "Use an outbox.",
        usage: { input: 1000, output: 500, cacheRead: 2000, cacheWrite: 400 },
      },
    ]);
    const r = asOk(await t.stub.consult(t.request));
    expect(r.text).toBe("Use an outbox.");
    expect(r.usage).toEqual({ input: 1000, output: 500, cacheRead: 2000, cacheWrite: 400 });
    // (1000 + 500) × $1/M + 2000 × $0.1/M + 400 × $1.25/M
    expect(r.costUsd).toBeCloseTo(0.0015 + 0.0002 + 0.0005, 9);
    expect(r.model).toBe("anthropic/claude-sonnet-5-5");
  });

  it("キャッシュの単価で実費を数える（cacheRead / cacheWrite を落とさない）", async () => {
    const q = "design question 2";
    const t = setup({ messages: [{ role: "user", content: q }] });
    await t.stub.setScript(q, [
      { text: "x", usage: { input: 0, output: 0, cacheRead: 1_000_000 } },
    ]);
    const r = asOk(await t.stub.consult(t.request));
    expect(r.costUsd).toBeCloseTo(0.1, 9);
  });

  it("system と messages（履歴）をモデルに渡す。AI Gateway の metadata に userId・consultId・caller を付ける", async () => {
    const t = setup({
      messages: [
        { role: "user", content: "first" },
        { role: "assistant", content: "answer" },
        { role: "user", content: "second" },
      ],
    });
    await t.stub.setScript("first", [{ text: "ok", usage: { input: 1, output: 1 } }]);
    asOk(await t.stub.consult(t.request));
    expect(t.seen.userTexts[0]).toEqual(["first", "second"]);
    expect(t.seen.systemTexts[0]).toBe("You are an architect.");
    expect(t.seen.metadata[0]).toMatchObject({
      userId: "42",
      consultId: t.name,
      caller: "consult",
    });
  });

  it("出力の上限を予約額から掛ける（希望より小さければそちらを採る）", async () => {
    // 予算 $0.001: 入力の見積り（約 1.1k トークン × 最悪 $1.25/M ≒ $0.0014）で足りず、input_too_large
    const small = setup({ budgetUsd: 0.001 });
    expect(await small.stub.consult(small.request)).toMatchObject({
      ok: false,
      code: "input_too_large",
      costUsd: 0,
    });
    expect(small.seen.userTexts).toHaveLength(0);

    // 予算 $0.005: 入力の見積り ≒ (question 約 40 バイト + 枠 1024) × 1.25/M ≒ $0.0013。残りを出力 $1/M で割った数が上限
    const t = setup({ budgetUsd: 0.005 });
    await t.stub.setScript(t.request.messages[0]?.content ?? "", [{ text: "x" }]);
    asOk(await t.stub.consult(t.request));
    const cap = t.seen.maxTokens[0] ?? 0;
    expect(cap).toBeGreaterThan(3000);
    expect(cap).toBeLessThan(4000);
    // 希望（max_output_tokens）が小さければ、そちらを採る
    const t2 = setup({ budgetUsd: 0.5, maxOutputTokens: 123 });
    await t2.stub.setScript(t2.request.messages[0]?.content ?? "", [{ text: "x" }]);
    asOk(await t2.stub.consult(t2.request));
    expect(t2.seen.maxTokens[0]).toBe(123);
    // 希望が無ければ既定の上限（8192）。予約額が十分なら既定のまま
    const t3 = setup({ budgetUsd: 0.5 });
    await t3.stub.setScript(t3.request.messages[0]?.content ?? "", [{ text: "x" }]);
    asOk(await t3.stub.consult(t3.request));
    expect(t3.seen.maxTokens[0]).toBe(8192);
  });

  it("AGENT_MODELS に無いモデルは、モデルを呼ばずに unknown_model（許可リストにはある gpt-6-astra も）", async () => {
    for (const model of ["openai/gpt-6-astra", "anthropic/claude-opus-5", "x"]) {
      const t = setup({ model });
      expect(await t.stub.consult(t.request), model).toMatchObject({
        ok: false,
        code: "unknown_model",
        costUsd: 0,
      });
      expect(t.seen.userTexts, model).toHaveLength(0);
    }
  });

  it("consult のインスタンスでなければ（名前が違う・consultId が食い違う）拒否する。タスクの DO は使えない", async () => {
    const t = setup();
    const other = env.AGENT_DO.getByName("01HZZZZZZZZZZZZZZZZZZZZZZZ");
    expect(
      await other.consult({ ...t.request, consultId: "01HZZZZZZZZZZZZZZZZZZZZZZZ" }),
    ).toMatchObject({ ok: false, code: "invalid_request" });
    expect(await t.stub.consult({ ...t.request, consultId: newName() })).toMatchObject({
      ok: false,
      code: "invalid_request",
    });
    expect(t.seen.userTexts).toHaveLength(0);
  });

  it("壊れた依頼（予算が 0・NaN、messages が空、最後が user でない）は invalid_request", async () => {
    const bad: Partial<ConsultRequest>[] = [
      { budgetUsd: 0 },
      { budgetUsd: Number.NaN },
      { budgetUsd: -1 },
      { messages: [] },
      { messages: [{ role: "assistant", content: "x" }] },
      { maxOutputTokens: 0 },
      { maxOutputTokens: 1.5 },
    ];
    for (const over of bad) {
      const t = setup(over);
      expect(await t.stub.consult(t.request), JSON.stringify(over)).toMatchObject({
        ok: false,
        code: "invalid_request",
        costUsd: 0,
      });
      expect(t.seen.userTexts).toHaveLength(0);
    }
  });

  it("モデルの呼び出しが失敗したら model_error（それまでにかかった費用つき）", async () => {
    const t = setup();
    await t.stub.setScript(t.request.messages[0]?.content ?? "", [
      { error: "upstream 500", usage: { input: 10, output: 0 } },
    ]);
    const r = await t.stub.consult(t.request);
    expect(r).toMatchObject({ ok: false, code: "model_error", costUsd: expect.any(Number) });
    // 内部のエラー文は返さない（固定の文言）
    expect(JSON.stringify(r)).not.toContain("upstream 500");
  });

  it("モデルが usage なしで失敗したら、実費が分からないので予約額（budgetUsd）で精算させる", async () => {
    // ストリームの途中で切れた場合など、プロバイダが課金していても usage が返らないことがある（少なく数えない）
    const t = setup({ budgetUsd: 0.5 });
    await t.stub.setScript(t.request.messages[0]?.content ?? "", [{ error: "stream cut" }]);
    const r = await t.stub.consult(t.request);
    expect(r).toMatchObject({ ok: false, code: "model_error", costUsd: 0.5 });
  });

  it("終わったら、この consult のインスタンスの保存データを消す（consult ごとに別のインスタンスなので残さない）", async () => {
    const t = setup();
    await t.stub.setScript(t.request.messages[0]?.content ?? "", [{ text: "x" }]);
    asOk(await t.stub.consult(t.request));
    const tables = await runInDurableObject(t.stub, (_i, state) =>
      state.storage.sql
        .exec<{ name: string }>(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE '_cf_%'",
        )
        .toArray(),
    );
    expect(tables).toEqual([]);
    // alarm も残さない（Lifecycle が予約していると、データの無い DO が起きてしまう）
    expect(await runInDurableObject(t.stub, (_i, state) => state.storage.getAlarm())).toBeNull();
  });
});
