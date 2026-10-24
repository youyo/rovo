import {
  isSandboxPromotionReason,
  isSandboxPromotionTrigger,
  resolveMaxSandboxInstance,
  resolveSandboxInstance,
  SANDBOX_INSTANCES,
  type SandboxInstance,
  type SandboxPromotionReason,
  type SandboxPromotionTrigger,
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
 * Clef が Sandbox を自動で上げる上限（env の SANDBOX_MAX_INSTANCE。agent と同じ値をデプロイの設定が両方へ入れる）。
 * 未設定・空・off / none・不正な値は null（Clef による昇格をしない。sandbox_instances_list に auto_scale_max を付けない）。agent と同じ resolveMaxSandboxInstance で解く。
 */
export function maxSandboxInstanceOf(env: {
  SANDBOX_MAX_INSTANCE?: string;
}): SandboxInstance | null {
  return resolveMaxSandboxInstance(env.SANDBOX_MAX_INSTANCE).instance;
}

/** 成功した昇格 1 回分の公開用の形（usage.sandbox_promotions[] / task_summary の sandbox.promotions[]）。値はすべて固定の値か数値 */
export type PublicPromotion = {
  to: SandboxInstance;
  at: number;
  trigger: SandboxPromotionTrigger;
  /** この昇格までの Sandbox の累計時間（ms） */
  runtime_ms_before: number;
  /**
   * 古いタスクの記録だけ（trigger が rule のとき、一致した重いコマンドの表の名前）。今の agent は付けない。
   * 表（規則）は無くなったので、小文字で始まる短い名前（英小文字・数字・. _ - と空白、32 文字まで）だけ通す。argv の文字列は入らない
   */
  rule_match?: string;
};

/** 古いタスクの rule_match（表の名前。vitest・go test・python -m pytest など）として通す形 */
const LEGACY_RULE_MATCH = /^[a-z][a-z0-9._ -]{0,31}$/;

/** 昇格の試みが見送り・失敗になった記録 1 件の公開用の形（usage.sandbox_promotion_failures[] / task_summary の sandbox.promotion_failures[]）。値はどちらも固定の値 */
export type PublicPromotionFailure = {
  trigger: SandboxPromotionTrigger;
  reason: SandboxPromotionReason;
};

/** 公開する履歴の上限（昇格は上げる方向だけなので、実際は 4 件以内） */
export const MAX_PUBLIC_PROMOTIONS = 8;

/** 失敗の内訳を公開用の形に絞る。固定の trigger と理由コードの要素だけ通し、他のキー・値は捨てる。MAX_PUBLIC_PROMOTIONS 件まで */
export function sanitizePromotionFailures(v: unknown): PublicPromotionFailure[] {
  if (!Array.isArray(v)) return [];
  const out: PublicPromotionFailure[] = [];
  for (const x of v) {
    if (out.length >= MAX_PUBLIC_PROMOTIONS) break;
    if (typeof x !== "object" || x === null) continue;
    const r = x as Record<string, unknown>;
    if (!isSandboxPromotionTrigger(r.trigger) || !isSandboxPromotionReason(r.reason)) continue;
    out.push({ trigger: r.trigger, reason: r.reason });
  }
  return out;
}

const count0 = (v: unknown): number =>
  typeof v === "number" && Number.isFinite(v) && v > 0 ? Math.floor(v) : 0;

/**
 * 昇格の履歴を公開用の形に絞る。表に無い大きさ・引き金の要素は捨て、古い記録の規則名は trigger が rule で安全な短い名前のときだけ通す。
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
      ...(r.trigger === "rule" && typeof rule === "string" && LEGACY_RULE_MATCH.test(rule)
        ? { rule_match: rule }
        : {}),
    });
  }
  return out;
}

/** Clef の判断 1 件の公開用の形（usage.sandbox_scale_log[]）。値はすべて固定の値か数値で、argv・自由文は入らない */
export type PublicScaleDecision = {
  at: number;
  from: SandboxInstance;
  /** 上げた先。上げなかった・昇格に失敗した・Clef が失敗したときは null */
  to: SandboxInstance | null;
  /** 重い確率（0〜1） */
  heavy?: number;
  /** 4 vCPU で 2 vCPU より速い確率 */
  fast4?: number;
  /** 大きさの選択の確率 [standard-2, standard-3, standard-4] */
  choice?: number[];
  /** 答えを使ったモデル。flash は clef-flash、clef は聞き直したとき */
  model?: "flash" | "clef";
  /** Clef が失敗した（再試行しても判断できなかった） */
  failed?: true;
  /** Clef の判断にかかった時間（ms） */
  clef_ms: number;
  /** そのコマンドの実行時間（ms） */
  cmd_ms?: number;
  exit_code?: number;
  /** コマンドの先頭の語（argv[0] の basename。24 文字まで。英数字と . _ + - だけ） */
  cmd: string;
};

/** Clef の判断の集計の公開用の形（usage.sandbox_scale_decisions など。数値だけ） */
export type PublicScaleStats = {
  decisions: number;
  raised: number;
  clef_failures: number;
  slow_not_raised: number;
  skipped_light: number;
};

const unit01 = (v: unknown): number | undefined =>
  typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 1 ? v : undefined;

/** 公開する判断の記録の上限（agent の MAX_SCALE_DECISIONS と同じ。直近の分だけ） */
export const MAX_PUBLIC_SCALE_DECISIONS = 50;

/**
 * agent が報告した Clef の判断の記録（camelCase）を、公開用の形に絞る。表に無い大きさの要素は捨て、確率は 0〜1 だけ通し、
 * cmd は先頭の語の安全な文字だけ（24 文字まで）にする。決まったキー以外（argv・自由文）は読まない。最後の 50 件まで。
 */
export function sanitizeScaleDecisions(v: unknown): PublicScaleDecision[] {
  if (!Array.isArray(v)) return [];
  const out: PublicScaleDecision[] = [];
  for (const x of v.slice(-MAX_PUBLIC_SCALE_DECISIONS)) {
    if (typeof x !== "object" || x === null) continue;
    const r = x as Record<string, unknown>;
    const from = sandboxInstanceName(r.from);
    if (from === undefined) continue;
    const to = sandboxInstanceName(r.to) ?? null;
    const heavy = unit01(r.heavy);
    const fast4 = unit01(r.fast4);
    const choice =
      Array.isArray(r.choice) &&
      r.choice.length === 3 &&
      r.choice.every((c) => unit01(c) !== undefined)
        ? (r.choice as number[])
        : undefined;
    const first = typeof r.cmd === "string" ? (r.cmd.trim().split(/\s+/)[0] ?? "") : "";
    out.push({
      at: count0(r.at),
      from,
      to,
      ...(heavy !== undefined ? { heavy } : {}),
      ...(fast4 !== undefined ? { fast4 } : {}),
      ...(choice !== undefined ? { choice } : {}),
      ...(r.model === "flash" || r.model === "clef" ? { model: r.model } : {}),
      ...(r.failed === true ? { failed: true as const } : {}),
      clef_ms: count0(r.clefMs),
      ...(typeof r.cmdMs === "number" && Number.isFinite(r.cmdMs) && r.cmdMs >= 0
        ? { cmd_ms: Math.floor(r.cmdMs) }
        : {}),
      ...(typeof r.exitCode === "number" && Number.isFinite(r.exitCode)
        ? { exit_code: Math.trunc(r.exitCode) }
        : {}),
      cmd: first.replace(/[^A-Za-z0-9._+-]/g, "").slice(0, 24),
    });
  }
  return out;
}

/** agent が報告した Clef の判断の集計を、公開用の形に絞る。判断が 0 回・壊れた値は undefined */
export function sanitizeScaleStats(v: unknown): PublicScaleStats | undefined {
  if (typeof v !== "object" || v === null) return undefined;
  const r = v as Record<string, unknown>;
  const decisions = count0(r.decisions);
  const skipped_light = count0(r.skippedLight);
  if (decisions <= 0 && skipped_light <= 0) return undefined;
  return {
    decisions,
    raised: count0(r.raised),
    clef_failures: count0(r.clefFailures),
    slow_not_raised: count0(r.slowNotRaised),
    skipped_light,
  };
}
