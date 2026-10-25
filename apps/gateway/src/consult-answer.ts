import type { Effort } from "@rovo/models";
import type { ConsultResult } from "./agent/contract";
import type { ErrorCode } from "./tasks/service";

/**
 * consult の答えの形と、AgentDO の応答（ConsultResult）の読み方。consult.ts（リクエスト側）と UserDO（裏の完了処理）が共有する。
 * 失敗の message は固定の文言にする（ワーカーの自由文を返さない。invalid_input の理由コードだけは従来どおり付ける）。
 */

/** 成功の値（今の consult の応答と同じ形。フィールドを足さない） */
export type ConsultValue = {
  text: string;
  model: string;
  usage: { input: number; output: number; cache_read: number; cache_write: number };
  cost_usd: number;
  /** 使った思考レベル */
  effort?: Effort;
};

/** 失敗の中身（50 秒以内の失敗のエラーと、consult_result の failed の error で共通） */
export type ConsultFailure = { code: ErrorCode; message: string; retry_after_seconds?: number };

export const UPSTREAM_RETRY_AFTER_SECONDS = 30;

export function isConsultResult(v: unknown): v is ConsultResult {
  if (typeof v !== "object" || v === null) return false;
  const r = v as Record<string, unknown>;
  const finiteCost = typeof r.costUsd === "number" && Number.isFinite(r.costUsd) && r.costUsd >= 0;
  if (r.ok === true) {
    const u = r.usage as Record<string, unknown> | undefined;
    return (
      finiteCost &&
      typeof r.text === "string" &&
      typeof r.model === "string" &&
      typeof u === "object" &&
      u !== null &&
      ["input", "output", "cacheRead", "cacheWrite"].every(
        (k) => typeof u[k] === "number" && Number.isFinite(u[k]) && (u[k] as number) >= 0,
      )
    );
  }
  return r.ok === false && finiteCost && typeof r.code === "string";
}

/** AgentDO の応答を読んだ結果。精算の額（settleUsd）と、答え（done / failed）をまとめる。 */
export type ConsultOutcome =
  | {
      status: "done";
      value: ConsultValue;
      settleUsd: number;
      estimated: boolean;
      usageMissing: boolean;
    }
  | {
      status: "failed";
      error: ConsultFailure;
      /** null は実費が分からない（予約額で精算する） */
      settleUsd: number | null;
      estimated: boolean;
    };

const UNAVAILABLE: ConsultFailure = {
  code: "upstream_unavailable",
  message: "the consult is temporarily unavailable; retry later",
  retry_after_seconds: UPSTREAM_RETRY_AFTER_SECONDS,
};

/** 例外・時間切れ・期限切れ。実費が分からないので予約額で精算する失敗 */
export function unavailableFailure(): ConsultFailure {
  return { ...UNAVAILABLE };
}

/** result が undefined のときは例外・時間切れ（実費不明）。壊れた応答は internal（これも実費不明）。 */
export function interpretConsult(
  result: ConsultResult | undefined,
  /** 依頼で渡した（または gateway が解決した）思考レベル。agent が effort を返さないときの値 */
  requestedEffort?: Effort,
): ConsultOutcome {
  if (result === undefined) {
    return { status: "failed", error: unavailableFailure(), settleUsd: null, estimated: true };
  }
  if (!isConsultResult(result)) {
    return {
      status: "failed",
      error: { code: "internal", message: "internal error" },
      settleUsd: null,
      estimated: true,
    };
  }
  const estimated = result.costEstimated === true;
  if (result.ok) {
    return {
      status: "done",
      value: {
        text: result.text,
        model: result.model,
        usage: {
          input: result.usage.input,
          output: result.usage.output,
          cache_read: result.usage.cacheRead,
          cache_write: result.usage.cacheWrite,
        },
        cost_usd: result.costUsd,
        ...((result.effort ?? requestedEffort) !== undefined
          ? { effort: (result.effort ?? requestedEffort) as Effort }
          : {}),
      },
      settleUsd: result.costUsd,
      estimated,
      usageMissing: result.usageMissing === true,
    };
  }
  const failure = ((): ConsultFailure => {
    // モデルがリクエストの中身を拒否した（4xx）。待っても直らないので retry_after_seconds は付けない
    if (result.code === "model_rejected") {
      return {
        code: "model_rejected",
        message:
          "the model rejected the request (a 4xx response, e.g. invalid_request_error); retrying the same request will not help. Change the input or the model",
      };
    }
    if (result.code === "model_error") {
      return {
        code: "upstream_unavailable",
        message: "the model call failed; retry later",
        retry_after_seconds: UPSTREAM_RETRY_AFTER_SECONDS,
      };
    }
    return {
      code: "invalid_input",
      message: `consult was rejected: ${result.code}. ${result.message}`,
    };
  })();
  return { status: "failed", error: failure, settleUsd: result.costUsd, estimated };
}
