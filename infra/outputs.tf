# 下流の wrangler 設定（ROVO_DEPLOY_DIR）の元になる値。`mise run deploy:config` が読む（kv_namespace_id / archive_bucket_name / ai_gateway_id / ai_web_gateway_id）。

output "kv_namespace_id" {
  description = "gateway の kv_namespaces[].id（OAUTH_KV）"
  value       = cloudflare_workers_kv_namespace.oauth.id
}

output "archive_bucket_name" {
  description = "gateway の r2_buckets[].bucket_name（LOGS）"
  value       = cloudflare_r2_bucket.archive.name
}

output "audit_bucket_name" {
  description = "監査ログ（Logpush）の宛先のバケット。wrangler 設定には書かない"
  value       = cloudflare_r2_bucket.audit.name
}

output "ai_gateway_id" {
  description = "agent と gateway の vars.AI_GATEWAY_ID（Claude 用。byok_only）"
  value       = cloudflare_ai_gateway.this.id
}

output "ai_web_gateway_id" {
  description = "web の vars.AI_GATEWAY_ID（Web Search と Clef 用。byok_only なし。Web Search API をクレジットで払う）"
  value       = cloudflare_ai_gateway.web.id
}

# 秘密。state に平文で残る（Logpush 用トークンと同じ扱い。README）。wrangler 設定には書かない。
# 読むのは `mise run deploy:secrets` だけ（terraform output -raw gateway_cloudflare_api_token を wrangler secret put に流す）。
output "gateway_cloudflare_api_token" {
  description = "gateway の secret CLOUDFLARE_API_TOKEN（AI Gateway Read だけ。sensitive）"
  value       = cloudflare_api_token.ai_gateway_read.value
  sensitive   = true
}
