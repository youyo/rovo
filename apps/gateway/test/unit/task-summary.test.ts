import { DEFAULT_SANDBOX_INSTANCE, sandboxUsdPerHour } from "@rovo/models";
import { describe, expect, it } from "vitest";
import {
  buildTaskSummary,
  DEFAULT_PRICES,
  mergeUsagePublic,
  parsePrices,
  parseUsagePublic,
  type SummaryInput,
  summaryMetrics,
} from "../../src/tasks/summary";

const input = (over: Partial<SummaryInput> = {}): SummaryInput => ({
  taskId: "01TASK",
  userId: 42,
  repository: "acme/widgets",
  prUrl: "https://github.com/acme/widgets/pull/7",
  status: "COMPLETED",
  reason: null,
  createdAt: 1_000,
  transitions: [
    { status: "RUNNING", at: 1_500 },
    { status: "VERIFYING", at: 5_000 },
    { status: "COMPLETED", at: 7_000 },
  ],
  usage: {
    costMicroUsd: 1_234_567,
    inputTokens: 100,
    outputTokens: 50,
    cacheReadTokens: 10,
    cacheWriteTokens: 5,
    web: { search: 4, fetch: 10, browse: 2 },
    sandbox: { runtimeMs: 3_600_000, restarts: 1, bootRetries: 2 },
  },
  questions: 3,
  verification: { attempts: 2, passed: true },
  agentErrors: 1,
  prices: DEFAULT_PRICES,
  ...over,
});

describe("buildTaskSummary", () => {
  it("状態遷移（時刻つき）・実行時間・使用量・Sandbox・Web・質問・検証を入れる", () => {
    const s = buildTaskSummary(input());
    expect(s).toMatchObject({
      version: 1,
      task_id: "01TASK",
      user_id: 42,
      repository: "acme/widgets",
      pr_url: "https://github.com/acme/widgets/pull/7",
      status: "COMPLETED",
      reason: null,
      created_at: 1_000,
      ended_at: 7_000,
      duration_ms: 6_000,
      transitions: [
        { status: "CREATING", at: 1_000 },
        { status: "RUNNING", at: 1_500 },
        { status: "VERIFYING", at: 5_000 },
        { status: "COMPLETED", at: 7_000 },
      ],
      usage: {
        cost_usd: 1.234567,
        input_tokens: 100,
        output_tokens: 50,
        cache_read_tokens: 10,
        cache_write_tokens: 5,
      },
      sandbox: { observed: true, runtime_ms: 3_600_000, restarts: 1, boot_retries: 2 },
      web: { search: 4, fetch: 10, browse: 2 },
      questions: 3,
      recoveries: { container_restarts: 1, boot_retries: 2 },
      verification: { attempts: 2, passed: true },
      errors: { agent_errors: 1 },
    });
  });

  it("title・タスクの入力・本文に相当するキーを持たない", () => {
    const text = JSON.stringify(buildTaskSummary(input()));
    expect(text).not.toMatch(/title|instructions|acceptance|constraints|message|answer|steer/i);
  });

  it("金額は『推定』と分かる名前で、Claude の金額とは別に入れる", () => {
    const s = buildTaskSummary(
      input({
        prices: {
          sandboxUsdPerHour: 0.5,
          webUsdPer1kSearch: 10,
          webUsdPer1kFetch: 2,
          webUsdPer1kBrowse: 100,
        },
      }),
    );
    // sandbox: 1 時間 * 0.5
    expect(s.sandbox_usd_estimate).toBeCloseTo(0.5, 9);
    // web: 4/1000*10 + 10/1000*2 + 2/1000*100 = 0.04 + 0.02 + 0.2
    expect(s.web_usd_estimate).toBeCloseTo(0.26, 9);
    expect(s.usage.cost_usd).toBe(1.234567);
    expect(s.unit_prices).toEqual({
      sandbox_usd_per_hour: 0.5,
      web_usd_per_1k_search: 10,
      web_usd_per_1k_fetch: 2,
      web_usd_per_1k_browse: 100,
    });
    expect(Object.keys(s)).not.toContain("sandbox_usd");
    expect(Object.keys(s)).not.toContain("web_usd");
  });

  it("sandbox が観測できなかったタスクは observed:false で 0 にし、金額も 0", () => {
    const s = buildTaskSummary(input({ usage: { ...input().usage, sandbox: null } }));
    expect(s.sandbox).toEqual({ observed: false, runtime_ms: 0, restarts: 0, boot_retries: 0 });
    expect(s.sandbox_usd_estimate).toBe(0);
  });

  it("reason は固定コードの形のときだけ入れる（自由な文は null）", () => {
    expect(buildTaskSummary(input({ status: "FAILED", reason: "deadline" })).reason).toBe(
      "deadline",
    );
    expect(
      buildTaskSummary(input({ status: "FAILED", reason: "tests failed: boom ghs_x" })).reason,
    ).toBeNull();
    expect(
      buildTaskSummary(input({ status: "FAILED", reason: "x".repeat(100) })).reason,
    ).toBeNull();
  });

  it("検証が一度も無いタスクは attempts 0・passed null", () => {
    const s = buildTaskSummary(input({ verification: { attempts: 0, passed: null } }));
    expect(s.verification).toEqual({ attempts: 0, passed: null });
  });

  it("負数・NaN の入力は 0 に丸め、duration は負にならない", () => {
    const s = buildTaskSummary(
      input({
        createdAt: 9_000,
        transitions: [{ status: "CANCELLED", at: 8_000 }],
        usage: {
          ...input().usage,
          inputTokens: -1,
          web: { search: Number.NaN, fetch: 0, browse: 0 },
        },
      }),
    );
    expect(s.duration_ms).toBe(0);
    expect(s.usage.input_tokens).toBe(0);
    expect(s.web.search).toBe(0);
  });
});

