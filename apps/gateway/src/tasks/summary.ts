/**
 * タスクの要約レコード（design 11.1 / phase6.md「観測性」「M3 で決めたこと」）。
 *
 * 純粋関数だけを置く（DO にも env にも触らない）。数値と固定コードだけで作り、title・タスクの入力・
 * answer / steer の本文・イベントの本文は入れない。M4 が同じレコードを R2 の summary.json に書く。
 * Sandbox と Web の金額は単価をかけた「推定」で、Claude の金額（AI Gateway の usage に基づく）とは別に持つ。
 */

import {
  DEFAULT_SANDBOX_INSTANCE,
  isSandboxPromotionReason,
  type SandboxInstance,
  type SandboxPromotionReason,
  sandboxUsdPerHour,
} from "@rovo/models";
import {
  type PublicPromotion,
  type PublicPromotionFailure,
  type PublicScaleStats,
  sandboxInstanceName,
  sanitizePromotionFailures,
  sanitizePromotions,
  sanitizeScaleStats,
} from "../sandbox-instance";

/**
 * 単価（USD）。vars で上書きできる。既定値は Cloudflare の公式料金表（取得日 2026-10-19）から取った。出典は phase6.md。
 * - sandboxUsdPerHour: 既定のインスタンス（standard-2。1 vCPU・6 GiB・12 GB）を CPU 100% 稼働で 1 時間動かした上限値（$0.129024 → 切り上げて 0.1291）。
 *   インスタンスごとの単価の表と計算は packages/models（sandboxUsdPerHour）が持つ。月の無料枠は差し引かない（上限側の推定）。
 *   agent の SANDBOX_INSTANCE を変えたら、この var も合わせる（deploy:config は rovo.config.json の sandbox.instance から両方を決める）。
 * - webUsdPer1kSearch: Web Search API の linkup（既定のプロバイダ）$5.00 / 1,000 リクエスト。
 * - webUsdPer1kFetch: web_fetch は Cloudflare 側の課金が無い（Workers のリクエスト以外）ので 0。
 * - webUsdPer1kBrowse: Browser Run の REST API $0.09 / ブラウザ時間 * 1 回の上限 30 秒（gotoOptions.timeout）
 *   = $0.00075 / 回 → $0.75 / 1,000 回（上限側の推定）。
 */
export type PriceTable = {
  sandboxUsdPerHour: number;
  webUsdPer1kSearch: number;
  webUsdPer1kFetch: number;
  webUsdPer1kBrowse: number;
};

export const DEFAULT_PRICES: PriceTable = {
  sandboxUsdPerHour: sandboxUsdPerHour(DEFAULT_SANDBOX_INSTANCE),
  webUsdPer1kSearch: 5,
  webUsdPer1kFetch: 0,
  webUsdPer1kBrowse: 0.75,
};

type PriceVars = {
  SANDBOX_USD_PER_HOUR?: string;
  WEB_USD_PER_1K_SEARCH?: string;
  WEB_USD_PER_1K_FETCH?: string;
  WEB_USD_PER_1K_BROWSE?: string;
};

