import { describe, expect, it, vi } from "vitest";
import {
  CHUNK_MAX_TOKENS,
  CLEF_CONTEXT_TOKENS,
  CLEF_QUESTIONS,
  createClefEvaluator,
  estimateTokens,
  MAX_EVAL_CHUNKS,
  splitIntoChunks,
} from "../../src/safety/clef";
import { CATEGORIES } from "../../src/types";

type RunArgs = [
  string,
  { model: string; state: string; questions: Record<string, unknown> },
  unknown,
];

function answers(score: number, over: Record<string, number> = {}) {
  const out: Record<string, { noul: number }> = {};
  for (const c of CATEGORIES) out[c] = { noul: over[c] ?? score };
  return { answers: out };
}

function fakeAi(handler: (state: string, call: number) => unknown) {
  let n = 0;
  const run = vi.fn(async (...args: RunArgs) => {
    const v = handler(args[1].state, n++);
    if (v instanceof Error) throw v;
    return v;
  });
  return { ai: { run } as unknown as Ai, run };
}

const CTX = { userId: "u1", taskId: "t1", caller: "child" as const };

describe("Clef の質問（noul）", () => {
  it("7つのカテゴリすべてを noul で定義し、criteria.true / criteria.false を持つ", () => {
    expect(Object.keys(CLEF_QUESTIONS).sort()).toEqual([...CATEGORIES].sort());
    expect(CATEGORIES).toEqual([
      "prompt_injection",
      "instruction_override",
      "role_spoofing",
      "tool_execution_inducement",
      "credential_exfiltration",
      "suspicious_external_transmission",
      "evaluator_manipulation",
    ]);
    for (const q of Object.values(CLEF_QUESTIONS)) {
      expect(q.type).toBe("noul");
      expect(q.instructions.length).toBeGreaterThan(20);
      expect(q.criteria.true.length).toBeGreaterThan(10);
      expect(q.criteria.false.length).toBeGreaterThan(10);
    }
  });
});

