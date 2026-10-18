import type { CallContext, ModelEvaluation } from "../types";

/**
 * 安全性の評価器（設計 15.5）。既定の実装は Clef-flash（safety/clef.ts）。
 * Clef（@cf/cloudflare/clef）や Jev 本体に差し替えられるよう、インターフェースにしている。
 *
 * 実装は例外を投げず、失敗は `complete: false` と `failure` で返すこと。
 * 呼び出し側（Policy Engine）は complete でない評価を unknown として扱う。
 */
export interface SafetyEvaluator {
  readonly name: string;
  readonly modelVersion: string;
  /** `text` の全体を評価する。評価の指示は評価器側が持ち、`text` は評価対象のデータとしてだけ渡す。 */
  evaluate(text: string, ctx: CallContext): Promise<ModelEvaluation>;
}
