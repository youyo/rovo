import { describe, expect, it } from "vitest";
import {
  cloudflareSummaryFixture,
  errorFixtures,
  HIDDEN_TASK_SENTINELS,
  legacyTaskEventsFixture,
  overviewFixture,
  overviewMeFixture,
  taskDetailFailedSetupFixture,
  taskDetailRunningFixture,
  taskEventsFixture,
} from "../src/fixtures";
import {
  CloudflareSummaryDtoSchema,
  ErrorDtoSchema,
  OverviewDtoSchema,
  TASK_STATUSES,
  TaskDetailDtoSchema,
  TaskEventsPageDtoSchema,
} from "../src/index";

describe("fixtures はスキーマを通る", () => {
  it("overview（全員）", () => {
    expect(OverviewDtoSchema.safeParse(overviewFixture).success).toBe(true);
  });
  it("overview（自分だけ）", () => {
    expect(OverviewDtoSchema.safeParse(overviewMeFixture).success).toBe(true);
  });
  it("詳細（実行中・準備で失敗）", () => {
    expect(TaskDetailDtoSchema.safeParse(taskDetailRunningFixture).success).toBe(true);
    expect(TaskDetailDtoSchema.safeParse(taskDetailFailedSetupFixture).success).toBe(true);
  });
  it("イベント（構造化イベントを含む・古い agent の縮退）", () => {
    expect(TaskEventsPageDtoSchema.safeParse(taskEventsFixture).success).toBe(true);
    expect(TaskEventsPageDtoSchema.safeParse(legacyTaskEventsFixture).success).toBe(true);
  });
  it("Cloudflare（取得できない項目を含む）", () => {
    const r = CloudflareSummaryDtoSchema.safeParse(cloudflareSummaryFixture);
    expect(r.success).toBe(true);
    const items = [
      cloudflareSummaryFixture.containers,
      cloudflareSummaryFixture.ai_gateway,
      cloudflareSummaryFixture.credit_balance,
    ];
    expect(items.some((i) => i.ok === false)).toBe(true);
    expect(items.some((i) => i.ok === true)).toBe(true);
  });
  it("エラー", () => {
    for (const e of errorFixtures) expect(ErrorDtoSchema.safeParse(e).success).toBe(true);
  });
});

describe("fixtures の内容（見本に合わせた今日のデータ）", () => {
  const tasks = overviewFixture.tasks;
  it("3 人・成功 / レビュー待ち / 失敗 / 実行中が揃い、consult がある", () => {
    expect(new Set(tasks.map((t) => t.owner_login)).size).toBe(3);
    const has = (f: (t: (typeof tasks)[number]) => boolean) => tasks.some(f);
    expect(has((t) => t.status === "COMPLETED" && t.pr?.merged === true)).toBe(true);
    expect(has((t) => t.status === "COMPLETED" && t.pr?.merged === false)).toBe(true);
    expect(has((t) => t.status === "FAILED")).toBe(true);
    expect(has((t) => t.status === "RUNNING")).toBe(true);
    expect(overviewFixture.consults.length).toBeGreaterThan(0);
    expect(overviewFixture.models.some((m) => m.consult_cost_usd > 0)).toBe(true);
  });
  it("時刻は固定の ISO 文字列", () => {
    for (const t of tasks) expect(t.created_at).toMatch(/^2026-10-21T\d\d:\d\d:\d\dZ$/);
  });
  it("全 9 状態が TASK_STATUSES に一致する", () => {
    expect(TASK_STATUSES).toHaveLength(9);
  });
  it("月の予算は UTC の月", () => {
    expect(overviewFixture.month.period.start).toBe("2026-10-01T00:00:00.000Z");
    expect(overviewFixture.month.period.end).toBe("2026-11-01T00:00:00.000Z");
  });
});

describe("見えないタスクは件数と合計だけで、個別の情報が応答のどこにも出ない", () => {
  it("hidden_tasks は 1 件以上あり、個別の値が JSON 全体に現れない", () => {
    expect(overviewFixture.month.hidden_tasks.count).toBeGreaterThan(0);
    for (const dto of [overviewFixture, overviewMeFixture]) {
      const text = JSON.stringify(dto);
      for (const [name, value] of Object.entries(HIDDEN_TASK_SENTINELS)) {
        expect(text.includes(value), `${name} が漏れている`).toBe(false);
      }
    }
  });
});

describe("fixtures は架空の値だけ（公開リポジトリ）", () => {
  const all = JSON.stringify([
    overviewFixture,
    overviewMeFixture,
    taskDetailRunningFixture,
    taskDetailFailedSetupFixture,
    taskEventsFixture,
    legacyTaskEventsFixture,
    cloudflareSummaryFixture,
    errorFixtures,
  ]);
  it("トークンの形の文字列を含まない", () => {
    expect(all).not.toMatch(/gh[pousr]_[A-Za-z0-9]{20,}/);
    expect(all).not.toMatch(/github_pat_/);
    expect(all).not.toMatch(/sk-[A-Za-z0-9]{16,}/);
    expect(all).not.toMatch(/Bearer\s+[A-Za-z0-9._-]{16,}/);
    expect(all).not.toMatch(/AKIA[0-9A-Z]{16}/);
  });
  it("リポジトリの owner は example-org だけ", () => {
    const repos = all.match(/"repository":"([^"]+)"/g) ?? [];
    expect(repos.length).toBeGreaterThan(0);
    for (const r of repos) expect(r).toContain("example-org/");
  });
  it("Cloudflare のアカウント ID らしい 32 桁の 16 進を含まない", () => {
    // 40 桁の commit の sha は単語境界で別物として扱う
    expect(all).not.toMatch(/\b[0-9a-f]{32}\b/);
  });
});
