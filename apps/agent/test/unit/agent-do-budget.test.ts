import { runInDurableObject } from "cloudflare:test";
import { computeCostUsd } from "@rovo/models";
import { afterEach, describe, expect, it } from "vitest";
import { clearAgentTestOverrides } from "../../src/agent/deps";
import {
  estimateCallCostUsd,
  estimateTokens,
  maxOutputTokensWithin,
  priceFor,
  REQUEST_OVERHEAD_TOKENS,
} from "../../src/agent/pricing";
import { call, done, makeSpec, newFixture, report, waitForTerminal } from "./support/agent-fixture";

afterEach(() => clearAgentTestOverrides());

// biome-ignore lint/suspicious/noExplicitAny: private メンバーの観測
type Inst = any;
const runInDO = runInDurableObject as unknown as <T>(
  stub: unknown,
  fn: (inst: Inst) => Promise<T> | T,
) => Promise<T>;

const PRICE = priceFor("scripted/script-1", true);
if (!PRICE) throw new Error("scripted/script-1 の単価が無い");

/** 台本の最初のツール（gate）で止めた状態の AgentDO を作る。preModelCall を直接呼んで判定を観測する。 */
async function gated(name: string, budgetUsd: number, opts: { maxOutputTokens?: number } = {}) {
  // usage を返す台本にする（返さないと、見積額が費用に積まれて残額が変わる）
  const fx = newFixture(name, [{ ...call("gate"), usage: { input: 1 } }, report()], opts);
  await fx.stub.start(makeSpec(name, { budgetUsd }));
  await fx.gate.waitEntered();
  return fx;
}