describe("parsePrices（単価。vars の既定値を下流が上書きできる）", () => {
  it("Sandbox の既定の単価は、既定のインスタンス（standard-2）の上限側の単価（packages/models が 1 か所で決める）", () => {
    expect(DEFAULT_PRICES.sandboxUsdPerHour).toBe(0.1291);
    expect(DEFAULT_PRICES.sandboxUsdPerHour).toBe(sandboxUsdPerHour(DEFAULT_SANDBOX_INSTANCE));
  });

  it("未設定・不正な値は既定値、正しい値は上書きになる。0 は許す（無料）", () => {
    expect(parsePrices({})).toEqual(DEFAULT_PRICES);
    expect(
      parsePrices({
        SANDBOX_USD_PER_HOUR: "abc",
        WEB_USD_PER_1K_SEARCH: "-1",
        WEB_USD_PER_1K_FETCH: "",
        WEB_USD_PER_1K_BROWSE: "Infinity",
      }),
    ).toEqual(DEFAULT_PRICES);
    expect(
      parsePrices({
        SANDBOX_USD_PER_HOUR: "1.5",
        WEB_USD_PER_1K_SEARCH: "7",
        WEB_USD_PER_1K_FETCH: "0",
        WEB_USD_PER_1K_BROWSE: "2.5",
      }),
    ).toEqual({
      sandboxUsdPerHour: 1.5,
      webUsdPer1kSearch: 7,
      webUsdPer1kFetch: 0,
      webUsdPer1kBrowse: 2.5,
    });
  });
});

