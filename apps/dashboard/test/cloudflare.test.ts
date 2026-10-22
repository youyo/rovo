import type { CloudflareSummaryDto } from "@rovo/dashboard-contract";
import { describe, expect, it } from "vitest";
import {
  CLOUDFLARE_DASH_URL,
  cloudflareRows,
  formatGibHours,
  formatNeurons,
  formatVcpuHours,
  reasonText,
} from "../src/cloudflare";
import { isAllowedCloudflareUrl } from "../src/format";

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
  const r = cloudflareRows(s).find((x) => x.key === key);
  if (!r) throw new Error(`行が無い: ${key}`);
  return r;
};

describe("単位の整形", () => {
  it("vCPU 時間・GiB 時間は秒から時間へ（小数 2 桁まで、末尾の 0 を落とす）", () => {
    expect(formatVcpuHours(5_400)).toBe("1.5 vCPU 時間");
    expect(formatGibHours(21_600)).toBe("6 GiB 時間");
    expect(formatVcpuHours(0)).toBe("0 vCPU 時間");
    expect(formatVcpuHours(10)).toBe("<0.01 vCPU 時間");
    expect(formatGibHours(3_700_000)).toBe("1,027.78 GiB 時間");
  });
  it("neurons は整数に丸めて桁区切り", () => {
    expect(formatNeurons(1234.6)).toBe("1,235 Neuron");
    expect(formatNeurons(0)).toBe("0 Neuron");
  });
});

describe("cloudflareRows", () => {
  it("表示順と項目名", () => {
    expect(cloudflareRows(summary).map((r) => r.name)).toEqual([
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
    expect(reasonText("forbidden")).toBe("取得できない（トークンの権限を確認）");
    expect(reasonText("unavailable")).toBe("取得できない（一時的）");
    expect(reasonText("not_configured")).toBe("未設定");
    expect(reasonText("empty")).toBe("データなし");
    const s: CloudflareSummaryDto = {
      ...summary,
      workers: { ok: false, reason: "forbidden" },
      containers: { ok: false, reason: "unavailable" },
      ai_gateway: { ok: false, reason: "not_configured" },
      workers_ai: { ok: false, reason: "empty" },
    };
    expect(rowOf(s, "workers")).toMatchObject({ ok: false, text: reasonText("forbidden") });
    expect(rowOf(s, "containers").text).toBe("取得できない（一時的）");
    expect(rowOf(s, "ai_gateway").text).toBe("未設定");
    expect(rowOf(s, "workers_ai").text).toBe("データなし");
  });
  it("契約の optional な項目が無いとき（古い応答）は一時的な取得失敗として扱う", () => {
    const { workers: _w, workers_ai: _a, ...old } = summary;
    expect(rowOf(old, "workers").text).toBe("取得できない（一時的）");
    expect(rowOf(old, "workers_ai").text).toBe("取得できない（一時的）");
  });
  it("リンクは Cloudflare のトップだけ（open_url やアカウント ID は使わない）", () => {
    const withAccount: CloudflareSummaryDto = {
      ...summary,
      open_url: `https://dash.cloudflare.com/${"0123456789abcdef".repeat(2)}/workers`,
    };
    for (const r of cloudflareRows(withAccount)) {
      expect(r.href).toBe(CLOUDFLARE_DASH_URL);
      expect(r.href).not.toMatch(/[0-9a-f]{32}/);
      expect(r.ariaLabel).toMatch(/を Cloudflare で開く$/);
    }
  });
});

describe("isAllowedCloudflareUrl", () => {
  it("https://dash.cloudflare.com/ だけを許す", () => {
    expect(isAllowedCloudflareUrl(CLOUDFLARE_DASH_URL)).toBe(true);
    for (const bad of [
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
