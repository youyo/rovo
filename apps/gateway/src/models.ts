import {
  DEFAULT_MODEL,
  type Effort,
  modelInfo,
  parseAgentModels,
  resolveEfforts,
} from "@rovo/models";

/** 既定のモデル（env の AGENT_MODEL。空なら DEFAULT_MODEL）。agent の同名の var と同じ値にする。 */
export function defaultModelOf(env: { AGENT_MODEL?: string }): string {
  return env.AGENT_MODEL || DEFAULT_MODEL;
}

/**
 * このデプロイで使えるモデル（env の AGENT_MODELS。カンマ区切り）。未設定なら既定のモデルだけ（fail-closed）。
 * 許可リスト（packages/models。単価が分かるもの）に無い id は無視する（起動はエラーにしない）。
 * agent の同名の var と同じ値にする（食い違うと、gateway が通したモデルを agent が unknown_model で拒否する）。
 */
export function agentModelsOf(env: { AGENT_MODEL?: string; AGENT_MODELS?: string }): string[] {
  const { models, ignored } = parseAgentModels(env.AGENT_MODELS, defaultModelOf(env));
  if (ignored.length > 0) console.error("agent_models_ignored", ignored.length);
  return models;
}

/**
 * モデルの思考レベル（effort。モデルごとに固定）。packages/models の初期値に、env の MODEL_EFFORTS の上書きを重ねた最終の値。
 * 不正な項目（書式の誤り・モデルが受け付けない値など）は無視して初期値にする（起動はエラーにしない）。
 * agent の同名の var と同じ値にする（agent が実際に Pi へ渡す値と、ここで返す値を揃えるため）。
 * 許可リストに無いモデルは "off"（使えないモデルなので実際には呼ばれない）。
 */
export function effortOf(env: { MODEL_EFFORTS?: string }, modelId: string): Effort {
  const { efforts, ignored } = resolveEfforts(env.MODEL_EFFORTS);
  if (ignored.length > 0) console.error("model_efforts_ignored", ignored.length);
  return Object.hasOwn(efforts, modelId) ? (efforts[modelId] as Effort) : "off";
}

/** models_list の 1 件（D10）。単価は USD / 100 万トークン。 */
export type ModelListing = {
  id: string;
  provider: string;
  api: string;
  input_per_mtok: number;
  output_per_mtok: number;
  cache_read_per_mtok: number;
  cache_write_per_mtok: number;
  /** 入力が input_tokens_above を超える呼び出しに、全体へ適用する上位の単価 */
  tiers: {
    input_tokens_above: number;
    input_per_mtok: number;
    output_per_mtok: number;
    cache_read_per_mtok: number;
    cache_write_per_mtok: number;
  }[];
  context_window: number;
  default: boolean;
  /** 思考レベル（モデルごとに固定。off / minimal / low / medium / high / xhigh / max）。考える量が多いほど出力トークン＝費用が増える */
  effort: Effort;
};

/** このデプロイで使えるモデルの一覧（AGENT_MODELS の順。既定のモデルに default: true）。 */
export function listModels(env: {
  AGENT_MODEL?: string;
  AGENT_MODELS?: string;
  MODEL_EFFORTS?: string;
}): ModelListing[] {
  const def = defaultModelOf(env);
  const out: ModelListing[] = [];
  for (const id of agentModelsOf(env)) {
    const info = modelInfo(id);
    if (!info) continue;
    out.push({
      id,
      provider: info.provider,
      api: info.api,
      input_per_mtok: info.price.inputPerMTok,
      output_per_mtok: info.price.outputPerMTok,
      cache_read_per_mtok: info.price.cacheReadPerMTok,
      cache_write_per_mtok: info.price.cacheWritePerMTok,
      tiers: info.price.tiers.map((t) => ({
        input_tokens_above: t.inputTokensAbove,
        input_per_mtok: t.inputPerMTok,
        output_per_mtok: t.outputPerMTok,
        cache_read_per_mtok: t.cacheReadPerMTok,
        cache_write_per_mtok: t.cacheWritePerMTok,
      })),
      context_window: info.contextWindow,
      default: id === def,
      effort: effortOf(env, id),
    });
  }
  return out;
}
