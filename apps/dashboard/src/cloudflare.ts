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
};

type Item<T> = { ok: true; value: T } | { ok: false; reason: Reason } | undefined;

function row<T>(
  key: CloudflareRow["key"],
  name: string,
  open: string,
  item: Item<T>,
  fmt: (v: T) => string,
): CloudflareRow {
  const base = { key, name, href: CLOUDFLARE_DASH_URL, ariaLabel: `${open} を Cloudflare で開く` };
  // 契約で optional の項目が無いときは、一時的な取得失敗として扱う
  if (item === undefined) return { ...base, ok: false, text: reasonText("unavailable") };
  if (!item.ok) return { ...base, ok: false, text: reasonText(item.reason) };
  return { ...base, ok: true, text: fmt(item.value) };
}

/** 画面の行。リンクはどれも Cloudflare のトップ（DTO の open_url は使わない）。 */
export function cloudflareRows(s: CloudflareSummaryDto): CloudflareRow[] {
  return [
    row(
      "workers",
      "Workers のリクエスト",
      "Workers",
      s.workers,
      (v) => `${formatCount(v.requests)} 件、エラー ${formatCount(v.errors)} 件`,
    ),
    row(
      "containers",
      "Sandbox コンテナの稼働",
      "Containers",
      s.containers,
      (v) =>
        `CPU ${formatVcpuHours(v.vcpu_seconds)}、メモリ ${formatGibHours(v.memory_gib_seconds)}、稼働中 ${formatCount(v.running_instances)} 台`,
    ),
    row(
      "ai_gateway",
      "AI Gateway のリクエスト",
      "AI Gateway",
      s.ai_gateway,
      (v) =>
        `${formatCount(v.requests)} 件、エラー ${formatCount(v.errors)} 件、費用 ${formatUsd(v.cost_usd)}`,
    ),
    row("workers_ai", "Workers AI", "Workers AI", s.workers_ai, (v) => formatNeurons(v.neurons)),
    row("credit_balance", "クレジット残高", "クレジット残高", s.credit_balance, (v) =>
      formatUsd(v.balance_usd),
    ),
  ];
}
