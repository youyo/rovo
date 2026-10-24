import { describe, expect, it } from "vitest";
import {
  computeFingerprint,
  computeReviewFingerprint,
  reviewInputSchema,
  taskInputSchema,
} from "../../src/tasks/validation";

const input = {
  repository: "acme/widgets",
  pull_number: 7,
  review_model: "anthropic/claude-sonnet-5-5",
};
const HEAD = "a".repeat(40);

describe("task_review の入力（reviewInputSchema）", () => {
  it("repository・pull_number・review_model だけで受け付ける（既定: review_commands は空、budget_policy は ask）", () => {
    const r = reviewInputSchema.safeParse(input);
    expect(r.success).toBe(true);
    if (!r.success) return;
    expect(r.data).toEqual({ ...input, review_commands: [], budget_policy: "ask" });
  });

  it("review_model は必須（作業のモデルを黙って使わない）", () => {
    const { review_model: _m, ...rest } = input;
    expect(reviewInputSchema.safeParse(rest).success).toBe(false);
  });

  it("pull_number は正の整数", () => {
    for (const n of [0, -1, 1.5, "7", null]) {
      expect(reviewInputSchema.safeParse({ ...input, pull_number: n }).success).toBe(false);
    }
  });

  it("review_commands は verification_commands と同じ形（argv・cwd・timeout_seconds。未知のキーは拒否）", () => {
    const ok = reviewInputSchema.safeParse({
      ...input,
      review_commands: [{ argv: ["pnpm", "test"], cwd: "apps/x", timeout_seconds: 900 }],
    });
    expect(ok.success).toBe(true);
    for (const bad of [
      [{ argv: [] }],
      [{ argv: ["x"], cwd: "../etc" }],
      [{ argv: ["x"], timeout_seconds: 0 }],
      [{ argv: ["x"], timeoutSeconds: 10 }],
      Array.from({ length: 11 }, () => ({ argv: ["x"] })),
    ]) {
      expect(reviewInputSchema.safeParse({ ...input, review_commands: bad }).success).toBe(false);
    }
  });

  it("budget_policy と sandbox_instance は task_start と同じ値だけ", () => {
    expect(reviewInputSchema.safeParse({ ...input, budget_policy: "stop" }).success).toBe(true);
    expect(reviewInputSchema.safeParse({ ...input, budget_policy: "never" }).success).toBe(false);
    expect(reviewInputSchema.safeParse({ ...input, sandbox_instance: "standard-2" }).success).toBe(
      true,
    );
    expect(reviewInputSchema.safeParse({ ...input, sandbox_instance: "lite" }).success).toBe(false);
  });

  it("宣言に無いキー（review_fix_rounds など、初版では使えないもの）は拒否する（黙って捨てない）", () => {
    expect(reviewInputSchema.safeParse({ ...input, review_fix_rounds: 1 }).success).toBe(false);
  });
});

describe("computeReviewFingerprint（同じ PR の同じ head・同じ条件なら同じ値）", () => {
  const parsed = (over: Record<string, unknown> = {}) =>
    reviewInputSchema.parse({ ...input, ...over });

  it("repository の大小文字と head の SHA の大小文字は区別しない", async () => {
    const a = await computeReviewFingerprint(parsed(), HEAD);
    const b = await computeReviewFingerprint(
      parsed({ repository: "ACME/Widgets" }),
      HEAD.toUpperCase(),
    );
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });

  it("head が進めば別の値（別のレビュー）。モデル・コマンド・番号が違っても別", async () => {
    const a = await computeReviewFingerprint(parsed(), HEAD);
    expect(await computeReviewFingerprint(parsed(), "b".repeat(40))).not.toBe(a);
    expect(
      await computeReviewFingerprint(parsed({ review_model: "anthropic/claude-haiku-5-5" }), HEAD),
    ).not.toBe(a);
    expect(
      await computeReviewFingerprint(
        parsed({ review_commands: [{ argv: ["pnpm", "test"] }] }),
        HEAD,
      ),
    ).not.toBe(a);
    expect(await computeReviewFingerprint(parsed({ pull_number: 8 }), HEAD)).not.toBe(a);
  });

  it("task_start の指紋と衝突しない（別の接頭辞）。task_start の指紋は変わらない", async () => {
    const start = taskInputSchema.parse({
      repository: "acme/widgets",
      base_ref: "main",
      base_sha: HEAD,
      title: "t",
      instructions: "i",
    });
    const before = await computeFingerprint(start);
    expect(before).toBe(await computeFingerprint(start));
    expect(await computeReviewFingerprint(parsed(), HEAD)).not.toBe(before);
  });
});