describe("createClefEvaluator", () => {
  it("env.AI.run を clef-flash・AI Gateway の metadata 付きで呼び、本文は state にだけ入れる", async () => {
    const { ai, run } = fakeAi(() => answers(0.02));
    const ev = createClefEvaluator({ ai, gatewayId: "gw-1" });
    const body = "Hello from the web page";
    const r = await ev.evaluate(body, CTX);

    expect(run).toHaveBeenCalledTimes(1);
    const [model, input, options] = run.mock.calls[0] as RunArgs;
    expect(model).toBe("@cf/cloudflare/clef-flash");
    expect(input.model).toBe("clef-flash");
    // state は本文だけ（切り詰めは AI.run の例外と usage で検知する。目印は付けない）
    expect(input.state).toBe(body);
    expect(options).toEqual({
      gateway: { id: "gw-1", metadata: { userId: "u1", taskId: "t1", caller: "child" } },
    });
    // 評価の指示は questions にだけある。本文（state）には指示が混ざらない
    expect(Object.keys(input.questions).sort()).toEqual([...CATEGORIES].sort());
    expect(JSON.stringify(input.questions)).not.toContain(body);
    for (const q of Object.values(input.questions) as { type: string }[])
      expect(q.type).toBe("noul");

    expect(r.complete).toBe(true);
    expect(r.evaluator).toBe("clef-flash");
    expect(r.evaluatedChars).toBe(body.length);
    expect(r.totalChars).toBe(body.length);
    expect(r.scores.prompt_injection).toBeCloseTo(0.02);
  });

  it("taskId がなければ metadata に含めない", async () => {
    const { ai, run } = fakeAi(() => answers(0));
    await createClefEvaluator({ ai, gatewayId: "gw" }).evaluate("x", {
      userId: "u",
      caller: "parent",
    });
    expect((run.mock.calls[0] as RunArgs)[2]).toEqual({
      gateway: { id: "gw", metadata: { userId: "u", caller: "parent" } },
    });
  });

  it("全文をトークン見積り（UTF-8 バイト）で約 20,000 以下のチャンクに分け、すべて評価する（末尾の注入を見逃さない）", async () => {
    const text = `${"a".repeat(49_000)} TAIL-INJECTION ${"b".repeat(900)}`;
    const { ai, run } = fakeAi((state) =>
      state.includes("TAIL-INJECTION") ? answers(0.01, { prompt_injection: 0.97 }) : answers(0.01),
    );
    const r = await createClefEvaluator({ ai, gatewayId: "gw" }).evaluate(text, CTX);

    expect(run.mock.calls.length).toBeGreaterThanOrEqual(2);
    for (const c of run.mock.calls as RunArgs[]) {
      expect(estimateTokens(c[1].state)).toBeLessThanOrEqual(CHUNK_MAX_TOKENS);
    }
    expect(r.complete).toBe(true);
    expect(r.scores.prompt_injection).toBeCloseTo(0.97);
    expect(r.evaluatedChars).toBeGreaterThanOrEqual(text.length);
  });

  it("チャンクの和集合が全文を覆い、境界をまたぐ注入のため少し重なる", () => {
    const text = Array.from({ length: 100_000 }, (_, i) => String.fromCharCode(97 + (i % 26))).join(
      "",
    );
    const chunks = splitIntoChunks(text);
    expect(chunks.length).toBeGreaterThanOrEqual(3);
    expect(chunks[0]?.start).toBe(0);
    let end = 0;
    for (const c of chunks) {
      expect(c.start).toBeLessThanOrEqual(end);
      expect(estimateTokens(c.text)).toBeLessThanOrEqual(CHUNK_MAX_TOKENS);
      end = Math.max(end, c.start + c.text.length);
    }
    expect(end).toBe(text.length);
  });

  it("日本語など1文字が多くのトークンになる本文は、コンテキストに収まるよう小さく分ける", () => {
    const text = "あ".repeat(40_000);
    const chunks = splitIntoChunks(text);
    expect(chunks.length).toBeGreaterThanOrEqual(6);
    for (const c of chunks) expect(estimateTokens(c.text)).toBeLessThanOrEqual(CHUNK_MAX_TOKENS);
    // 絵文字（サロゲートペア）の途中で切らない
    for (const c of splitIntoChunks("😀".repeat(20_000)))
      expect(c.text).not.toMatch(/^[\uDC00-\uDFFF]|[\uD800-\uDBFF]$/);
  });

  it("空の本文は評価しない（呼び出さず complete）", async () => {
    const { ai, run } = fakeAi(() => answers(0));
    const r = await createClefEvaluator({ ai, gatewayId: "gw" }).evaluate("", CTX);
    expect(run).not.toHaveBeenCalled();
    expect(r.complete).toBe(true);
  });

  it("AI.run が失敗したら complete: false と failure を返す（例外は投げない）", async () => {
    const { ai } = fakeAi(() => new Error("boom"));
    const r = await createClefEvaluator({ ai, gatewayId: "gw" }).evaluate("hello", CTX);
    expect(r.complete).toBe(false);
    expect(r.failure).toContain("boom");
  });

  it("一部のチャンクだけ失敗したら complete: false。成功したチャンクのスコアは残す", async () => {
    const text = "a".repeat(60_000);
    const { ai } = fakeAi((_s, call) =>
      call === 0 ? answers(0.01, { role_spoofing: 0.6 }) : new Error("second chunk failed"),
    );
    const r = await createClefEvaluator({ ai, gatewayId: "gw" }).evaluate(text, CTX);
    expect(r.complete).toBe(false);
    expect(r.evaluatedChars).toBeLessThan(r.totalChars);
    expect(r.scores.role_spoofing).toBeCloseTo(0.6);
  });

  it.each([
    ["answers がない", {}],
    ["null", null],
    ["質問の欠落", { answers: { prompt_injection: { noul: 0.1 } } }],
    [
      "確率が数値でない",
      answers(0.1, {}) && {
        answers: Object.fromEntries(CATEGORIES.map((c) => [c, { noul: "high" }])),
      },
    ],
    ["確率が範囲外", { answers: Object.fromEntries(CATEGORIES.map((c) => [c, { noul: 1.5 }])) }],
  ])("想定外のレスポンス（%s）は complete: false にする", async (_name, response) => {
    const { ai } = fakeAi(() => response);
    const r = await createClefEvaluator({ ai, gatewayId: "gw" }).evaluate("hello", CTX);
    expect(r.complete).toBe(false);
  });

  it("sentinel は使わない: 質問は 7 つのカテゴリだけで、本文が目印なしでもそのまま評価できる", async () => {
    const { ai, run } = fakeAi(() => answers(0.01));
    const r = await createClefEvaluator({ ai, gatewayId: "gw" }).evaluate("hello", CTX);
    expect(r.complete).toBe(true);
    const input = (run.mock.calls[0] as RunArgs)[1];
    expect(Object.keys(input.questions)).not.toContain("state_ends_with_marker");
    expect(input.state).toBe("hello");
  });

  it("窓を超えた入力で AI.run が例外を投げたら、評価できていない（unknown。fail-closed）", async () => {
    const { ai } = fakeAi(
      () => new Error("3030: Request requires 28330 tokens; the maximum is 24576"),
    );
    const r = await createClefEvaluator({ ai, gatewayId: "gw" }).evaluate("hello", CTX);
    expect(r.complete).toBe(false);
    expect(r.failure).toContain("ai_run_failed");
    expect(r.evaluatedChars).toBe(0);
  });

  it("usage.input_tokens が窓いっぱいなら切り詰められたとみなす", async () => {
    const { ai } = fakeAi(() => ({ ...answers(0.01), usage: { input_tokens: 24_576 } }));
    const r = await createClefEvaluator({ ai, gatewayId: "gw" }).evaluate("hello", CTX);
    expect(r.complete).toBe(false);
    expect(r.failure).toBe("state_truncated");
    const edge = fakeAi(() => ({
      ...answers(0.01),
      usage: { input_tokens: CLEF_CONTEXT_TOKENS - 65 },
    }));
    expect(
      (await createClefEvaluator({ ai: edge.ai, gatewayId: "gw" }).evaluate("hello", CTX)).complete,
    ).toBe(true);
    const ok = fakeAi(() => ({ ...answers(0.01), usage: { input_tokens: 3_000 } }));
    expect(
      (await createClefEvaluator({ ai: ok.ai, gatewayId: "gw" }).evaluate("hello", CTX)).complete,
    ).toBe(true);
  });

  it("AI_GATEWAY_ID が空なら AI.run を呼ばず、未完了にする（fail-closed）", async () => {
    const { ai, run } = fakeAi(() => answers(0));
    const r = await createClefEvaluator({ ai, gatewayId: "" }).evaluate("hello", CTX);
    expect(run).not.toHaveBeenCalled();
    expect(r.complete).toBe(false);
  });
});