describe("summaryMetrics（監査ログの task_summary 用。数値だけ）", () => {
  it("数値だけの平らな項目にする", () => {
    const m = summaryMetrics(buildTaskSummary(input()));
    expect(m).toMatchObject({
      duration_ms: 6_000,
      transitions: 4,
      claude_usd: 1.234567,
      input_tokens: 100,
      sandbox_runtime_ms: 3_600_000,
      sandbox_restarts: 1,
      sandbox_boot_retries: 2,
      web_search: 4,
      web_fetch: 10,
      web_browse: 2,
      questions: 3,
      verification_attempts: 2,
      verification_passed: 1,
      agent_errors: 1,
    });
    for (const v of Object.values(m)) expect(typeof v).toBe("number");
  });

  it("検証の結果が未知なら verification_passed を入れない", () => {
    const m = summaryMetrics(
      buildTaskSummary(input({ verification: { attempts: 0, passed: null } })),
    );
    expect(m).not.toHaveProperty("verification_passed");
  });
});

describe("Sandbox の大きさごとの単価（sandbox_usd_estimate）", () => {
  const withInstance = (instance: string | undefined, runtimeMs = 3_600_000) =>
    input({
      usage: {
        ...input().usage,
        sandbox: { runtimeMs, restarts: 0, bootRetries: 0, ...(instance ? { instance } : {}) },
      } as SummaryInput["usage"],
    });

  it("使った大きさの単価（sandboxUsdPerHour）で計算し、summary に大きさと使った単価を残す", () => {
    for (const name of ["standard-1", "standard-3", "standard-4"] as const) {
      const s = buildTaskSummary(withInstance(name));
      expect(s.sandbox_usd_estimate, name).toBeCloseTo(sandboxUsdPerHour(name), 9);
      expect(s.unit_prices.sandbox_usd_per_hour, name).toBe(sandboxUsdPerHour(name));
      expect(s.sandbox, name).toMatchObject({ instance: name });
    }
  });

  it("大きさが分からない（未報告・表に無い名前）ときは、従来どおり prices の単価", () => {
    const prices = { ...DEFAULT_PRICES, sandboxUsdPerHour: 3.6 };
    for (const instance of [undefined, "unknown-9"]) {
      const s = buildTaskSummary({ ...withInstance(instance), prices });
      expect(s.sandbox_usd_estimate).toBeCloseTo(3.6, 9);
      expect(s.unit_prices.sandbox_usd_per_hour).toBe(3.6);
      expect(s.sandbox).not.toHaveProperty("instance");
    }
  });
});

