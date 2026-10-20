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

/** クレジット残高は残高だけ */
export const CreditBalanceValueSchema = z.strictObject({
  balance_usd: z.number().min(0).max(1e12),
});

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
});
export type CloudflareSummaryDto = z.infer<typeof CloudflareSummaryDtoSchema>;
