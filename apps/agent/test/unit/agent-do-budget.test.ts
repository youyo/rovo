import { runInDurableObject } from "cloudflare:test";
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
