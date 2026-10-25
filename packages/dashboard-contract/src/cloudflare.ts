import { z } from "zod";
import { countSchema, isoTimeSchema, periodSchema, usdSchema } from "./primitives";

/** 取得できない理由（固定の値。上流のエラー本文は通さない） */
export const CLOUDFLARE_REASONS = ["forbidden", "unavailable", "not_configured", "empty"] as const;

/** 項目ごとの結果: 取れたら `{ok:true,value}`、取れなければ `{ok:false,reason}`（画面は「取得できない」と出す） */
const item = <T extends z.ZodType>(value: T) =>
  z.discriminatedUnion("ok", [
    z.strictObject({ ok: z.literal(true), value }),
    z.strictObject({ ok: z.literal(false), reason: z.enum(CLOUDFLARE_REASONS) }),
  ]);

/** コンテナの稼働（containersMetricsAdaptiveGroups の集計） */
export const ContainersValueSchema = z.strictObject({
  period: periodSchema,
  running_instances: countSchema,
  vcpu_seconds: z.number().min(0).max(1e15),
  memory_gib_seconds: z.number().min(0).max(1e15),
});

/** AI Gateway の集計。prompt / body は持たない */
export const AiGatewayValueSchema = z.strictObject({
  period: periodSchema,
  requests: countSchema,
  cached_requests: countSchema,
  errors: countSchema,
  cost_usd: usdSchema,
});

/** Workers のリクエスト数（workersInvocationsAdaptive。rovo の 3 つの Worker の合計） */
export const WorkersValueSchema = z.strictObject({
  period: periodSchema,
  requests: countSchema,
  errors: countSchema,
});

/** Workers AI の利用（aiInferenceAdaptiveGroups の neurons の合計） */
export const WorkersAiValueSchema = z.strictObject({
  period: periodSchema,
  neurons: z.number().min(0).max(1e15),
});

/** 集計の期間（クライアントが選べるのはこの 4 つだけ）。month は UTC の月初から今まで（予算の欄の月と同じ） */
export const CLOUDFLARE_RANGES = ["1h", "24h", "7d", "month"] as const;
export const cloudflareRangeSchema = z.enum(CLOUDFLARE_RANGES);

/** クレジット残高は残高だけ */
export const CreditBalanceValueSchema = z.strictObject({
  balance_usd: z.number().min(0).max(1e12),
});

/** 推定の単位（単価はこの 1 単位あたりの USD） */
export const CLOUDFLARE_COST_UNITS = [
  "request",
  "vcpu_second",
  "gib_second",
  "gb_second",
  "neuron",
] as const;

/** 推定の対象の項目。合計に含まれなかった項目（`excluded_items`）の名前にも使う */
export const CLOUDFLARE_COST_ITEMS = [
  "workers_requests",
  "containers_vcpu",
  "containers_memory",
  "containers_disk",
  "workers_ai",
  "ai_gateway",
] as const;

/**
 * 推定の 1 項目（公開の単価 × 使用量）。**無料枠・プランに含まれる分を引く前**の金額で、請求額ではない（上限側の推定）。
 * 使用量が取れない項目は quantity・estimated_usd_before_free_tier とも null。
 */
export const CloudflareCostLineSchema = z.strictObject({
  quantity: z.number().min(0).max(1e15).nullable().describe("使用量（取得できなければ null）"),
  unit: z.enum(CLOUDFLARE_COST_UNITS).describe("quantity の単位"),
  unit_price_usd: z.number().min(0).max(1e6).describe("1 単位あたりの単価（USD。公開の単価）"),
  estimated_usd_before_free_tier: usdSchema
    .nullable()
    .describe(
      "単価 × 使用量。無料枠・プランに含まれる分を引く前の推定（USD）。取得できなければ null",
    ),
});