describe("Sandbox の昇格と費用の按分（sandbox_usd_estimate）", () => {
  const HOUR = 3_600_000;
  const promoted = (over: Record<string, unknown> = {}) =>
    input({
      usage: {
        ...input().usage,
        sandbox: {
          runtimeMs: HOUR,
          restarts: 0,
          bootRetries: 0,
          instance: "standard-2",
          promotedTo: "standard-3",
          promotedAt: 1_700_000_000_000,
          runtimeMsBeforePromotion: HOUR / 4,
          ...over,
        },
      } as SummaryInput["usage"],
    });

  it("昇格前の時間は元の大きさの単価、昇格後の時間は昇格先の単価で按分する", () => {
    const s = buildTaskSummary(promoted());
    const expected =
      0.25 * sandboxUsdPerHour("standard-2") + 0.75 * sandboxUsdPerHour("standard-3");
    expect(s.sandbox_usd_estimate).toBeCloseTo(expected, 9);
    expect(s.sandbox).toMatchObject({
      instance: "standard-2",
      promoted_to: "standard-3",
      promoted_at: 1_700_000_000_000,
      runtime_ms_before_promotion: HOUR / 4,
    });
    expect(s.unit_prices.sandbox_usd_per_hour).toBe(sandboxUsdPerHour("standard-2"));
    expect(s.unit_prices.sandbox_promoted_usd_per_hour).toBe(sandboxUsdPerHour("standard-3"));
  });

  it("昇格前の時間が累計を超える・負・壊れた値のときは 0 〜 累計に収める（多く数えすぎない）", () => {
    const over = buildTaskSummary(promoted({ runtimeMsBeforePromotion: 10 * HOUR }));
    expect(over.sandbox_usd_estimate).toBeCloseTo(sandboxUsdPerHour("standard-2"), 9);
    expect(over.sandbox.runtime_ms_before_promotion).toBe(HOUR);
    for (const bad of [-5, Number.NaN, undefined]) {
      const s = buildTaskSummary(promoted({ runtimeMsBeforePromotion: bad }));
      expect(s.sandbox_usd_estimate).toBeCloseTo(sandboxUsdPerHour("standard-3"), 9);
      expect(s.sandbox.runtime_ms_before_promotion).toBe(0);
    }
  });

  it("昇格していなければ、今までどおり 1 つの単価。昇格に関する項目は付けない", () => {
    const s = buildTaskSummary(promoted({ promotedTo: undefined }));
    expect(s.sandbox_usd_estimate).toBeCloseTo(sandboxUsdPerHour("standard-2"), 9);
    expect(s.sandbox).not.toHaveProperty("promoted_to");
    expect(s.sandbox).not.toHaveProperty("runtime_ms_before_promotion");
    expect(s.unit_prices).not.toHaveProperty("sandbox_promoted_usd_per_hour");
  });

  it("表に無い昇格先は無視する（昇格していないものとして扱う）", () => {
    const s = buildTaskSummary(promoted({ promotedTo: "evil" }));
    expect(s.sandbox_usd_estimate).toBeCloseTo(sandboxUsdPerHour("standard-2"), 9);
    expect(s.sandbox).not.toHaveProperty("promoted_to");
  });

  it("元の大きさが分からない（古い agent）が昇格している場合、昇格前は prices の単価で按分する", () => {
    const prices = { ...DEFAULT_PRICES, sandboxUsdPerHour: 3.6 };
    const s = buildTaskSummary({ ...promoted({ instance: undefined }), prices });
    expect(s.sandbox_usd_estimate).toBeCloseTo(
      0.25 * 3.6 + 0.75 * sandboxUsdPerHour("standard-3"),
      9,
    );
  });

  it("見送りの理由は固定コードだけ summary に残す", () => {
    const s = buildTaskSummary(
      promoted({ promotedTo: undefined, promotionReason: "snapshot_unsupported" }),
    );
    expect(s.sandbox).toMatchObject({ promotion_reason: "snapshot_unsupported" });
    const bad = buildTaskSummary(promoted({ promotedTo: undefined, promotionReason: "evil" }));
    expect(bad.sandbox).not.toHaveProperty("promotion_reason");
  });
});

describe("usage_public に昇格の項目を覚える", () => {
  it("merge: 最後に報告された昇格先・理由を覚える。後から項目の無い usage が届いても忘れない", () => {
    let up = mergeUsagePublic(
      {},
      {
        sandbox_runtime_ms: 100,
        sandbox_instance: "standard-2",
        sandbox_promoted_to: "standard-3",
        sandbox_promoted_at: 1_700_000_000_000,
        sandbox_runtime_ms_before_promotion: 40,
        sandbox_promotion_reason: "start_failed",
      },
    );
    up = mergeUsagePublic(up, { sandbox_runtime_ms: 200 });
    expect(up).toMatchObject({
      sandbox_promoted_to: "standard-3",
      sandbox_promoted_at: 1_700_000_000_000,
      sandbox_runtime_ms_before_promotion: 40,
      sandbox_promotion_reason: "start_failed",
    });
    expect(parseUsagePublic(JSON.stringify(up))).toEqual(up);
  });

  it("parse: 表に無い値は捨てる", () => {
    const up = parseUsagePublic(
      JSON.stringify({ sandbox_promoted_to: "evil", sandbox_promotion_reason: "x".repeat(300) }),
    );
    expect(up).not.toHaveProperty("sandbox_promoted_to");
    expect(up).not.toHaveProperty("sandbox_promotion_reason");
  });
});
