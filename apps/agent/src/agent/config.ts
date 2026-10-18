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