/**
 * 推定の金額（USD）。**Cloudflare の請求の推定**: Workers のリクエスト・コンテナの vCPU 秒 / メモリ GiB 秒 / ディスク・
 * Workers AI の Neuron の **単価 × 使用量**。合計（`total_estimated_usd_before_free_tier`）もこの項目だけの和。
 * AI Gateway の費用（`items.ai_gateway.cost_usd`）は BYOK のモデル費用（Anthropic などに請求され、rovo の予算に含まれる）で、
 * Cloudflare の請求ではないので合計に含めない。無料枠・プランに含まれる分は引かない。
 * 取得できない項目の推定は null で、合計に含まれない（`excluded_items` に出る）。
 */
export const CloudflareCostEstimateSchema = z.strictObject({
  basis: z
    .literal("before_free_tier")
    .describe("無料枠・プランに含まれる分を引く前の推定（請求額ではない）"),
  pricing_checked_at: z.iso
    .date()
    .nullable()
    .describe("単価を公式のページで確認した日（YYYY-MM-DD）。未確認は null"),
  items: z.strictObject({
    workers_requests: CloudflareCostLineSchema,
    containers_vcpu: CloudflareCostLineSchema,
    containers_memory: CloudflareCostLineSchema,
    containers_disk: CloudflareCostLineSchema,
    workers_ai: CloudflareCostLineSchema,
    // 合計に含まない別の項目（BYOK のモデル費用。Cloudflare の請求ではない）
    ai_gateway: z.strictObject({
      cost_usd: usdSchema
        .nullable()
        .describe(
          "AI Gateway の費用（BYOK のモデル費用。Anthropic などに請求され、rovo の予算に含まれる。Cloudflare の請求ではないので合計に含まない。単価 × 使用量ではなく集計値）。取得できなければ null",
        ),
    }),
  }),
  total_estimated_usd_before_free_tier: usdSchema
    .nullable()
    .describe(
      "Cloudflare の請求の推定の合計（取れた Workers・コンテナ・Workers AI の和。AI Gateway とクレジット残高は含まない）。無料枠を引く前。含まれない項目は excluded_items。1 つも取れなければ null",
    ),
  excluded_items: z
    .array(z.enum(CLOUDFLARE_COST_ITEMS))
    .max(CLOUDFLARE_COST_ITEMS.length)
    .describe(
      "取得できず、合計に含まれていない項目（Cloudflare の請求の項目だけ。AI Gateway は含まない。ai_gateway は古い応答との互換のために列挙に残す）",
    ),
  partial: z
    .boolean()
    .describe("excluded_items がある（Cloudflare の請求の合計が一部の項目だけ）なら true"),
});
export type CloudflareCostEstimateDto = z.infer<typeof CloudflareCostEstimateSchema>;

/** Cloudflare のダッシュボードを開くリンク（https://dash.cloudflare.com/ 配下だけ） */
export const cloudflareOpenUrlSchema = z
  .string()
  .max(300)
  .regex(/^https:\/\/dash\.cloudflare\.com\/[A-Za-z0-9._~/-]*$/);

/** `GET /dashboard/api/cloudflare`。サーバー側で固定した集計だけ（任意の GraphQL の結果は出さない） */
export const CloudflareSummaryDtoSchema = z.strictObject({
  generated_at: isoTimeSchema,
  open_url: cloudflareOpenUrlSchema.nullable(),
  containers: item(ContainersValueSchema),
  ai_gateway: item(AiGatewayValueSchema),
  credit_balance: item(CreditBalanceValueSchema),
  // M9 で追加（optional: 既存の fixtures・画面を壊さない。gateway は常に出す）
  range: cloudflareRangeSchema.optional(),
  workers: item(WorkersValueSchema).optional(),
  workers_ai: item(WorkersAiValueSchema).optional(),
  // 推定の金額（無料枠を引く前）。optional: 古い gateway・古い応答・fixtures を壊さない
  cost_estimate: CloudflareCostEstimateSchema.optional(),
});
export type CloudflareSummaryDto = z.infer<typeof CloudflareSummaryDtoSchema>;
