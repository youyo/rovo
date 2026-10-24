import type { CloudflareSummaryDto } from "@rovo/dashboard-contract";
import { describe, expect, it } from "vitest";
import {
  CLOUDFLARE_DASH_URL,
  cloudflareEstimateHead,
  cloudflareRows,
  formatGibHours,
  formatNeurons,
  formatVcpuHours,
  reasonText,
} from "../src/cloudflare";
import { isAllowedCloudflareUrl } from "../src/format";
import { tJa } from "./lang";

const period = { start: "2026-10-21T00:00:00Z", end: "2026-10-22T00:00:00Z" };
const summary: CloudflareSummaryDto = {
  generated_at: "2026-10-22T00:00:00Z",
  open_url: null,
  range: "24h",
  workers: { ok: true, value: { period, requests: 12_345, errors: 7 } },
  containers: {
    ok: true,
    value: { period, running_instances: 2, vcpu_seconds: 5_400, memory_gib_seconds: 21_600 },
  },
  ai_gateway: {
    ok: true,
    value: { period, requests: 316, cached_requests: 10, errors: 18, cost_usd: 3 },
  },
  workers_ai: { ok: true, value: { period, neurons: 1234.6 } },
  credit_balance: { ok: true, value: { balance_usd: 954.63 } },
};

const rowOf = (s: CloudflareSummaryDto, key: string) => {
  const r = cloudflareRows(s, tJa).find((x) => x.key === key);
  if (!r) throw new Error(`行が無い: ${key}`);
  return r;
};

describe("単位の整形", () => {
  it("vCPU 時間・GiB 時間は秒から時間へ（小数 2 桁まで、末尾の 0 を落とす）", () => {
    expect(formatVcpuHours(5_400, tJa)).toBe("1.5 vCPU 時間");
    expect(formatGibHours(21_600, tJa)).toBe("6 GiB 時間");
    expect(formatVcpuHours(0, tJa)).toBe("0 vCPU 時間");
    expect(formatVcpuHours(10, tJa)).toBe("<0.01 vCPU 時間");
    expect(formatGibHours(3_700_000, tJa)).toBe("1,027.78 GiB 時間");
  });
  it("neurons は整数に丸めて桁区切り", () => {
    expect(formatNeurons(1234.6, tJa)).toBe("1,235 Neuron");
    expect(formatNeurons(0, tJa)).toBe("0 Neuron");
  });
});

describe("cloudflareRows", () => {
  it("表示順と項目名", () => {
    expect(cloudflareRows(summary, tJa).map((r) => r.name)).toEqual([
      "Workers のリクエスト",
      "Sandbox コンテナの稼働",
      "AI Gateway のリクエスト",
      "Workers AI",
      "クレジット残高",
    ]);
  });
  it("各項目の値を人が読める形にする", () => {
    expect(rowOf(summary, "workers").text).toBe("12,345 件、エラー 7 件");
    expect(rowOf(summary, "containers").text).toBe(
      "CPU 1.5 vCPU 時間、メモリ 6 GiB 時間、稼働中 2 台",
    );
    expect(rowOf(summary, "ai_gateway").text).toBe("316 件、エラー 18 件、費用 $3.00");
    expect(rowOf(summary, "workers_ai").text).toBe("1,235 Neuron");
    expect(rowOf(summary, "credit_balance").text).toBe("$954.63");
  });
  it("取得できない理由ごとの言葉", () => {
    expect(reasonText("forbidden", tJa)).toBe("取得できない（トークンの権限を確認）");
    expect(reasonText("unavailable", tJa)).toBe("取得できない（一時的）");
    expect(reasonText("not_configured", tJa)).toBe("未設定");
    expect(reasonText("empty", tJa)).toBe("データなし");
    const s: CloudflareSummaryDto = {
      ...summary,
      workers: { ok: false, reason: "forbidden" },
      containers: { ok: false, reason: "unavailable" },
      ai_gateway: { ok: false, reason: "not_configured" },
      workers_ai: { ok: false, reason: "empty" },
    };
    expect(rowOf(s, "workers")).toMatchObject({ ok: false, text: reasonText("forbidden", tJa) });
    expect(rowOf(s, "containers").text).toBe("取得できない（一時的）");
    expect(rowOf(s, "ai_gateway").text).toBe("未設定");
    expect(rowOf(s, "workers_ai").text).toBe("データなし");
  });
  it("契約の optional な項目が無いとき（古い応答）は一時的な取得失敗として扱う", () => {
    const { workers: _w, workers_ai: _a, ...old } = summary;
    expect(rowOf(old, "workers").text).toBe("取得できない（一時的）");
    expect(rowOf(old, "workers_ai").text).toBe("取得できない（一時的）");
  });
  it("リンクは行ごとの ?to=/:account/ 形（open_url やアカウント ID は使わない）", () => {
    const withAccount: CloudflareSummaryDto = {
      ...summary,
      open_url: `https://dash.cloudflare.com/${"0123456789abcdef".repeat(2)}/workers`,
    };
    const expected: Record<string, string> = {
      workers: "https://dash.cloudflare.com/?to=/:account/workers-and-pages",
      containers: "https://dash.cloudflare.com/?to=/:account/workers/containers",
      ai_gateway: "https://dash.cloudflare.com/?to=/:account/ai/ai-gateway",
      workers_ai: "https://dash.cloudflare.com/?to=/:account/ai/workers-ai",
      credit_balance: "https://dash.cloudflare.com/?to=/:account/ai/ai-gateway",
    };
    const rows = cloudflareRows(withAccount, tJa);
    expect(rows.map((r) => r.key).sort()).toEqual(Object.keys(expected).sort());
    for (const r of rows) {
      expect(r.href).toBe(expected[r.key]);
      expect(isAllowedCloudflareUrl(r.href)).toBe(true);
      expect(r.href).not.toMatch(/[0-9a-f]{32}/);
      expect(r.ariaLabel).toMatch(/を Cloudflare で開く$/);
    }
  });
});

