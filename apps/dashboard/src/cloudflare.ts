import type { CloudflareSummaryDto } from "@rovo/dashboard-contract";
import { CLOUDFLARE_DASH_URL, formatCount, formatUsd } from "./format";
import type { T } from "./i18n";

/** Cloudflare の枠の整形（純関数）。値は数値と固定の語だけで組み、上流の文字列は通さない。 */
export { CLOUDFLARE_DASH_URL };

type Reason = "forbidden" | "unavailable" | "not_configured" | "empty";

const REASONS: ReadonlySet<string> = new Set<Reason>([
  "forbidden",
  "unavailable",
  "not_configured",
  "empty",
]);

export function reasonText(reason: Reason, t: T): string {
  return t(`cf.reason.${REASONS.has(reason) ? reason : "unavailable"}`);
}

/** 秒を時間にして小数 2 桁まで（末尾の 0 を落とす）。0 は「0」、0.005 時間未満は「<0.01」。 */
function hours(seconds: number, t: T): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return "0";
  const h = seconds / 3600;
  if (h < 0.005) return "<0.01";
  const fixed = h.toFixed(2).replace(/0+$/, "").replace(/\.$/, "");
  const [int = "0", frac = ""] = fixed.split(".");
  return frac === "" ? formatCount(Number(int), t) : `${formatCount(Number(int), t)}.${frac}`;
}

export const formatVcpuHours = (seconds: number, t: T) =>
  t("cf.vcpuHours", { h: hours(seconds, t) });
export const formatGibHours = (seconds: number, t: T) => t("cf.gibHours", { h: hours(seconds, t) });
export const formatNeurons = (n: number, t: T) => `${formatCount(Math.round(n), t)} Neuron`;

export type CloudflareRow = {
  key: "workers" | "containers" | "ai_gateway" | "workers_ai" | "credit_balance";
  name: string;
  ok: boolean;
  text: string;
  href: string;
  ariaLabel: string;
  /** 金額の表示。推定の金額（無料枠を引く前）か、AI Gateway のモデル費用（BYOK）。無い・null の項目は null */
  cost: string | null;
  /** 行の意味の注記（合計とは別。AI Gateway・クレジット残高だけ）。無ければ null */
  note: string | null;
};

// AI Gateway の行の注記（cf.ai_gateway.note）: モデル費用は BYOK で Anthropic などに請求され、Cloudflare の請求の合計には含まない。
// クレジット残高の行の注記（cf.credit.note）: Unified Billing のクレジットの範囲。

type Item<V> = { ok: true; value: V } | { ok: false; reason: Reason } | undefined;

function row<V>(
  t: T,
  key: CloudflareRow["key"],
  item: Item<V>,
  fmt: (v: V) => string,
  cost: number | null | undefined,
  costText: (usd: number) => string = (usd) => t("cf.estimate", { amount: formatUsd(usd, t) }),
  note: string | null = null,
): CloudflareRow {
  const base = {
    key,
    name: t(`cf.${key}.name`),
    href: CLOUDFLARE_DASH_URL,
    ariaLabel: t("cf.openAria", { name: t(`cf.${key}.open`) }),
    // 取れなかった項目（ok が false）と推定が null の項目は金額を出さない
    cost: item?.ok && cost !== null && cost !== undefined ? costText(cost) : null,
    note,
  };
  // 契約で optional の項目が無いときは、一時的な取得失敗として扱う
  if (item === undefined) return { ...base, ok: false, text: reasonText("unavailable", t) };
  if (!item.ok) return { ...base, ok: false, text: reasonText(item.reason, t) };
  return { ...base, ok: true, text: fmt(item.value) };
}

/**
 * コンテナの推定（vCPU + メモリ、取れていればディスクも足す）。vCPU かメモリが null なら金額は出さない
 * （片方だけの合計を全体の金額に見せない）。ディスクが null のときは、足さずに vCPU + メモリだけにする。
 */
function containersCost(
  e: NonNullable<CloudflareSummaryDto["cost_estimate"]>["items"],
): number | null {
  const v = e.containers_vcpu.estimated_usd_before_free_tier;
  const m = e.containers_memory.estimated_usd_before_free_tier;
  if (v === null || m === null) return null;
  const d = e.containers_disk.estimated_usd_before_free_tier ?? 0;
  return v + m + d;
}

/** 欄の頭の推定の合計。cost_estimate が無ければ null（件数だけ出す）。 */
export function cloudflareEstimateHead(
  s: CloudflareSummaryDto,
  t: T,
): { text: string; partial: boolean } | null {
  const e = s.cost_estimate;
  if (e === undefined) return null;
  const total = e.total_estimated_usd_before_free_tier;
  const amount = total === null ? t("cf.cantEstimate") : formatUsd(total, t);
  return { text: t("cf.head", { amount }), partial: e.partial };
}

/** 画面の行。リンクはどれも Cloudflare のトップ（DTO の open_url は使わない）。 */
export function cloudflareRows(s: CloudflareSummaryDto, t: T): CloudflareRow[] {
  const e = s.cost_estimate?.items;
  return [
    row(
      t,
      "workers",
      s.workers,
      (v) =>
        t("cf.workers.value", {
          requests: formatCount(v.requests, t),
          errors: formatCount(v.errors, t),
        }),
      e?.workers_requests.estimated_usd_before_free_tier,
    ),
    row(
      t,
      "containers",
      s.containers,
      (v) =>
        t("cf.containers.value", {
          cpu: formatVcpuHours(v.vcpu_seconds, t),
          memory: formatGibHours(v.memory_gib_seconds, t),
          running: formatCount(v.running_instances, t),
        }),
      e === undefined ? undefined : containersCost(e),
    ),
    row(
      t,
      "ai_gateway",
      s.ai_gateway,
      (v) =>
        t("cf.ai_gateway.value", {
          requests: formatCount(v.requests, t),
          errors: formatCount(v.errors, t),
          cost: formatUsd(v.cost_usd, t),
        }),
      // 合計の内訳に見えないよう「推定」ではなく「モデルの費用」と出す（BYOK。注記も添える）
      e?.ai_gateway.cost_usd,
      (usd) => t("cf.modelCost", { amount: formatUsd(usd, t) }),
      t("cf.ai_gateway.note"),
    ),
    row(
      t,
      "workers_ai",
      s.workers_ai,
      (v) => formatNeurons(v.neurons, t),
      e?.workers_ai.estimated_usd_before_free_tier,
    ),
    row(
      t,
      "credit_balance",
      s.credit_balance,
      (v) => formatUsd(v.balance_usd, t),
      undefined,
      undefined,
      t("cf.credit_balance.note"),
    ),
  ];
}
