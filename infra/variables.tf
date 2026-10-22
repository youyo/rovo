variable "account_id" {
  description = "Cloudflare のアカウント ID（32 桁の 16 進数）。"
  type        = string

  validation {
    condition     = can(regex("^[0-9a-f]{32}$", var.account_id))
    error_message = "account_id は 32 桁の小文字の 16 進数にしてください。"
  }
}

variable "name_prefix" {
  description = "作るリソースの名前の接頭辞。R2 バケットと AI Gateway の名前になるので、小文字・数字・ハイフンだけ。"
  type        = string
  default     = "rovo"

  validation {
    condition     = can(regex("^[a-z0-9][a-z0-9-]{0,30}[a-z0-9]$", var.name_prefix))
    error_message = "name_prefix は 2〜32 文字の小文字・数字・ハイフンで、両端はハイフン以外にしてください。"
  }
}

variable "archive_retention_days" {
  description = "アーカイブ用バケット（gateway の LOGS）のオブジェクトを削除するまでの日数。"
  type        = number
  default     = 90

  validation {
    condition     = var.archive_retention_days >= 1 && floor(var.archive_retention_days) == var.archive_retention_days
    error_message = "archive_retention_days は 1 以上の整数にしてください。"
  }
}

variable "audit_retention_days" {
  description = "監査ログ用バケットのオブジェクトを削除するまでの日数。"
  type        = number
  default     = 365

  validation {
    condition     = var.audit_retention_days >= 1 && floor(var.audit_retention_days) == var.audit_retention_days
    error_message = "audit_retention_days は 1 以上の整数にしてください。"
  }
}

variable "worker_names" {
  description = "Logpush の対象にする 3 つの Worker の名前（ScriptName）。各 wrangler 設定の name と一致させる。"
  type = object({
    gateway = string
    agent   = string
    web     = string
  })
  default = {
    gateway = "rovo-gateway"
    agent   = "rovo-agent"
    web     = "rovo-web"
  }

  validation {
    condition     = alltrue([for n in values(var.worker_names) : length(trimspace(n)) > 0])
    error_message = "worker_names に空の名前は指定できません。"
  }

  validation {
    condition     = length(distinct(values(var.worker_names))) == 3
    error_message = "worker_names の 3 つの名前は互いに異なる必要があります。"
  }
}

variable "ai_gateway_collect_logs" {
  description = "AI Gateway のログ収集。誰がいくら使ったかの集計（metadata の userId / taskId / caller）に使う。"
  type        = bool
  default     = true
}

variable "ai_gateway_log_classification" {
  description = "AI Gateway のログ分類（User Insights のタスクとモデルの分析）。Cloudflare が保存されたプロンプトと応答（対象リポジトリのコードを含む）を分類するので、既定は無効。ai_gateway_collect_logs が true のときだけ有効にできる。"
  type        = bool
  default     = false

  validation {
    condition     = !var.ai_gateway_log_classification || var.ai_gateway_collect_logs
    error_message = "ai_gateway_log_classification を true にするには ai_gateway_collect_logs も true にする。"
  }
}

variable "logpush_enabled" {
  description = "Logpush のジョブを有効にするか。"
  type        = bool
  default     = true
}

variable "r2_item_write_permission_group_id" {
  description = "API トークンの権限グループ「Workers R2 Storage Bucket Item Write」の ID。通常は指定しない（null なら名前で検索する）。名前が変わって検索できないときだけ、API の permission_groups 一覧の ID を指定する。"
  type        = string
  default     = null

  validation {
    condition     = var.r2_item_write_permission_group_id == null || can(regex("^[0-9a-f]{32}$", var.r2_item_write_permission_group_id))
    error_message = "r2_item_write_permission_group_id は 32 桁の小文字の 16 進数にしてください。"
  }
}

variable "account_analytics_read_permission_group_id" {
  description = "API トークンの権限グループ「Account Analytics Read」（scope は com.cloudflare.api.account。GraphQL Analytics API の読み取り）の ID。通常は指定しない（null なら名前で検索する）。名前が変わって検索できないときだけ、API の permission_groups 一覧の ID を指定する。"
  type        = string
  default     = null

  validation {
    condition     = var.account_analytics_read_permission_group_id == null || can(regex("^[0-9a-f]{32}$", var.account_analytics_read_permission_group_id))
    error_message = "account_analytics_read_permission_group_id は 32 桁の小文字の 16 進数にしてください。"
  }
}

variable "ai_gateway_read_permission_group_id" {
  description = "API トークンの権限グループ「AI Gateway Read」（scope は com.cloudflare.api.account）の ID。通常は指定しない（null なら名前で検索する）。名前が変わって検索できないときだけ、API の permission_groups 一覧の ID を指定する。"
  type        = string
  default     = null

  validation {
    condition     = var.ai_gateway_read_permission_group_id == null || can(regex("^[0-9a-f]{32}$", var.ai_gateway_read_permission_group_id))
    error_message = "ai_gateway_read_permission_group_id は 32 桁の小文字の 16 進数にしてください。"
  }
}