describe("isAllowedCloudflareUrl", () => {
  it("トップと ?to=/:account/<パス> の形だけを許す", () => {
    expect(isAllowedCloudflareUrl(CLOUDFLARE_DASH_URL)).toBe(true);
    for (const ok of [
      "https://dash.cloudflare.com/?to=/:account/workers-and-pages",
      "https://dash.cloudflare.com/?to=/:account/workers/containers",
      "https://dash.cloudflare.com/?to=/:account/ai/ai-gateway",
    ]) {
      expect(isAllowedCloudflareUrl(ok), ok).toBe(true);
    }
    for (const bad of [
      `https://dash.cloudflare.com/?to=/${"0123456789abcdef".repeat(2)}/workers`,
      `https://dash.cloudflare.com/?to=/:account/${"0123456789abcdef".repeat(2)}`,
      "https://dash.cloudflare.com/?to=/:account/",
      "https://dash.cloudflare.com/?to=/:account/a/../b",
      "https://dash.cloudflare.com/?to=/:account/a?x=1",
      "https://dash.cloudflare.com/?to=/:account/a#x",
      "https://dash.cloudflare.com/?to=//evil.com",
      "https://dash.cloudflare.com/?to=/:account/a&b=1",
      "https://evil.com/?to=/:account/workers-and-pages",
      "http://dash.cloudflare.com/?to=/:account/workers-and-pages",
      "https://user@dash.cloudflare.com/?to=/:account/workers-and-pages",
      "https://dash.cloudflare.com/abc",
      "https://dash.cloudflare.com",
      "http://dash.cloudflare.com/",
      "https://dash.cloudflare.com.evil.com/",
      "https://user@dash.cloudflare.com/",
      "https://dash.cloudflare.com/?a=1",
      "javascript:alert(1)",
      "",
    ]) {
      expect(isAllowedCloudflareUrl(bad), bad).toBe(false);
    }
    expect(isAllowedCloudflareUrl(null)).toBe(false);
  });
});