describe("予算の判定: 出力は残額に合わせて絞る（C1）", () => {
  it("使った額が上限の 6 割でも、実測の入力が小さければ budget_exceeded にせず、maxTokens を残額に収まる値まで縮めて呼ぶ", async () => {
    // 1 回目: 実測の入力 1,000・出力 599,000 トークン（$1/M で約 $0.6）。2 回目の見積もりは、
    // 従来の方式だと 0.6 + 出力上限 500,000 分の $0.5 + 入力 > 1.0 で止まっていた
    const fx = newFixture(
      "budget-shrink",
      [
        { ...call("write_note", { text: "x" }), usage: { input: 1_000, output: 599_000 } },
        report(),
      ],
      { maxOutputTokens: 500_000 },
    );
    await fx.stub.start(makeSpec("budget-shrink", { budgetUsd: 1.0 }));
    expect(await waitForTerminal(fx)).toBe("completed");
    expect(fx.modelCalls.count).toBe(2);
    expect(fx.modelCalls.maxTokens[0]).toBe(500_000);
    const second = fx.modelCalls.maxTokens[1] ?? 0;
    expect(second).toBeGreaterThan(300_000);
    expect(second).toBeLessThan(400_000);
    // 縮めた分を含めても、使った額 + 見積もりは上限を超えない
    const r = done(await fx.stub.getResult());
    expect(r.usage.costUsd).toBeLessThanOrEqual(1.0);
  });

  it("収まる出力が下限（1,024 トークン）を割るときだけ block する", async () => {
    const fx = await gated("budget-floor", 1.0);
    const ctx = {};
    const contextTokens = estimateTokens(JSON.stringify(ctx)) + REQUEST_OVERHEAD_TOKENS;
    const inputCost = estimateCallCostUsd(PRICE, contextTokens, 0);
    // 残りが出力 2,000 トークン分: 下限以上なので block せず、2,000 に縮める
    await runInDO(fx.stub, (inst) =>
      inst.store.setMeta("usage_missing_usd", 1.0 - inputCost - 0.002),
    );
    const ok = await runInDO(fx.stub, (inst) => inst.preModelCall(ctx));
    expect(ok).not.toHaveProperty("block");
    expect(ok.maxTokens).toBeGreaterThanOrEqual(1_024);
    expect(ok.maxTokens).toBeLessThanOrEqual(2_000);
    // 残りが出力 500 トークン分: 下限を割るので block する
    await runInDO(fx.stub, (inst) =>
      inst.store.setMeta("usage_missing_usd", 1.0 - inputCost - 0.0005),
    );
    const ng = await runInDO(fx.stub, (inst) => inst.preModelCall(ctx));
    expect(ng).toEqual({ block: "budget_exceeded" });
    fx.gate.release();
    expect(await waitForTerminal(fx)).toBe("budget_exceeded");
  });

  it("実測が無い初回は従来どおり（バイト数 + 余裕）で見積もる", async () => {
    const fx = await gated("budget-first-bytes", 0.3, { maxOutputTokens: 200_000 });
    const ctx = { text: "あ".repeat(60_000) }; // 約 180KB
    const bytes = estimateTokens(JSON.stringify(ctx)) + REQUEST_OVERHEAD_TOKENS;
    // 台本の 1 回目の実測を消して、「実測が無い」状態にする
    await runInDO(fx.stub, (inst) => inst.store.setMeta("last_call_basis", null));
    const v = await runInDO(fx.stub, (inst) => inst.preModelCall(ctx));
    // 台本の 1 回目の費用（入力 1 トークン = $0.000001）の分だけ、残額が小さい
    const expected = maxOutputTokensWithin(PRICE, bytes, 0.3);
    expect(v.maxTokens).toBeLessThanOrEqual(expected);
    expect(v.maxTokens).toBeGreaterThanOrEqual(expected - 5);
    expect(v.maxTokens).toBeLessThan(200_000);
    fx.gate.release();
    await waitForTerminal(fx);
  });

  it("実測がある 2 回目以降は、実測の入力 + 前回以降に増えた分（バイト数）で見積もる。少なく数えない", async () => {
    const fx = await gated("budget-measured", 0.3, { maxOutputTokens: 200_000 });
    const ctx = { text: "あ".repeat(60_000) };
    const bytes = estimateTokens(JSON.stringify(ctx));
    // 前回の呼び出し: コンテキストが 170,000 バイトのとき、プロバイダーは入力 1,000 トークンと返した
    await runInDO(fx.stub, (inst) =>
      inst.store.setMeta("last_call_basis", {
        inputTokens: 1_000,
        contextBytes: bytes - 10_000,
        model: inst.modelId(),
      }),
    );
    const v = await runInDO(fx.stub, (inst) => inst.preModelCall(ctx));
    const expected = maxOutputTokensWithin(PRICE, 1_000 + 10_000 + REQUEST_OVERHEAD_TOKENS, 0.3);
    expect(v.maxTokens).toBe(Math.min(200_000, expected));
    // 増えた分と余裕を足しているので、実測だけ（1,000）で見積もった値より小さい
    expect(v.maxTokens).toBeLessThan(maxOutputTokensWithin(PRICE, 1_000, 0.3));
    fx.gate.release();
    await waitForTerminal(fx);
  });

  it("context が前回より縮んでいる、またはモデルが変わっているときは、実測を捨ててバイト数の全量で見積もる", async () => {
    const fx = await gated("budget-basis-discard", 0.3, { maxOutputTokens: 200_000 });
    const ctx = { text: "あ".repeat(60_000) };
    const bytes = estimateTokens(JSON.stringify(ctx));
    const full = maxOutputTokensWithin(PRICE, bytes + REQUEST_OVERHEAD_TOKENS, 0.3);
    const cases = [
      // 前回より context が小さい（圧縮などで縮んだ後に伸びた）
      (m: string) => ({ inputTokens: 1_000, contextBytes: bytes + 10_000, model: m }),
      // モデルが違う（トークナイザーが違う）
      () => ({ inputTokens: 1_000, contextBytes: bytes - 10_000, model: "other/model" }),
    ];
    for (const make of cases) {
      await runInDO(fx.stub, (inst) => inst.store.setMeta("last_call_basis", make(inst.modelId())));
      const v = await runInDO(fx.stub, (inst) => inst.preModelCall(ctx));
      // 台本の 1 回目の費用の分だけ残額が小さい
      expect(v.maxTokens).toBeLessThanOrEqual(full);
      expect(v.maxTokens).toBeGreaterThanOrEqual(full - 5);
    }
    fx.gate.release();
    await waitForTerminal(fx);
  });
});

