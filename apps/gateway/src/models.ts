import {
  DEFAULT_MODEL,
  type Effort,
  type ModelProvider,
  modelInfo,
  parseAgentModels,
  pickDefaultModel,
  providerOf,
  resolveEfforts,
  supportedEfforts,
} from "@rovo/models";
import {
  type Candidate,
  DEFAULT_AUTO_MODEL_CANDIDATES,
  eligibleCandidates,
  parseCandidates,
} from "./model-selection";
import { loadProviderKeys, type ProviderKeysDeps, type ProviderKeysEnv } from "./provider-keys";

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
 * モデルの思考レベル（effort。モデルごとの既定）。packages/models の初期値に、env の MODEL_EFFORTS の上書きを重ねた最終の値。
 * task_start の effort でタスクごとに上書きできる（上書きしたタスクではこの値を使わない）。
 * 不正な項目（書式の誤り・モデルが受け付けない値など）は無視して初期値にする（起動はエラーにしない）。
 * agent の同名の var と同じ値にする（agent が実際に Pi へ渡す値と、ここで返す値を揃えるため）。
 * 許可リストに無いモデルは "off"（使えないモデルなので実際には呼ばれない）。
 */
export function effortOf(env: { MODEL_EFFORTS?: string }, modelId: string): Effort {
  const { efforts, ignored } = resolveEfforts(env.MODEL_EFFORTS);
  if (ignored.length > 0) console.error("model_efforts_ignored", ignored.length);
  return Object.hasOwn(efforts, modelId) ? (efforts[modelId] as Effort) : "off";
}

/**
 * task_start の effort（タスクごとの上書き）を、実際に使うモデルで検査する。使えれば undefined、使えなければ message
 * （そのモデルで使えるレベルの一覧つき。invalid_input に載せる）。モデルが決まったあと（指定、または rovo が選んだモデル）に呼ぶ。
 */
export function effortRejection(modelId: string, effort: Effort): string | undefined {
  const supported = supportedEfforts(modelId);
  if (supported.includes(effort)) return undefined;
  return `effort: "${effort}" is not supported by ${modelId}; supported efforts: ${supported.join(", ")}`;
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
  /** 思考レベルの既定（モデルごと。off / minimal / low / medium / high / xhigh / max）。task_start の effort で上書きできる。考える量が多いほど出力トークン＝費用が増える */
  effort: Effort;
  /** consult の tools（web_search / web_fetch。#135）を渡せるか。false のモデルに tools を渡すと invalid_input */
  tool_calling: boolean;
  /** 今使えるか（D10b）。AI Gateway にそのプロバイダーのキー（alias が default）が BYOK 登録されていないと false。Workers AI は常に true */
  available: boolean;
  /** available が false の理由。"no_provider_key"（キーが登録されていない）。available が true なら付かない */
  unavailable_reason?: "no_provider_key";
};

export type ModelEnv = Partial<ProviderKeysEnv> & {
  AGENT_MODEL?: string;
  AGENT_MODELS?: string;
  MODEL_EFFORTS?: string;
  /** consult の既定の思考レベル。未設定・不正は medium */
  CONSULT_EFFORT?: string;
  /** model を省略したときに Clef が選ぶ候補（カンマ区切り）。未設定は既定の 3 つ、空は自動選択をしない */
  AUTO_MODEL_CANDIDATES?: string;
};

/** プロバイダーのキーが登録されているか。keys が undefined（判定できない・未設定）なら従来どおり使える扱い。Workers AI はキー不要。 */
function hasKey(modelId: string, keys: ReadonlySet<ModelProvider> | undefined): boolean {
  const provider = providerOf(modelId);
  if (provider === undefined || provider === "workers-ai" || keys === undefined) return true;
  return keys.has(provider);
}

/** 登録済みのキー（default alias）を読む。KV が無い構成（Unit の部分的な env など）は判定できない扱い。 */
async function keysOf(env: ModelEnv, deps?: ProviderKeysDeps) {
  if (!env.OAUTH_KV) return undefined;
  return loadProviderKeys(env as ProviderKeysEnv, deps);
}

