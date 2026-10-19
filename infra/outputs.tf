# 下流の wrangler 設定（ROVO_DEPLOY_DIR）に書き写す値。

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
  description = "agent と web の vars.AI_GATEWAY_ID"
  value       = cloudflare_ai_gateway.this.id
}
