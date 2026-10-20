# rovo が使う Cloudflare のリソース。docs/deploy.md の 7・9・10 節に対応する。
# 作らないもの: MCP Server Portal / Access（別のインフラの管理側）、Anthropic の API キー（AI Gateway の画面で BYOK）、
# Worker 本体（wrangler deploy）、Worker の secret（mise run deploy:secrets）。

locals {
  archive_bucket = "${var.name_prefix}-archive"
  audit_bucket   = "${var.name_prefix}-audit"
  script_names   = [var.worker_names.gateway, var.worker_names.agent, var.worker_names.web]
}

# ---- R2 ---------------------------------------------------------------------

# gateway の LOGS（終端になったタスクのコピー）。公開設定（r2.dev・カスタムドメイン）は作らないので非公開。
resource "cloudflare_r2_bucket" "archive" {
  account_id = var.account_id
  name       = local.archive_bucket
}

# 監査ログの Logpush の宛先。非公開。
resource "cloudflare_r2_bucket" "audit" {
  account_id = var.account_id
  name       = local.audit_bucket
}

resource "cloudflare_r2_bucket_lifecycle" "archive" {
  account_id  = var.account_id
  bucket_name = cloudflare_r2_bucket.archive.name

  rules = [{
    id         = "expire-archive"
    enabled    = true
    conditions = { prefix = "" }
    delete_objects_transition = {
      condition = {
        type    = "Age"
        max_age = var.archive_retention_days * 86400
      }
    }
  }]
}

resource "cloudflare_r2_bucket_lifecycle" "audit" {
  account_id  = var.account_id
  bucket_name = cloudflare_r2_bucket.audit.name

  rules = [{
    id         = "expire-audit"
    enabled    = true
    conditions = { prefix = "" }
    delete_objects_transition = {
      condition = {
        type    = "Age"
        max_age = var.audit_retention_days * 86400
      }
    }
  }]
}

# ---- KV ---------------------------------------------------------------------

# gateway の OAUTH_KV
resource "cloudflare_workers_kv_namespace" "oauth" {
  account_id = var.account_id
  title      = "${var.name_prefix}-oauth"
}

# ---- AI Gateway -------------------------------------------------------------
# 認証は付ける（BYOK の前提）。agent と web は AI バインディングと AI_GATEWAY_ID だけで呼び、
# バインディングからの呼び出しは認証済みとして扱われるので、gateway token の secret は要らない。
# Anthropic の API キーは Terraform に入れず、AI Gateway の画面で BYOK として登録する。
# byok_only: キーが無いときに Unified Billing（Cloudflare のクレジット）へ流さず、400 で止める。
# キャッシュは切る（TTL 0。モデルの応答を使い回さない）。レート制限は切る（0 = 無効）。
# 費用の上限は gateway の MONTHLY_BUDGET_USD / TASK_BUDGET_USD が担う。

resource "cloudflare_ai_gateway" "this" {
  account_id = var.account_id
  id         = "${var.name_prefix}-gateway"

  authentication             = true
  byok_only                  = true
  collect_logs               = var.ai_gateway_collect_logs
  log_classification         = var.ai_gateway_log_classification
  cache_ttl                  = 0
  cache_invalidate_on_update = false
  rate_limiting_interval     = 0
  rate_limiting_limit        = 0
}

# ---- Logpush（監査ログ） ------------------------------------------------------

# 権限は R2 のバケット内オブジェクトの書き込みだけ。対象は監査用バケットだけ。
data "cloudflare_api_token_permission_groups_list" "r2_item_write" {
  count = var.r2_item_write_permission_group_id == null ? 1 : 0
  name  = "Workers R2 Storage Bucket Item Write"
}

locals {
  # 名前の完全一致で選ぶ。見つからなければ plan で止まる（添字が範囲外）。
  r2_item_write_permission_group_id = coalesce(
    var.r2_item_write_permission_group_id,
    try([for g in data.cloudflare_api_token_permission_groups_list.r2_item_write[0].result : g.id if g.name == "Workers R2 Storage Bucket Item Write"][0], null),
  )
}

resource "cloudflare_api_token" "logpush" {
  name = "${var.name_prefix}-logpush-audit-r2"

  policies = [{
    effect            = "allow"
    permission_groups = [{ id = local.r2_item_write_permission_group_id }]
    resources = jsonencode({
      "com.cloudflare.edge.r2.bucket.${var.account_id}_default_${cloudflare_r2_bucket.audit.name}" = "*"
    })
  }]
}

# R2 を宛先にした Logpush の資格情報は、API トークンから作る S3 互換の鍵:
# access-key-id はトークンの id、secret-access-key はトークンの値の SHA-256。
resource "cloudflare_logpush_job" "audit" {
  account_id = var.account_id
  name       = "${var.name_prefix}-audit"
  dataset    = "workers_trace_events"
  enabled    = var.logpush_enabled

  destination_conf = join("", [
    "r2://${cloudflare_r2_bucket.audit.name}/workers_trace_events/{DATE}",
    "?account-id=${var.account_id}",
    "&access-key-id=${cloudflare_api_token.logpush.id}",
    "&secret-access-key=${sha256(cloudflare_api_token.logpush.value)}",
  ])

  # 絞らないと、アカウントの全 Worker のログが入る。
  filter = jsonencode({
    where = {
      key      = "ScriptName"
      operator = "in"
      value    = local.script_names
    }
  })

  output_options = {
    field_names      = ["Event", "EventTimestampMs", "Exceptions", "Logs", "Outcome", "ScriptName"] # API の並び（アルファベット順）に合わせる
    timestamp_format = "rfc3339"
  }
}
