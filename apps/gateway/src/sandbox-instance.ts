import {
  isSandboxPromotionTrigger,
  isSandboxRuleMatch,
  resolveAgentMaxSandboxInstance,
  resolveHeavySandboxInstance,
  resolveSandboxInstance,
  SANDBOX_INSTANCES,
  type SandboxInstance,
  type SandboxPromotionTrigger,
  type SandboxRuleMatch,
} from "@rovo/models";

/**
 * agent が報告した Sandbox の大きさ（usage の instance）を、packages/models の表にある名前に絞る。
 * 表に無い・文字列でない値は undefined（任意の文字列を公開・保存しない。単価の計算にも使わない）。
 */
export function sandboxInstanceName(v: unknown): SandboxInstance | undefined {
  return typeof v === "string" && Object.hasOwn(SANDBOX_INSTANCES, v)
    ? (v as SandboxInstance)
    : undefined;
}

/**
 * このデプロイの既定の大きさ（env の SANDBOX_INSTANCE。agent と同じ値をデプロイの設定が両方へ入れる）。
 * 未設定・不正な値は既定（standard-2）。agent と同じ resolveSandboxInstance で解く。
 */
export function defaultSandboxInstanceOf(env: { SANDBOX_INSTANCE?: string }): SandboxInstance {
  return resolveSandboxInstance(env.SANDBOX_INSTANCE).instance;
}

/**
 * 重いコマンド（テスト・ビルドなど）の初回に、Sandbox が自動で昇格する先（env の SANDBOX_HEAVY_INSTANCE。agent と同じ値をデプロイの設定が両方へ入れる）。
 * 未設定・空・off / none・不正な値は null（昇格しない。sandbox_instances_list に promotion_target を付けない）。agent と同じ resolveHeavySandboxInstance で解く。
 */
export function heavySandboxInstanceOf(env: {
  SANDBOX_HEAVY_INSTANCE?: string;
}): SandboxInstance | null {
  return resolveHeavySandboxInstance(env.SANDBOX_HEAVY_INSTANCE).instance;
}

/**
 * 子が sandbox_scale_up で選べる大きさの上限（env の SANDBOX_AGENT_MAX_INSTANCE。agent と同じ値をデプロイの設定が両方へ入れる）。
 * 未設定・空・off / none・不正な値は null（子はツールを使えない。sandbox_instances_list に agent_max を付けない）。agent と同じ resolveAgentMaxSandboxInstance で解く。
 */
export function agentMaxSandboxInstanceOf(env: {
  SANDBOX_AGENT_MAX_INSTANCE?: string;
}): SandboxInstance | null {
  return resolveAgentMaxSandboxInstance(env.SANDBOX_AGENT_MAX_INSTANCE).instance;
}

/** 成功した昇格 1 回分の公開用の形（usage.sandbox_promotions[] / task_summary の sandbox.promotions[]）。値はすべて固定の値か数値 */
export type PublicPromotion = {
  to: SandboxInstance;
  at: number;
  trigger: SandboxPromotionTrigger;
  /** この昇格までの Sandbox の累計時間（ms） */
  runtime_ms_before: number;
  /** trigger が rule のときだけ: 一致した重いコマンドの表の名前（固定の一覧。argv の文字列は入らない） */
  rule_match?: SandboxRuleMatch;
};

/** 公開する履歴の上限（昇格は上げる方向だけなので、実際は 4 件以内） */
export const MAX_PUBLIC_PROMOTIONS = 8;

const count0 = (v: unknown): number =>
  typeof v === "number" && Number.isFinite(v) && v > 0 ? Math.floor(v) : 0;

/**
 * 昇格の履歴を公開用の形に絞る。表に無い大きさ・引き金の要素は捨て、規則名は trigger が rule で表にある名前のときだけ通す。
 * 子の自由文・argv など、決まったキー以外は読まない。camel は agent の報告（runtimeMsBefore / ruleMatch）、snake は公開用の形（runtime_ms_before / rule_match）。
 */
export function sanitizePromotions(v: unknown, form: "camel" | "snake"): PublicPromotion[] {
  if (!Array.isArray(v)) return [];
  const out: PublicPromotion[] = [];
  for (const x of v) {
    if (out.length >= MAX_PUBLIC_PROMOTIONS) break;
    if (typeof x !== "object" || x === null) continue;
    const r = x as Record<string, unknown>;
    const to = sandboxInstanceName(r.to);
    if (to === undefined || !isSandboxPromotionTrigger(r.trigger)) continue;
    const rule = form === "camel" ? r.ruleMatch : r.rule_match;
    out.push({
      to,
      at: count0(r.at),
      trigger: r.trigger,
      runtime_ms_before: count0(form === "camel" ? r.runtimeMsBefore : r.runtime_ms_before),
      ...(r.trigger === "rule" && isSandboxRuleMatch(rule) ? { rule_match: rule } : {}),
    });
  }
  return out;
}