function price(v: string | undefined, fallback: number): number {
  if (typeof v !== "string" || v.trim() === "") return fallback;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

/** vars から単価を読む。未設定・不正（空・負数・数でない）は既定値。0 は許す。 */
export function parsePrices(vars: PriceVars): PriceTable {
  return {
    sandboxUsdPerHour: price(vars.SANDBOX_USD_PER_HOUR, DEFAULT_PRICES.sandboxUsdPerHour),
    webUsdPer1kSearch: price(vars.WEB_USD_PER_1K_SEARCH, DEFAULT_PRICES.webUsdPer1kSearch),
    webUsdPer1kFetch: price(vars.WEB_USD_PER_1K_FETCH, DEFAULT_PRICES.webUsdPer1kFetch),
    webUsdPer1kBrowse: price(vars.WEB_USD_PER_1K_BROWSE, DEFAULT_PRICES.webUsdPer1kBrowse),
  };
}

export type SummaryInput = {
  taskId: string;
  userId: number;
  repository: string;
  prUrl: string | null;
  /** 終端の状態 */
  status: string;
  /** 終端の reason（固定コードの形のときだけ要約に入る） */
  reason: string | null;
  createdAt: number;
  /** 作成後の遷移（時刻つき、発生順）。CREATING は createdAt から補う */
  transitions: { status: string; at: number }[];
  usage: {
    costMicroUsd: number;
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
    /** 子が使った分だけ */
    web: { search: number; fetch: number; browse: number };
    /** agent が読めなかったタスクは null */
    sandbox: {
      runtimeMs: number;
      restarts: number;
      bootRetries: number;
      /** agent が報告した、最初に起動した大きさ。分かれば、その単価（sandboxUsdPerHour）で推定する */
      instance?: SandboxInstance;
      /** 昇格した最終の大きさ。promotions が無いとき（古い agent）は、昇格前の時間（runtimeMsBeforePromotion）を instance の単価、残りをこの単価で按分する */
      promotedTo?: SandboxInstance;
      /** 最初の昇格の時刻（epoch ms） */
      promotedAt?: number;
      /** 最初の昇格までの Sandbox の累計時間（ms） */
      runtimeMsBeforePromotion?: number;
      /** 昇格を見送った・失敗した理由（固定コード） */
      promotionReason?: SandboxPromotionReason;
      /** 成功した昇格の履歴（公開用の形に検証済みのもの。古い順）。あれば、区間ごとに按分する */
      promotions?: PublicPromotion[];
      /** 古いタスクの記録: 子が上げたあと、規則で重いと判定されたコマンドを実行した本数 */
      heavyCommandsAfterAgentScaleUp?: number;
      /** 古いタスクの記録: そのうち、子が規則の昇格先以上に上げていたために規則が昇格しなくて済んだ本数 */
      heavyCommandsCoveredByAgent?: number;
      /** Clef の判断の集計（Clef を呼んだタスクだけ） */
      scaleStats?: {
        decisions: number;
        raised: number;
        clefFailures: number;
        slowNotRaised: number;
      };
      /** 昇格の試みの見送り・失敗の内訳（固定の trigger と理由コード） */
      promotionFailures?: PublicPromotionFailure[];
    } | null;
  };
  questions: number;
  /** 検証イベントから。一度も無ければ attempts 0・passed null */
  verification: { attempts: number; passed: boolean | null };
  agentErrors: number;
  prices: PriceTable;
};

export type TaskSummary = {
  version: 1;
  task_id: string;
  user_id: number;
  repository: string;
  pr_url: string | null;
  status: string;
  reason: string | null;
  created_at: number;
  ended_at: number;
  duration_ms: number;
  transitions: { status: string; at: number }[];
  usage: {
    cost_usd: number;
    input_tokens: number;
    output_tokens: number;
    cache_read_tokens: number;
    cache_write_tokens: number;
  };
  sandbox: {
    observed: boolean;
    runtime_ms: number;
    restarts: number;
    boot_retries: number;
    /** 最初に起動した大きさ。報告が無い（起動しなかった・古い agent）ときは無い */
    instance?: SandboxInstance;
    /** 昇格した先の大きさ（重いコマンドの初回に大きくした）。昇格していなければ無い */
    promoted_to?: SandboxInstance;
    /** 昇格した時刻（epoch ms） */
    promoted_at?: number;
    /** 昇格した時点までの Sandbox の時間（ms）。runtime_ms のうち、これまでが instance の単価、残りが promoted_to の単価 */
    runtime_ms_before_promotion?: number;
    /** 昇格を見送った・失敗した理由（固定コード）。最後に残したもの */
    promotion_reason?: SandboxPromotionReason;
    /** 成功した昇格の履歴（古い順）。trigger は clef（Clef が上げると判断した）。古いタスクは agent / rule / verification で、rule_match は規則で上がったときだけ。昇格していなければ無い */
    promotions?: PublicPromotion[];
    /** 古いタスクの記録: 子が sandbox_scale_up で上げたあと、規則で重いと判定されたコマンドを実行した本数。今のタスクには付かない */
    heavy_commands_after_agent_scale_up?: number;
    /** 古いタスクの記録: 上の本数のうち、子が規則の昇格先以上に上げていたために規則が昇格しなくて済んだ本数 */
    heavy_commands_covered_by_agent?: number;
    /** Clef の判断の集計（Clef を呼んだタスクだけ）。判断ごとの記録は summary には入れず、task_result の usage.sandbox_scale_log にだけ出す */
    scale?: PublicScaleStats;
    /** 昇格の試みが見送り・失敗になった記録（固定の trigger と理由コード。古い順、最大 8 件）。無ければ無い */
    promotion_failures?: PublicPromotionFailure[];
  };
  /** 昇格したタスクだけ: 大きさごとの区間（その大きさで動かした時間 × 単価）。sandbox_usd_estimate はこの合計 */
  sandbox_segments?: {
    instance: SandboxInstance | null;
    runtime_ms: number;
    usd_per_hour: number;
  }[];
  /** 推定。単価（unit_prices）をかけた値で、タスクの予算には含めない */
  sandbox_usd_estimate: number;
  web: { search: number; fetch: number; browse: number };
  /** 推定。子が使った分だけ。親が MCP から使う分は含まない */
  web_usd_estimate: number;
  unit_prices: {
    sandbox_usd_per_hour: number;
    /** 昇格したタスクだけ: 昇格先の大きさの単価（sandbox_usd_per_hour は昇格前の大きさの単価） */
    sandbox_promoted_usd_per_hour?: number;
    web_usd_per_1k_search: number;
    web_usd_per_1k_fetch: number;
    web_usd_per_1k_browse: number;
  };
  questions: number;
  recoveries: { container_restarts: number; boot_retries: number };
  verification: { attempts: number; passed: boolean | null };
  errors: { agent_errors: number };
};

const CODE_RE = /^[a-z0-9_]{1,64}$/;

/** 0 以上の有限数。それ以外は 0。 */
function nn(v: number): number {
  return Number.isFinite(v) && v > 0 ? v : 0;
}

/** 金額は小数 9 桁で丸める（浮動小数の誤差を出さない） */
function usd(v: number): number {
  return Math.round(nn(v) * 1e9) / 1e9;
}

export function buildTaskSummary(i: SummaryInput): TaskSummary {
  const transitions = [{ status: "CREATING", at: i.createdAt }, ...i.transitions];
  const endedAt = Math.max(i.createdAt, ...i.transitions.map((t) => t.at));
  const sb = i.usage.sandbox;
  const runtimeMs = Math.floor(nn(sb?.runtimeMs ?? 0));
  const web = {
    search: Math.floor(nn(i.usage.web.search)),
    fetch: Math.floor(nn(i.usage.web.fetch)),
    browse: Math.floor(nn(i.usage.web.browse)),
  };
  // 使った大きさが分かればその単価、分からなければ従来の単価（vars の SANDBOX_USD_PER_HOUR か既定）
  const instance = sandboxInstanceName(sb?.instance);
  const p = {
    ...i.prices,
    sandboxUsdPerHour:
      instance !== undefined ? sandboxUsdPerHour(instance) : i.prices.sandboxUsdPerHour,
  };
  // 昇格したタスクは、大きさごとの区間（その大きさで動かした時間）に、その大きさの単価をかけて足す。
  // 履歴（promotions）があればその境界で区間に分け、無ければ（古い agent）最初の昇格の時間だけで 2 区間に分ける。境界は 0〜累計に収め、前の境界より戻さない
  const promotions = sanitizePromotions(sb?.promotions, "snake");
  const promotedTo = sandboxInstanceName(sb?.promotedTo) ?? promotions.at(-1)?.to;
  const startRate = p.sandboxUsdPerHour;
  const legacyBefore = Math.min(runtimeMs, Math.floor(nn(sb?.runtimeMsBeforePromotion ?? 0)));
  const steps: { to: SandboxInstance; before: number }[] =
    promotions.length > 0
      ? promotions.map((x) => ({ to: x.to, before: x.runtime_ms_before }))
      : promotedTo !== undefined
        ? [{ to: promotedTo, before: legacyBefore }]
        : [];
  const segments: { instance: SandboxInstance | null; runtime_ms: number; usd_per_hour: number }[] =
    [];
  let boundary = 0;
  let size: SandboxInstance | null = instance ?? null;
  for (const step of steps) {
    const next = Math.max(boundary, Math.min(runtimeMs, step.before));
    segments.push({
      instance: size,
      runtime_ms: next - boundary,
      usd_per_hour: size !== null ? sandboxUsdPerHour(size) : startRate,
    });
    boundary = next;
    size = step.to;
  }
  segments.push({
    instance: size,
    runtime_ms: runtimeMs - boundary,
    usd_per_hour: size !== null ? sandboxUsdPerHour(size) : startRate,
  });
  // 従来の項目: 最初の昇格までの時間（0〜累計）、最終の大きさの単価
  const beforeMs =
    steps.length > 0 ? Math.max(0, Math.min(runtimeMs, steps[0]?.before ?? 0)) : runtimeMs;
  const promotedRate = promotedTo !== undefined ? sandboxUsdPerHour(promotedTo) : undefined;
  const promotedAt = Math.floor(nn(sb?.promotedAt ?? 0));
  const heavyAfterAgent =
    typeof sb?.heavyCommandsAfterAgentScaleUp === "number"
      ? Math.floor(nn(sb.heavyCommandsAfterAgentScaleUp))
      : undefined;
  const coveredByAgent =
    typeof sb?.heavyCommandsCoveredByAgent === "number"
      ? Math.floor(nn(sb.heavyCommandsCoveredByAgent))
      : undefined;
  const promotionFailures = sanitizePromotionFailures(sb?.promotionFailures);
  const scale = sanitizeScaleStats(sb?.scaleStats);
  const promotionReason = isSandboxPromotionReason(sb?.promotionReason)
    ? sb?.promotionReason
    : undefined;
  return {
    version: 1,
    task_id: i.taskId,
    user_id: i.userId,
    repository: i.repository,
    pr_url: i.prUrl,
    status: i.status,
    reason: i.reason !== null && CODE_RE.test(i.reason) ? i.reason : null,
    created_at: i.createdAt,
    ended_at: endedAt,
    duration_ms: Math.max(0, endedAt - i.createdAt),
    transitions,
    usage: {
      cost_usd: nn(i.usage.costMicroUsd) / 1_000_000,
      input_tokens: nn(i.usage.inputTokens),
      output_tokens: nn(i.usage.outputTokens),
      cache_read_tokens: nn(i.usage.cacheReadTokens),
      cache_write_tokens: nn(i.usage.cacheWriteTokens),
    },
    sandbox: {
      observed: sb !== null,
      runtime_ms: runtimeMs,
      restarts: Math.floor(nn(sb?.restarts ?? 0)),
      boot_retries: Math.floor(nn(sb?.bootRetries ?? 0)),
      ...(instance !== undefined ? { instance } : {}),
      ...(promotedTo !== undefined
        ? {
            promoted_to: promotedTo,
            ...(promotedAt > 0 ? { promoted_at: promotedAt } : {}),
            runtime_ms_before_promotion: beforeMs,
          }
        : {}),
      ...(promotionReason !== undefined ? { promotion_reason: promotionReason } : {}),
      ...(promotions.length > 0 ? { promotions } : {}),
      ...(heavyAfterAgent !== undefined
        ? { heavy_commands_after_agent_scale_up: heavyAfterAgent }
        : {}),
      ...(coveredByAgent !== undefined ? { heavy_commands_covered_by_agent: coveredByAgent } : {}),
      ...(promotionFailures.length > 0 ? { promotion_failures: promotionFailures } : {}),
      ...(scale !== undefined ? { scale } : {}),
    },
    ...(steps.length > 0 ? { sandbox_segments: segments } : {}),
    sandbox_usd_estimate: usd(
      segments.reduce((sum, seg) => sum + (seg.runtime_ms / 3_600_000) * seg.usd_per_hour, 0),
    ),
    web,
    web_usd_estimate: usd(
      (web.search / 1000) * p.webUsdPer1kSearch +
        (web.fetch / 1000) * p.webUsdPer1kFetch +
        (web.browse / 1000) * p.webUsdPer1kBrowse,
    ),
    unit_prices: {
      sandbox_usd_per_hour: p.sandboxUsdPerHour,
      ...(promotedRate !== undefined ? { sandbox_promoted_usd_per_hour: promotedRate } : {}),
      web_usd_per_1k_search: p.webUsdPer1kSearch,
      web_usd_per_1k_fetch: p.webUsdPer1kFetch,
      web_usd_per_1k_browse: p.webUsdPer1kBrowse,
    },
    questions: Math.floor(nn(i.questions)),
    recoveries: {
      container_restarts: Math.floor(nn(sb?.restarts ?? 0)),
      boot_retries: Math.floor(nn(sb?.bootRetries ?? 0)),
    },
    verification: {
      attempts: Math.floor(nn(i.verification.attempts)),
      passed: i.verification.passed,
    },
    errors: { agent_errors: Math.floor(nn(i.agentErrors)) },
  };
}

/** 監査ログの task_summary 行に載せる、数値だけの平らな項目（キーは @rovo/audit の TASK_SUMMARY_METRICS）。 */
export function summaryMetrics(s: TaskSummary): Record<string, number> {
  const m: Record<string, number> = {
    duration_ms: s.duration_ms,
    transitions: s.transitions.length,
    claude_usd: s.usage.cost_usd,
    input_tokens: s.usage.input_tokens,
    output_tokens: s.usage.output_tokens,
    cache_read_tokens: s.usage.cache_read_tokens,
    cache_write_tokens: s.usage.cache_write_tokens,
    sandbox_runtime_ms: s.sandbox.runtime_ms,
    sandbox_restarts: s.sandbox.restarts,
    sandbox_boot_retries: s.sandbox.boot_retries,
    sandbox_usd_estimate: s.sandbox_usd_estimate,
    web_search: s.web.search,
    web_fetch: s.web.fetch,
    web_browse: s.web.browse,
    web_usd_estimate: s.web_usd_estimate,
    questions: s.questions,
    verification_attempts: s.verification.attempts,
    agent_errors: s.errors.agent_errors,
  };
  if (s.verification.passed !== null) m.verification_passed = s.verification.passed ? 1 : 0;
  return m;
}

/**
 * 子の usage イベントの公開 payload から、累計の数値だけを覚えておくための形（agent_link.usage_public に JSON で持つ）。
 * どの項目も累計で単調に増えるので、新しい値と覚えている値の大きい方を取る（順序の入れ替わりや、古い値の再送で下がらない）。
 */
export const USAGE_PUBLIC_KEYS = [
  "input_tokens",
  "output_tokens",
  "cache_read_tokens",
  "cache_write_tokens",
  "web_search",
  "web_fetch",
  "web_browse",
  "sandbox_runtime_ms",
  "sandbox_restarts",
  "sandbox_boot_retries",
  "sandbox_promoted_at",
  "sandbox_runtime_ms_before_promotion",
  "sandbox_heavy_commands_after_agent_scale_up",
  "sandbox_heavy_commands_covered_by_agent",
  "sandbox_scale_decisions",
  "sandbox_scale_raised",
  "sandbox_scale_clef_failures",
  "sandbox_scale_slow_not_raised",
] as const;

export type UsagePublic = Partial<Record<(typeof USAGE_PUBLIC_KEYS)[number], number>> & {
  /** 実際に起動した大きさ（表にある名前だけ。数値ではないので単調増加の対象外で、最後に報告された値を覚える） */
  sandbox_instance?: SandboxInstance;
  /** 昇格した先の大きさ（表にある名前だけ。最後に報告された値を覚える） */
  sandbox_promoted_to?: SandboxInstance;
  /** 昇格を見送った・失敗した理由（固定コードだけ。最後に報告された値を覚える） */
  sandbox_promotion_reason?: SandboxPromotionReason;
  /** 成功した昇格の履歴（固定の値だけに検証したもの。昇格は増えるだけなので、長い方を覚える） */
  sandbox_promotions?: PublicPromotion[];
  /** 昇格の見送り・失敗の内訳（固定の trigger と理由コードだけに検証したもの。増えるだけなので、長い方を覚える） */
  sandbox_promotion_failures?: PublicPromotionFailure[];
};

export function parseUsagePublic(json: string | null | undefined): UsagePublic {
  try {
    const v: unknown = JSON.parse(json ?? "{}");
    if (typeof v !== "object" || v === null || Array.isArray(v)) return {};
    const out: UsagePublic = {};
    for (const k of USAGE_PUBLIC_KEYS) {
      const n = (v as Record<string, unknown>)[k];
      if (typeof n === "number" && Number.isFinite(n) && n >= 0) out[k] = n;
    }
    const instance = sandboxInstanceName((v as Record<string, unknown>).sandbox_instance);
    if (instance !== undefined) out.sandbox_instance = instance;
    const promotedTo = sandboxInstanceName((v as Record<string, unknown>).sandbox_promoted_to);
    if (promotedTo !== undefined) out.sandbox_promoted_to = promotedTo;
    const reason = (v as Record<string, unknown>).sandbox_promotion_reason;
    if (isSandboxPromotionReason(reason)) out.sandbox_promotion_reason = reason;
    const promotions = sanitizePromotions(
      (v as Record<string, unknown>).sandbox_promotions,
      "snake",
    );
    if (promotions.length > 0) out.sandbox_promotions = promotions;
    const failures = sanitizePromotionFailures(
      (v as Record<string, unknown>).sandbox_promotion_failures,
    );
    if (failures.length > 0) out.sandbox_promotion_failures = failures;
    return out;
  } catch {
    return {};
  }
}

/** usage イベントの sandbox_promotion_failures（JSON 文字列）を、検証した配列にする。壊れていれば空 */
function parseFailuresPayload(v: unknown): PublicPromotionFailure[] {
  if (typeof v !== "string") return [];
  try {
    return sanitizePromotionFailures(JSON.parse(v));
  } catch {
    return [];
  }
}

/** usage イベントの sandbox_promotions（JSON 文字列）を、検証した履歴の配列にする。壊れていれば空 */
function parsePromotionsPayload(v: unknown): PublicPromotion[] {
  if (typeof v !== "string") return [];
  try {
    return sanitizePromotions(JSON.parse(v), "snake");
  } catch {
    return [];
  }
}

export function mergeUsagePublic(
  prev: UsagePublic,
  payload: Record<string, string | number | boolean | null>,
): UsagePublic {
  const out: UsagePublic = { ...prev };
  for (const k of USAGE_PUBLIC_KEYS) {
    const n = payload[k];
    if (typeof n !== "number" || !Number.isFinite(n) || n < 0) continue;
    out[k] = Math.max(out[k] ?? 0, n);
  }
  // 後から大きさの無い usage が届いても、報告済みの大きさは忘れない
  const instance = sandboxInstanceName(payload.sandbox_instance);
  if (instance !== undefined) out.sandbox_instance = instance;
  const promotedTo = sandboxInstanceName(payload.sandbox_promoted_to);
  if (promotedTo !== undefined) out.sandbox_promoted_to = promotedTo;
  if (isSandboxPromotionReason(payload.sandbox_promotion_reason)) {
    out.sandbox_promotion_reason = payload.sandbox_promotion_reason;
  }
  // 履歴は JSON 文字列で届く（payload はプリミティブだけ）。検証して、長い方（新しい方）を覚える
  const incoming = parsePromotionsPayload(payload.sandbox_promotions);
  if (incoming.length > (out.sandbox_promotions?.length ?? 0)) out.sandbox_promotions = incoming;
  const failures = parseFailuresPayload(payload.sandbox_promotion_failures);
  if (failures.length > (out.sandbox_promotion_failures?.length ?? 0)) {
    out.sandbox_promotion_failures = failures;
  }
  return out;
}