describe("チャンクの大きさと窓", () => {
  // 最悪ケース: トークン数 = UTF-8 のバイト数（1.0 tokens / バイト）。質問の分は実測で約 1,178 トークン（6 問）。
  // 7 問目を足して約 1,350。余裕を見て 1,500 と置く。
  const QUESTION_TOKENS = 1_500;
  it("最悪ケース（1 バイト 1 トークン）でも、チャンク + 質問が窓から usage の検査の余裕（64）を引いた範囲に収まる", () => {
    expect(CHUNK_MAX_TOKENS + QUESTION_TOKENS).toBeLessThan(CLEF_CONTEXT_TOKENS - 64);
    expect(CHUNK_MAX_TOKENS).toBeGreaterThanOrEqual(19_000);
  });
  it("質問の文字数は、実測した約 1,178 トークン（6 問）から大きく外れない（7 問で QUESTION_TOKENS 以内）", () => {
    const bytes = estimateTokens(JSON.stringify(CLEF_QUESTIONS));
    expect(bytes / 4).toBeLessThan(QUESTION_TOKENS);
    // JSON の文字数を 1 バイト 1 トークンとみなしても窓に収まる
    expect(CHUNK_MAX_TOKENS + bytes).toBeLessThan(CLEF_CONTEXT_TOKENS - 64);
  });
});

describe("チャンク数の上限", () => {
  it("上限を超える本文は AI.run を呼ばずに未完了（too_many_chunks）にする", async () => {
    const { ai, run } = fakeAi(() => answers(0.02));
    const ev = createClefEvaluator({ ai, gatewayId: "gw-1" });
    // 3 バイト文字で CHUNK_MAX_TOKENS バイト / チャンクなので、上限を超えるチャンク数になる長さ
    const text = "あ".repeat(Math.ceil(((MAX_EVAL_CHUNKS + 2) * CHUNK_MAX_TOKENS) / 3));
    expect(splitIntoChunks(text).length).toBeGreaterThan(MAX_EVAL_CHUNKS);
    const r = await ev.evaluate(text, CTX);
    expect(r.complete).toBe(false);
    expect(r.failure).toBe("too_many_chunks");
    expect(run).not.toHaveBeenCalled();
  });

  it("上限は、返す本文の最大（50,000 文字）を日本語（3 バイト / 文字）で評価しても足りる", () => {
    const worst = "あ".repeat(50_000 + 20);
    expect(splitIntoChunks(worst).length).toBeLessThanOrEqual(MAX_EVAL_CHUNKS);
    expect(MAX_EVAL_CHUNKS).toBe(20);
  });
});