describe("予算の判定: 前回キャッシュから読めた分は cacheRead の単価で見積もる", () => {
  // 台本のモデルの単価: input $1 / cacheRead $0.1 / cacheWrite $1.25 / output $1（/100万）。
  // context は {}（2 バイト）で前回と同じ → 増分は 0。入力の見積もりは 200,000 + 余裕 1,024
  const CTX = {};
  const CTX_BYTES = estimateTokens(JSON.stringify(CTX));
  const BUDGET = 0.25; // 全量を最悪の単価（$1.25/M）で見積もると入力だけで $0.2513 > 予算

  /** 前回の実測。cacheRead が 190,000 トークン */
  const hitBasis = (inst: Inst, over: Record<string, unknown> = {}) => ({
    inputTokens: 200_000,
    contextBytes: CTX_BYTES,
    model: inst.modelId(),
    cacheReadTokens: 190_000,
    at: inst.now(),
    ...over,
  });

  it("前回 cache hit があれば、通常の単価では入力だけで足りない残りでも止まらず、cacheRead の単価で見積もって呼ぶ", async () => {
    const fx = await gated("budget-cache-hit", BUDGET, { maxOutputTokens: 400_000 });
    await runInDO(fx.stub, (inst) => inst.store.setMeta("last_call_basis", hitBasis(inst)));
    const v = await runInDO(fx.stub, (inst) => inst.preModelCall(CTX));
    expect(v).not.toHaveProperty("block");
    expect(v.maxTokens).toBeGreaterThanOrEqual(1_024);
    // 通常の単価では収まる出力が 0
    expect(maxOutputTokensWithin(PRICE, 200_000 + REQUEST_OVERHEAD_TOKENS, BUDGET)).toBe(0);
    // 割り引いた見積もりで収まる量そのもの（台本の 1 回目の費用の分だけ残額が小さい）
    const expected = maxOutputTokensWithin(
      PRICE,
      200_000 + REQUEST_OVERHEAD_TOKENS,
      BUDGET,
      190_000,
    );
    expect(v.maxTokens).toBeLessThanOrEqual(expected);
    expect(v.maxTokens).toBeGreaterThanOrEqual(expected - 5);
    fx.gate.release();
    await waitForTerminal(fx);
  });

  it("増分（前回以降に増えた context と枠の余裕）は、cacheRead に含めず通常の単価で見積もる", async () => {
    const fx = await gated("budget-cache-delta", BUDGET, { maxOutputTokens: 400_000 });
    const bigCtx = { text: "x".repeat(50_000) };
    const bytes = estimateTokens(JSON.stringify(bigCtx));
    await runInDO(fx.stub, (inst) =>
      inst.store.setMeta("last_call_basis", hitBasis(inst, { contextBytes: CTX_BYTES })),
    );
    const v = await runInDO(fx.stub, (inst) => inst.preModelCall(bigCtx));
    const total = 200_000 + (bytes - CTX_BYTES) + REQUEST_OVERHEAD_TOKENS;
    const expected = maxOutputTokensWithin(PRICE, total, BUDGET, 190_000);
    expect(v.maxTokens).toBeLessThanOrEqual(expected);
    expect(v.maxTokens).toBeGreaterThanOrEqual(expected - 5);
    // 全部を cacheRead 扱いにした場合より小さい
    expect(v.maxTokens).toBeLessThan(maxOutputTokensWithin(PRICE, total, BUDGET, total));
    fx.gate.release();
    await waitForTerminal(fx);
  });

  it("割り引かない場合は今どおり止まる: basis が無い・モデルが違う・context が縮んだ・古い形の basis・古すぎる basis", async () => {
    // basis を使えない場合は context 全体のバイト数で見積もるので、入力の大きい context を渡す
    const BIG = { text: "x".repeat(200_000) };
    const BIG_BYTES = estimateTokens(JSON.stringify(BIG));
    const cases: [string, unknown, (inst: Inst) => unknown][] = [
      ["no-basis", BIG, () => null],
      ["other-model", BIG, (inst) => hitBasis(inst, { model: "other/model" })],
      ["shrunk", BIG, (inst) => hitBasis(inst, { contextBytes: BIG_BYTES + 10_000 })],
      [
        "old-shape",
        CTX,
        (inst) => ({ inputTokens: 200_000, contextBytes: CTX_BYTES, model: inst.modelId() }),
      ],
      ["no-timestamp", CTX, (inst) => hitBasis(inst, { at: undefined })],
      // プロバイダー側のキャッシュの TTL（5 分）に近いので、読み出しを当てにしない
      ["stale", CTX, (inst) => hitBasis(inst, { at: inst.now() - 5 * 60_000 })],
      ["no-cache-read", CTX, (inst) => hitBasis(inst, { cacheReadTokens: 0 })],
    ];
    for (const [name, ctx, make] of cases) {
      const fx = await gated(`budget-cache-off-${name}`, BUDGET);
      await runInDO(fx.stub, (inst) => inst.store.setMeta("last_call_basis", make(inst)));
      const v = await runInDO(fx.stub, (inst) => inst.preModelCall(ctx));
      expect(v, name).toEqual({ block: "budget_exceeded" });
      fx.gate.release();
      expect(await waitForTerminal(fx), name).toBe("budget_exceeded");
    }
  });

  it("見積もった出力まで使い切り、前回の読み出しが全部当たっても、実費（computeCostUsd）+ これまでの費用は予算以下", async () => {
    const fx = await gated("budget-cache-actual", BUDGET, { maxOutputTokens: 400_000 });
    await runInDO(fx.stub, (inst) => inst.store.setMeta("last_call_basis", hitBasis(inst)));
    const bigCtx = { text: "x".repeat(30_000) };
    const bytes = estimateTokens(JSON.stringify(bigCtx));
    const v = await runInDO(fx.stub, (inst) => inst.preModelCall(bigCtx));
    const spent = await runInDO(fx.stub, (inst) => inst.store.usage().costUsd);
    const delta = bytes - CTX_BYTES + REQUEST_OVERHEAD_TOKENS;
    // 実際: 190,000 は cacheRead、残り（前回の入力 10,000 と増分）は最悪でも cacheWrite の単価
    for (const rest of [
      { input: 10_000 + delta, cacheWrite: 0 },
      { input: 0, cacheWrite: 10_000 + delta },
    ]) {
      const actual = computeCostUsd(PRICE, {
        ...rest,
        cacheRead: 190_000,
        output: v.maxTokens,
      });
      expect(spent + actual).toBeLessThanOrEqual(BUDGET + 1e-9);
    }
    fx.gate.release();
    await waitForTerminal(fx);
  });

  it("成功した呼び出しの basis に、実測の cacheRead と時刻を残す", async () => {
    const fx = newFixture("budget-cache-note", [
      { ...call("gate"), usage: { input: 10, cacheRead: 5_000, cacheWrite: 7, output: 3 } },
      report(),
    ]);
    await fx.stub.start(makeSpec("budget-cache-note", { budgetUsd: 1 }));
    await fx.gate.waitEntered();
    fx.gate.release();
    expect(await waitForTerminal(fx)).toBe("completed");
    const basis = await runInDO(fx.stub, (inst) => inst.store.meta("last_call_basis"));
    expect(basis).toMatchObject({ cacheReadTokens: 5_000 });
    expect(typeof basis.at).toBe("number");
  });
});
