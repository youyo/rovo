import { DEFAULT_MODEL, parseAgentModels } from "@rovo/models";

/** 既定のモデル（env の AGENT_MODEL。空なら DEFAULT_MODEL）。 */
export function defaultModel(env: { AGENT_MODEL?: string }): string {
  return env.AGENT_MODEL || DEFAULT_MODEL;
}

/**
 * このデプロイで使えるモデル（env の AGENT_MODELS。カンマ区切り）。未設定なら既定のモデルだけ（fail-closed）。
 * 許可リスト（packages/models）に無い id は無視する（起動はエラーにしない）。
 */
export function agentModels(env: { AGENT_MODEL?: string; AGENT_MODELS?: string }): string[] {
  const { models, ignored } = parseAgentModels(env.AGENT_MODELS, defaultModel(env));
  if (ignored.length > 0) console.error("agent_models_ignored", ignored.length);
  return models;
}

/**
 * 本番（ENVIRONMENT が test 以外）では AI Gateway の経由を必須にする（設計 15.2）。
 * AI_GATEWAY_ID が空なら start の時点で拒否する理由を返す。
 */
export function aiGatewayRejection(env: {
  ENVIRONMENT?: string;
  AI_GATEWAY_ID?: string;
}): string | undefined {
  if (env.ENVIRONMENT === "test") return undefined;
  return env.AI_GATEWAY_ID ? undefined : "ai_gateway_not_configured";
}
