import type { CloudflareCostEstimateDto } from "@rovo/dashboard-contract";

/**
 * Cloudflare の公開の単価と、推定の金額（docs/specs/dashboard.md M9 / D13）。
 *
 * **単価はこのファイルの定数だけに置く**（`cloudflare.ts` や画面に数値を書かない）。単価が変わったら、ここの数値・
 * 出典・確認日を一緒に更新する。
 *
 * 推定の出し方:
 * - 項目ごとに「単価 × 使用量」。使用量は GraphQL Analytics API の集計（`cloudflare.ts`）
 * - **無料枠・プランに含まれる分（Workers Paid の月 1,000 万リクエスト、Containers の月 25 GiB 時間 / 375 vCPU 分 /
 *   200 GB 時間、Workers AI の 1 日 1 万 Neurons）は引かない**。月額（$5）も足さない。期間（1h / 24h / 7d）を
 *   月や日に按分もしない。つまり「無料枠を引く前の推定」で、請求額ではない（上限側）
 * - 合計は、**Cloudflare に払う分**（Workers のリクエスト・コンテナの vCPU・メモリ・ディスク・Workers AI）の、取れた項目の和。
 *   **AI Gateway の費用は合計に含めない**（BYOK のモデルの費用は Anthropic などに払い、Cloudflare の請求ではない）。
 *   AI Gateway の費用は `items.ai_gateway.cost_usd` の別の項目として返す。取れなかった項目は推定を null にして合計に含めず、
 *   `excluded_items` に名前を出す。`excluded_items` と `partial` は Cloudflare の項目だけで判定する（AI Gateway は含めない）
 * - 対象は Workers の**リクエストだけ**（CPU 時間・Durable Objects・KV・D1・R2・Workers Logs・コンテナの egress などは
 *   含めない）。コンテナのディスクは使用量を取っていないので、いまは常に null（合計に含まれない）
 * - コンテナの vCPU は「割り当て（allocatedCpu）」の秒数で、Cloudflare の課金は vCPU を実使用（active usage）、
 *   メモリ・ディスクを割り当てで数えるため、vCPU は上限側にずれる
 *
 * 出典（Cloudflare の公式ドキュメント）と確認日:
 * - Workers: https://developers.cloudflare.com/workers/platform/pricing/
 *   Standard: 月 1,000 万リクエスト込み、以降 $0.30 / 100 万リクエスト（= $0.0000003 / リクエスト）
 * - Containers: https://developers.cloudflare.com/containers/platform/pricing/
 *   Workers Paid: メモリ $0.0000025 / GiB 秒、CPU $0.000020 / vCPU 秒、ディスク $0.00000007 / GB 秒
 * - Workers AI: https://developers.cloudflare.com/workers-ai/platform/pricing/
 *   $0.011 / 1,000 Neurons（= $0.000011 / Neuron。1 日 1 万 Neurons まで無料）
 * - 確認日: 2026-10-22（上の 3 ページを取得して確かめた。ページの更新日は Workers 2026-10-02 /
 *   Containers 2026-10-05 / Workers AI 2026-10-20）。確認できなかったときは CLOUDFLARE_PRICING_CHECKED_AT を
 *   null（未確認）にして、数値の根拠を「分かっている値」と書き直す
 */

/** 単価を公式のページで確認した日（YYYY-MM-DD）。未確認は null。契約の `pricing_checked_at` にそのまま入る。 */
export const CLOUDFLARE_PRICING_CHECKED_AT: string | null = "2026-10-22";

/** 出典のページ（コメントと同じ。テストで形を確かめる）。 */
export const CLOUDFLARE_PRICING_SOURCES = {
  workers: "https://developers.cloudflare.com/workers/platform/pricing/",
  containers: "https://developers.cloudflare.com/containers/platform/pricing/",
  workers_ai: "https://developers.cloudflare.com/workers-ai/platform/pricing/",
} as const;