describe("推定の金額（cost_estimate）", () => {
  const withEstimate = (over: Partial<NonNullable<CloudflareSummaryDto["cost_estimate"]>> = {}) =>
    ({
      ...summary,
      cost_estimate: {
        basis: "before_free_tier",
        pricing_checked_at: "2026-10-22",
        items: {
          workers_requests: {
            quantity: 150,
            unit: "request",
            unit_price_usd: 0.0000003,
            estimated_usd_before_free_tier: 0.000045,
          },
          containers_vcpu: {
            quantity: 4_000,
            unit: "vcpu_second",
            unit_price_usd: 0.00002,
            estimated_usd_before_free_tier: 0.08,
          },
          containers_memory: {
            quantity: 250,
            unit: "gib_second",
            unit_price_usd: 0.0000025,
            estimated_usd_before_free_tier: 0.000625,
          },
          containers_disk: {
            quantity: null,
            unit: "gb_second",
            unit_price_usd: 0.00000007,
            estimated_usd_before_free_tier: null,
          },
          workers_ai: {
            quantity: 777.5,
            unit: "neuron",
            unit_price_usd: 0.000011,
            estimated_usd_before_free_tier: 0.0085525,
          },
          ai_gateway: { cost_usd: 1.25 },
        },
        total_estimated_usd_before_free_tier: 0.0892225,
        excluded_items: ["containers_disk"],
        partial: true,
        ...over,
      },
    }) satisfies CloudflareSummaryDto;

  it("欄の頭は「Cloudflare の請求（推定）$x（無料枠を引く前）」で、partial なら注記を添える", () => {
    expect(cloudflareEstimateHead(withEstimate(), tJa)).toEqual({
      text: "Cloudflare の請求（推定）$0.0892（無料枠を引く前）",
      partial: true,
    });
    const full = withEstimate({ excluded_items: [], partial: false });
    expect(cloudflareEstimateHead(full, tJa)).toEqual({
      text: "Cloudflare の請求（推定）$0.0892（無料枠を引く前）",
      partial: false,
    });
  });

  it("合計は AI Gateway を含まない（Cloudflare の 5 項目の和。AI Gateway の 1.25 は含まれない）", () => {
    const s = withEstimate({ total_estimated_usd_before_free_tier: 0.0892225 });
    expect(cloudflareEstimateHead(s, tJa)?.text).toBe(
      "Cloudflare の請求（推定）$0.0892（無料枠を引く前）",
    );
    expect(cloudflareEstimateHead(s, tJa)?.text).not.toContain("1.34");
  });

  it("合計が null なら「推定できない」", () => {
    const s = withEstimate({ total_estimated_usd_before_free_tier: null });
    expect(cloudflareEstimateHead(s, tJa)?.text).toBe(
      "Cloudflare の請求（推定）推定できない（無料枠を引く前）",
    );
  });

  it("cost_estimate が無い（古い応答）ときは見出しを出さず、行の金額も出さない", () => {
    expect(cloudflareEstimateHead(summary, tJa)).toBeNull();
    for (const r of cloudflareRows(summary, tJa)) expect(r.cost, r.key).toBeNull();
  });

  it("各行の金額。コンテナは vCPU とメモリの合計（ディスクは null なので足さない）、AI Gateway は cost_usd", () => {
    const s = withEstimate();
    expect(rowOf(s, "workers").cost).toBe("推定 <$0.0001");
    expect(rowOf(s, "containers").cost).toBe("推定 $0.0806");
    expect(rowOf(s, "ai_gateway").cost).toBe("モデルの費用 $1.25");
    expect(rowOf(s, "workers_ai").cost).toBe("推定 $0.0086");
    expect(rowOf(s, "credit_balance").cost).toBeNull();
  });

  it("AI Gateway の行はモデル費用（BYOK）と分かる注記、クレジット残高の行は Unified Billing の注記を持つ", () => {
    const s = withEstimate();
    expect(rowOf(s, "ai_gateway").note).toBe(
      "BYOK。Anthropic などに請求され、rovo の予算に含まれる（Cloudflare の請求の合計には含まない）",
    );
    expect(rowOf(s, "credit_balance").note).toBe(
      "Unified Billing のクレジット（Web 検索など。BYOK のモデル費用は含まない）",
    );
    // 注記は推定が無い古い応答でも出す（意味の説明なので）
    expect(rowOf(summary, "credit_balance").note).toBe(
      "Unified Billing のクレジット（Web 検索など。BYOK のモデル費用は含まない）",
    );
    expect(rowOf(summary, "workers").note).toBeNull();
  });

  it("null の項目は金額を出さない（取れない項目・使用量の無い項目）", () => {
    const s = withEstimate();
    const withNullAi: CloudflareSummaryDto = {
      ...s,
      cost_estimate: s.cost_estimate && {
        ...s.cost_estimate,
        items: {
          ...s.cost_estimate.items,
          workers_ai: { ...s.cost_estimate.items.workers_ai, estimated_usd_before_free_tier: null },
        },
      },
    };
    expect(rowOf(withNullAi, "workers_ai").cost).toBeNull();
    expect(rowOf(withNullAi, "workers_ai").text).toBe("1,235 Neuron");
    const containersNull: CloudflareSummaryDto = {
      ...s,
      cost_estimate: s.cost_estimate && {
        ...s.cost_estimate,
        items: {
          ...s.cost_estimate.items,
          containers_memory: {
            ...s.cost_estimate.items.containers_memory,
            estimated_usd_before_free_tier: null,
          },
        },
      },
    };
    expect(rowOf(containersNull, "containers").cost).toBeNull();
    const workersOff: CloudflareSummaryDto = { ...s, workers: { ok: false, reason: "forbidden" } };
    expect(rowOf(workersOff, "workers").cost).toBeNull();
  });
});