/** available なモデルの中の既定（AGENT_MODEL が available ならそれ。なければ固定の順序）。 */
function defaultAmong(env: ModelEnv, available: readonly string[]): string | undefined {
  return pickDefaultModel(defaultModelOf(env), available);
}

export type ResolvedModel =
  | { ok: true; model: string }
  | { ok: false; code: "invalid_input" | "model_unavailable"; message: string };

/**
 * task_start と consult が使うモデルを決める（D10b）。
 * - 指定あり: AGENT_MODELS の外は invalid_input、キーが無いプロバイダーのモデルは model_unavailable
 * - 省略: AGENT_MODEL が available ならそれ。なければ available なモデルから固定の順序で選ぶ。1 つも無ければ model_unavailable
 * - キーを判定できない（未設定・API の失敗でキャッシュも無い）ときは従来どおり（AGENT_MODELS の中なら通し、省略は AGENT_MODEL）
 */
export async function resolveModel(
  env: ModelEnv,
  requested: string | undefined,
  deps?: ProviderKeysDeps,
): Promise<ResolvedModel> {
  const allowed = agentModelsOf(env);
  if (requested !== undefined && !allowed.includes(requested)) {
    return {
      ok: false,
      code: "invalid_input",
      message: `model: "${requested}" is not available; call models_list for the models you can use`,
    };
  }
  const keys = await keysOf(env, deps);
  if (requested !== undefined) {
    if (hasKey(requested, keys)) return { ok: true, model: requested };
    const provider = providerOf(requested) ?? "the model's provider";
    return {
      ok: false,
      code: "model_unavailable",
      message: `model: "${requested}" is unavailable because no ${provider} key is registered in AI Gateway (BYOK). Call models_list for the models you can use (available: true), or register the key (alias: default) in the gateway's Provider Keys`,
    };
  }
  if (keys === undefined) return { ok: true, model: defaultModelOf(env) };
  const model = defaultAmong(
    env,
    allowed.filter((id) => hasKey(id, keys)),
  );
  if (model === undefined) {
    return {
      ok: false,
      code: "model_unavailable",
      message:
        "no model is available: no provider key (BYOK) is registered in AI Gateway for the models in AGENT_MODELS. Call models_list to see the state, or register an Anthropic / OpenAI key (alias: default) in the gateway's Provider Keys, or add a Workers AI model to AGENT_MODELS",
    };
  }
  return { ok: true, model };
}

/**
 * このデプロイのモデルの一覧（AGENT_MODELS の順。使えるかどうかを available に付ける。
 * 既定のモデル = model を省略したときに使われるモデルに default: true）。
 */
export async function listModels(env: ModelEnv, deps?: ProviderKeysDeps): Promise<ModelListing[]> {
  const keys = await keysOf(env, deps);
  const ids = agentModelsOf(env);
  const def =
    keys === undefined
      ? defaultModelOf(env)
      : defaultAmong(
          env,
          ids.filter((id) => hasKey(id, keys)),
        );
  const out: ModelListing[] = [];
  for (const id of ids) {
    const info = modelInfo(id);
    if (!info) continue;
    const available = hasKey(id, keys);
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
      tool_calling: info.toolCalling,
      available,
      ...(available ? {} : { unavailable_reason: "no_provider_key" as const }),
    });
  }
  return out;
}

/**
 * model を省略したときの自動選択の候補（env の AUTO_MODEL_CANDIDATES ∩ このデプロイで使えるモデル）。
 * 使えるとは、AGENT_MODELS にあり、プロバイダーのキー（D10b）が判定できて無い場合を除くこと。
 * 費用の安い順（haiku < sonnet < opus < fable）。anthropic 以外・等級の分からないモデルは入らない。
 * 未設定は既定の 3 つ（haiku / sonnet / opus。fable は env で足す）、空文字は自動選択をしない。
 */
export async function autoCandidates(env: ModelEnv, deps?: ProviderKeysDeps): Promise<Candidate[]> {
  const ids = parseCandidates(env.AUTO_MODEL_CANDIDATES ?? DEFAULT_AUTO_MODEL_CANDIDATES);
  if (ids.length === 0) return [];
  const keys = await keysOf(env, deps);
  return eligibleCandidates(ids, agentModelsOf(env), (id) => hasKey(id, keys));
}