/** 1 単位あたりの単価（USD）。公開の値をそのまま書く（掛け算・割り算で作らない）。 */
export const CLOUDFLARE_UNIT_PRICES_USD = {
  /** Workers: $0.30 / 100 万リクエスト */
  workers_request: 0.0000003,
  /** Containers: $0.000020 / vCPU 秒 */
  containers_vcpu_second: 0.00002,
  /** Containers: $0.0000025 / GiB 秒（メモリ） */
  containers_gib_second: 0.0000025,
  /** Containers: $0.00000007 / GB 秒（ディスク） */
  containers_gb_second: 0.00000007,
  /** Workers AI: $0.011 / 1,000 Neurons */
  workers_ai_neuron: 0.000011,
} as const;

/** 推定の入力。取得できない使用量は null（0 ではない。0 は「使っていない」）。 */
export type CostInputs = {
  /** Workers のリクエスト数 */
  workersRequests: number | null;
  /** コンテナの vCPU 秒 */
  vcpuSeconds: number | null;
  /** コンテナのメモリ GiB 秒 */
  memoryGibSeconds: number | null;
  /** コンテナのディスク GB 秒（いまは取っていないので null） */
  diskGbSeconds: number | null;
  /** Workers AI の Neuron 数 */
  neurons: number | null;
  /** AI Gateway の費用（USD。Cloudflare の集計値） */
  aiGatewayCostUsd: number | null;
};

type CostLine = CloudflareCostEstimateDto["items"]["workers_requests"];

/** 浮動小数の誤差を 1e-9 USD の桁で丸める（最小の単価 7e-8 より十分細かい）。 */
const roundUsd = (v: number): number => Math.round(v * 1e9) / 1e9;

function line(quantity: number | null, unit: CostLine["unit"], unitPriceUsd: number): CostLine {
  return {
    quantity,
    unit,
    unit_price_usd: unitPriceUsd,
    // 無料枠・プランに含まれる分を引かない: 単価 × 使用量だけ
    estimated_usd_before_free_tier: quantity === null ? null : roundUsd(quantity * unitPriceUsd),
  };
}

/** 単価 × 使用量の推定と、Cloudflare に払う分の合計を作る（無料枠を引く前。AI Gateway は合計に含めない）。 */
export function buildCostEstimate(input: CostInputs): CloudflareCostEstimateDto {
  const price = CLOUDFLARE_UNIT_PRICES_USD;
  const items: CloudflareCostEstimateDto["items"] = {
    workers_requests: line(input.workersRequests, "request", price.workers_request),
    containers_vcpu: line(input.vcpuSeconds, "vcpu_second", price.containers_vcpu_second),
    containers_memory: line(input.memoryGibSeconds, "gib_second", price.containers_gib_second),
    containers_disk: line(input.diskGbSeconds, "gb_second", price.containers_gb_second),
    workers_ai: line(input.neurons, "neuron", price.workers_ai_neuron),
    ai_gateway: { cost_usd: input.aiGatewayCostUsd },
  };
  // 合計と excluded_items の対象（Cloudflare に払う分だけ。AI Gateway は別の項目で、ここには入れない）
  const amounts: [CloudflareCostEstimateDto["excluded_items"][number], number | null][] = [
    ["workers_requests", items.workers_requests.estimated_usd_before_free_tier],
    ["containers_vcpu", items.containers_vcpu.estimated_usd_before_free_tier],
    ["containers_memory", items.containers_memory.estimated_usd_before_free_tier],
    ["containers_disk", items.containers_disk.estimated_usd_before_free_tier],
    ["workers_ai", items.workers_ai.estimated_usd_before_free_tier],
  ];
  const included = amounts.flatMap(([, v]) => (v === null ? [] : [v]));
  const excluded = amounts.flatMap(([k, v]) => (v === null ? [k] : []));
  return {
    basis: "before_free_tier",
    pricing_checked_at: CLOUDFLARE_PRICING_CHECKED_AT,
    items,
    total_estimated_usd_before_free_tier:
      included.length === 0 ? null : roundUsd(included.reduce((sum, v) => sum + v, 0)),
    excluded_items: excluded,
    partial: excluded.length > 0,
  };
}
