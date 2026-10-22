import type { CloudflareSummaryDto } from "@rovo/dashboard-contract";
import { CLOUDFLARE_DASH_URL, formatCount, formatUsd } from "./format";

/** Cloudflare の枠の整形（純関数）。値は数値と固定の語だけで組み、上流の文字列は通さない。 */
export { CLOUDFLARE_DASH_URL };

type Reason = "forbidden" | "unavailable" | "not_configured" | "empty";

const REASON_TEXT: Record<Reason, string> = {
  forbidden: "取得できない（トークンの権限を確認）",
  unavailable: "取得できない（一時的）",
  not_configured: "未設定",
  empty: "データなし",
};

export function reasonText(reason: Reason): string {
  return REASON_TEXT[reason] ?? REASON_TEXT.unavailable;
}

/** 秒を時間にして小数 2 桁まで（末尾の 0 を落とす）。0 は「0」、0.005 時間未満は「<0.01」。 */
function hours(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return "0";
  const h = seconds / 3600;
  if (h < 0.005) return "<0.01";
  const fixed = h.toFixed(2).replace(/0+$/, "").replace(/\.$/, "");
  const [int = "0", frac = ""] = fixed.split(".");
  return frac === "" ? formatCount(Number(int)) : `${formatCount(Number(int))}.${frac}`;
}

export const formatVcpuHours = (seconds: number) => `${hours(seconds)} vCPU 時間`;
export const formatGibHours = (seconds: number) => `${hours(seconds)} GiB 時間`;
export const formatNeurons = (n: number) => `${formatCount(Math.round(n))} Neuron`;

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

/** AI Gateway の行の注記。モデル費用は BYOK で Anthropic などに請求され、Cloudflare の請求の合計には含まない */
export const AI_GATEWAY_NOTE =
  "BYOK。Anthropic などに請求され、rovo の予算に含まれる（Cloudflare の請求の合計には含まない）";
/** クレジット残高の行の注記（Unified Billing のクレジットの範囲） */
export const CREDIT_NOTE =
  "Unified Billing のクレジット（Web 検索など。BYOK のモデル費用は含まない）";

type Item<T> = { ok: true; value: T } | { ok: false; reason: Reason } | undefined;

function row<T>(
  key: CloudflareRow["key"],
  name: string,
  open: string,
  item: Item<T>,
  fmt: (v: T) => string,
  cost: number | null | undefined,
  costText: (usd: number) => string = (usd) => `推定 ${formatUsd(usd)}`,
  note: string | null = null,
): CloudflareRow {
  const base = {
    key,
    name,
    href: CLOUDFLARE_DASH_URL,
    ariaLabel: `${open} を Cloudflare で開く`,
    // 取れなかった項目（ok が false）と推定が null の項目は金額を出さない
    cost: item?.ok && cost !== null && cost !== undefined ? costText(cost) : null,
    note,
  };
  // 契約で optional の項目が無いときは、一時的な取得失敗として扱う
  if (item === undefined) return { ...base, ok: false, text: reasonText("unavailable") };
  if (!item.ok) return { ...base, ok: false, text: reasonText(item.reason) };
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
): { text: string; partial: boolean } | null {
  const e = s.cost_estimate;
  if (e === undefined) return null;
  const total = e.total_estimated_usd_before_free_tier;
  const amount = total === null ? "推定できない" : formatUsd(total);
  return { text: `Cloudflare の請求（推定）${amount}（無料枠を引く前）`, partial: e.partial };
}

/** 画面の行。リンクはどれも Cloudflare のトップ（DTO の open_url は使わない）。 */
export function cloudflareRows(s: CloudflareSummaryDto): CloudflareRow[] {
  const e = s.cost_estimate?.items;
  return [
    row(
      "workers",
      "Workers のリクエスト",
      "Workers",
      s.workers,
      (v) => `${formatCount(v.requests)} 件、エラー ${formatCount(v.errors)} 件`,
      e?.workers_requests.estimated_usd_before_free_tier,
    ),
    row(
      "containers",
      "Sandbox コンテナの稼働",
      "Containers",
      s.containers,
      (v) =>
        `CPU ${formatVcpuHours(v.vcpu_seconds)}、メモリ ${formatGibHours(v.memory_gib_seconds)}、稼働中 ${formatCount(v.running_instances)} 台`,
      e === undefined ? undefined : containersCost(e),
    ),
    row(
      "ai_gateway",
      "AI Gateway のリクエスト",
      "AI Gateway",
      s.ai_gateway,
      (v) =>
        `${formatCount(v.requests)} 件、エラー ${formatCount(v.errors)} 件、費用 ${formatUsd(v.cost_usd)}`,
      // 合計の内訳に見えないよう「推定」ではなく「モデルの費用」と出す（BYOK。注記も添える）
      e?.ai_gateway.cost_usd,
      (usd) => `モデルの費用 ${formatUsd(usd)}`,
      AI_GATEWAY_NOTE,
    ),
    row(
      "workers_ai",
      "Workers AI",
      "Workers AI",
      s.workers_ai,
      (v) => formatNeurons(v.neurons),
      e?.workers_ai.estimated_usd_before_free_tier,
    ),
    row(
      "credit_balance",
      "クレジット残高",
      "クレジット残高",
      s.credit_balance,
      (v) => formatUsd(v.balance_usd),
      undefined,
      undefined,
      CREDIT_NOTE,
    ),
  ];
}
