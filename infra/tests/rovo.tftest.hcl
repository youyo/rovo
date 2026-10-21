# plan の段階の振る舞いのテスト。Cloudflare の資格情報は要らない（mock_provider）。
# destination_conf のように apply まで値が決まらないものだけ、mock への apply で確かめる（実アカウントには触れない）。

mock_provider "cloudflare" {}

variables {
  # 32 桁の 16 進数のリテラルを置かない（scan:secrets が account id と区別できないため）
  account_id = "0123456789abcdef${"0123456789abcdef"}"
  # provider の mock は「オブジェクトのリストの属性」に値を入れられず、権限グループの検索結果（data）を差し替えられない。
  # そのため ID を直接渡し、検索（data）は count = 0 で省く。検索のほうは plan で確かめられない（README に書く）。
  r2_item_write_permission_group_id = "fedcba9876543210${"fedcba9876543210"}"
  # 同上（「AI Gateway Read」の権限グループ）
  ai_gateway_read_permission_group_id = "0011223344556677${"8899aabbccddeeff"}"
}

run "logpush_filter_has_three_script_names" {
  command = plan

  assert {
    condition     = jsondecode(cloudflare_logpush_job.audit.filter).where.key == "ScriptName"
    error_message = "filter のキーが ScriptName ではない"
  }
  assert {
    condition     = jsondecode(cloudflare_logpush_job.audit.filter).where.operator == "in"
    error_message = "filter の演算子が in ではない"
  }
  assert {
    condition     = jsondecode(cloudflare_logpush_job.audit.filter).where.value == ["rovo-gateway", "rovo-agent", "rovo-web"]
    error_message = "filter の ScriptName が rovo の 3 つの Worker だけになっていない"
  }
  assert {
    condition     = cloudflare_logpush_job.audit.dataset == "workers_trace_events"
    error_message = "データセットが workers_trace_events ではない"
  }
}

run "logpush_field_names_are_sorted" {
  command = plan

  # API はフィールドをアルファベット順に並べ替えて返す。順序が違うと plan のたびに差分が出る
  assert {
    condition     = cloudflare_logpush_job.audit.output_options.field_names == sort(cloudflare_logpush_job.audit.output_options.field_names)
    error_message = "Logpush の field_names がアルファベット順になっていない（API の並びと合わず、毎回差分が出る）"
  }
}

run "logpush_filter_follows_worker_names" {
  command = plan

  variables {
    worker_names = {
      gateway = "x-gateway"
      agent   = "x-agent"
      web     = "x-web"
    }
  }

  assert {
    condition     = jsondecode(cloudflare_logpush_job.audit.filter).where.value == ["x-gateway", "x-agent", "x-web"]
    error_message = "worker_names が filter に反映されていない"
  }
}

run "two_distinct_buckets" {
  command = plan

  assert {
    condition     = cloudflare_r2_bucket.archive.name == "rovo-archive" && cloudflare_r2_bucket.audit.name == "rovo-audit"
    error_message = "バケット名が接頭辞から決まっていない"
  }
  assert {
    condition     = cloudflare_r2_bucket.archive.name != cloudflare_r2_bucket.audit.name
    error_message = "アーカイブと監査のバケットが同じ名前"
  }
}

run "name_prefix_is_applied" {
  command = plan

  variables {
    name_prefix = "acme"
  }

  assert {
    condition     = cloudflare_r2_bucket.archive.name == "acme-archive" && cloudflare_r2_bucket.audit.name == "acme-audit"
    error_message = "name_prefix がバケット名に反映されていない"
  }
  assert {
    condition     = cloudflare_workers_kv_namespace.oauth.title == "acme-oauth"
    error_message = "name_prefix が KV に反映されていない"
  }
  assert {
    condition     = cloudflare_ai_gateway.this.id == "acme-gateway"
    error_message = "name_prefix が AI Gateway に反映されていない"
  }
}

run "lifecycle_defaults" {
  command = plan

  assert {
    condition     = cloudflare_r2_bucket_lifecycle.archive.bucket_name == "rovo-archive"
    error_message = "アーカイブのライフサイクルの対象バケットが違う"
  }
  assert {
    condition     = cloudflare_r2_bucket_lifecycle.archive.rules[0].delete_objects_transition.condition.type == "Age"
    error_message = "ライフサイクルが日数（Age）の削除ではない"
  }
  assert {
    condition     = cloudflare_r2_bucket_lifecycle.archive.rules[0].delete_objects_transition.condition.max_age == 90 * 86400
    error_message = "アーカイブの既定が 90 日（秒で 7776000）ではない"
  }
  assert {
    condition     = cloudflare_r2_bucket_lifecycle.audit.bucket_name == "rovo-audit"
    error_message = "監査のライフサイクルの対象バケットが違う"
  }
  assert {
    condition     = cloudflare_r2_bucket_lifecycle.audit.rules[0].delete_objects_transition.condition.max_age == 365 * 86400
    error_message = "監査の既定が 365 日ではない"
  }
}

run "lifecycle_follows_variables" {
  command = plan

  variables {
    archive_retention_days = 30
    audit_retention_days   = 730
  }

  assert {
    condition     = cloudflare_r2_bucket_lifecycle.archive.rules[0].delete_objects_transition.condition.max_age == 30 * 86400
    error_message = "archive_retention_days が反映されていない"
  }
  assert {
    condition     = cloudflare_r2_bucket_lifecycle.audit.rules[0].delete_objects_transition.condition.max_age == 730 * 86400
    error_message = "audit_retention_days が反映されていない"
  }
}

run "ai_gateway_auth_and_byok_only" {
  command = plan

  # BYOK はゲートウェイの認証が前提。AI バインディングからの呼び出しは認証済みとして扱われる
  assert {
    condition     = cloudflare_ai_gateway.this.authentication == true
    error_message = "AI Gateway の認証が無効（BYOK のキーを保存できない）"
  }
  # BYOK のキーが無いときに Unified Billing（Cloudflare のクレジット）へ流れないようにする
  assert {
    condition     = cloudflare_ai_gateway.this.byok_only == true
    error_message = "AI Gateway の byok_only が無効（キーが無いと Unified Billing に流れる）"
  }
  assert {
    condition     = cloudflare_ai_gateway.this.collect_logs == true
    error_message = "AI Gateway のログ収集が既定で有効ではない"
  }
}

# web 専用の AI Gateway。Web Search API をクレジットで払うため byok_only にしない（byok_only だと 400 で必ず失敗する）
run "ai_web_gateway_is_not_byok_only" {
  command = plan

  assert {
    condition     = cloudflare_ai_gateway.web.id == "rovo-web-gateway" && cloudflare_ai_gateway.web.id != cloudflare_ai_gateway.this.id
    error_message = "web 専用の AI Gateway の id が <name_prefix>-web-gateway ではない、または Claude 用と同じ"
  }
  assert {
    condition     = cloudflare_ai_gateway.web.byok_only == false
    error_message = "web 専用の AI Gateway が byok_only（Web Search をクレジットで払えず、必ず失敗する）"
  }
  assert {
    condition     = cloudflare_ai_gateway.this.byok_only == true
    error_message = "Claude 用の AI Gateway は byok_only のままにする"
  }
  assert {
    condition     = cloudflare_ai_gateway.web.authentication == true && cloudflare_ai_gateway.web.cache_ttl == 0 && cloudflare_ai_gateway.web.rate_limiting_limit == 0 && cloudflare_ai_gateway.web.collect_logs == cloudflare_ai_gateway.this.collect_logs
    error_message = "web 専用の AI Gateway の認証・キャッシュ・レート制限・ログが Claude 用と揃っていない"
  }
}

run "token_is_scoped_to_audit_bucket" {
  command = plan

  assert {
    condition     = length(cloudflare_api_token.logpush.policies) == 1
    error_message = "Logpush 用トークンのポリシーが 1 つではない"
  }
  assert {
    condition     = keys(jsondecode(cloudflare_api_token.logpush.policies[0].resources)) == ["com.cloudflare.edge.r2.bucket.${var.account_id}_default_rovo-audit"]
    error_message = "トークンの対象が監査用バケットだけになっていない"
  }
  assert {
    condition     = [for g in cloudflare_api_token.logpush.policies[0].permission_groups : g.id] == [var.r2_item_write_permission_group_id]
    error_message = "トークンの権限が R2 のバケット内オブジェクトの書き込みだけになっていない"
  }
}

# gateway の読み取り用トークン（D10b の CLOUDFLARE_API_TOKEN。D12 で Terraform が作る）。権限は AI Gateway の読み取りだけ。
run "gateway_read_token_is_read_only_and_account_scoped" {
  command = plan

  assert {
    condition     = length(cloudflare_api_token.ai_gateway_read.policies) == 1
    error_message = "gateway 用トークンのポリシーが 1 つではない"
  }
  assert {
    condition     = [for g in cloudflare_api_token.ai_gateway_read.policies[0].permission_groups : g.id] == [var.ai_gateway_read_permission_group_id]
    error_message = "gateway 用トークンの権限が「AI Gateway Read」だけになっていない"
  }
  assert {
    condition     = jsondecode(cloudflare_api_token.ai_gateway_read.policies[0].resources) == { "com.cloudflare.api.account.${var.account_id}" = "*" }
    error_message = "gateway 用トークンの対象がこのアカウントだけになっていない"
  }
  assert {
    condition     = cloudflare_api_token.ai_gateway_read.policies[0].effect == "allow"
    error_message = "gateway 用トークンのポリシーが allow ではない"
  }
  assert {
    condition     = cloudflare_api_token.ai_gateway_read.name == "rovo-gateway-ai-gateway-read"
    error_message = "gateway 用トークンの名前が接頭辞から決まっていない"
  }
}

run "gateway_read_token_name_follows_prefix" {
  command = plan

  variables {
    name_prefix = "acme"
  }

  assert {
    condition     = cloudflare_api_token.ai_gateway_read.name == "acme-gateway-ai-gateway-read"
    error_message = "name_prefix がトークンの名前に反映されていない"
  }
}

run "gateway_read_token_is_distinct_from_logpush_token" {
  command = plan

  assert {
    condition     = cloudflare_api_token.ai_gateway_read.name != cloudflare_api_token.logpush.name
    error_message = "Logpush 用と gateway 用のトークンが同じ名前"
  }
  assert {
    condition     = [for g in cloudflare_api_token.ai_gateway_read.policies[0].permission_groups : g.id] != [for g in cloudflare_api_token.logpush.policies[0].permission_groups : g.id]
    error_message = "Logpush 用と gateway 用のトークンの権限が同じ（権限を共有しない）"
  }
}

# destination_conf は token の id / value に依存し、apply まで決まらない。mock への apply で確かめる。
run "logpush_destination_is_audit_bucket" {
  command = apply

  assert {
    condition     = startswith(cloudflare_logpush_job.audit.destination_conf, "r2://rovo-audit/")
    error_message = "宛先が監査用バケットではない"
  }
  assert {
    condition     = strcontains(cloudflare_logpush_job.audit.destination_conf, "{DATE}")
    error_message = "日付ごとのサブフォルダ（{DATE}）が無い"
  }
  assert {
    condition     = strcontains(cloudflare_logpush_job.audit.destination_conf, "account-id=${var.account_id}")
    error_message = "account-id が無い"
  }
  assert {
    condition     = strcontains(cloudflare_logpush_job.audit.destination_conf, "access-key-id=${cloudflare_api_token.logpush.id}")
    error_message = "access-key-id がトークンの id ではない"
  }
  assert {
    condition     = strcontains(cloudflare_logpush_job.audit.destination_conf, "secret-access-key=${sha256(cloudflare_api_token.logpush.value)}")
    error_message = "secret-access-key がトークンの値の sha256 ではない"
  }
  assert {
    condition     = !strcontains(cloudflare_logpush_job.audit.destination_conf, "rovo-archive")
    error_message = "宛先にアーカイブ用バケットが混ざっている"
  }
}

run "outputs" {
  command = apply

  assert {
    condition     = output.kv_namespace_id == cloudflare_workers_kv_namespace.oauth.id
    error_message = "kv_namespace_id が KV の id ではない"
  }
  assert {
    condition     = output.archive_bucket_name == "rovo-archive" && output.audit_bucket_name == "rovo-audit"
    error_message = "バケット名の output が違う"
  }
  assert {
    condition     = output.ai_gateway_id == "rovo-gateway"
    error_message = "ai_gateway_id の output が違う"
  }
  assert {
    condition     = output.ai_web_gateway_id == "rovo-web-gateway"
    error_message = "ai_web_gateway_id の output が違う"
  }
  # sensitive の output は、そのままでは比較できない（nonsensitive で外して比べる。テストの中だけ）
  assert {
    condition     = nonsensitive(output.gateway_cloudflare_api_token) == nonsensitive(cloudflare_api_token.ai_gateway_read.value)
    error_message = "gateway_cloudflare_api_token の output が gateway 用トークンの値ではない"
  }
}

run "reject_zero_archive_days" {
  command = plan
  variables {
    archive_retention_days = 0
  }
  expect_failures = [var.archive_retention_days]
}

run "reject_zero_audit_days" {
  command = plan
  variables {
    audit_retention_days = 0
  }
  expect_failures = [var.audit_retention_days]
}

run "reject_negative_days" {
  command = plan
  variables {
    audit_retention_days = -5
  }
  expect_failures = [var.audit_retention_days]
}

run "reject_fractional_days" {
  command = plan
  variables {
    archive_retention_days = 1.5
  }
  expect_failures = [var.archive_retention_days]
}

run "reject_empty_worker_name" {
  command = plan
  variables {
    worker_names = {
      gateway = "rovo-gateway"
      agent   = ""
      web     = "rovo-web"
    }
  }
  expect_failures = [var.worker_names]
}

run "reject_duplicate_worker_names" {
  command = plan
  variables {
    worker_names = {
      gateway = "same"
      agent   = "same"
      web     = "rovo-web"
    }
  }
  expect_failures = [var.worker_names]
}

run "reject_bad_prefix" {
  command = plan
  variables {
    name_prefix = "Bad_Prefix"
  }
  expect_failures = [var.name_prefix]
}

run "reject_bad_account_id" {
  command = plan
  variables {
    account_id = "not-an-account-id"
  }
  expect_failures = [var.account_id]
}

run "reject_bad_ai_gateway_read_permission_group_id" {
  command = plan

  variables {
    ai_gateway_read_permission_group_id = "not-hex"
  }

  expect_failures = [var.ai_gateway_read_permission_group_id]
}

run "reject_bad_permission_group_id" {
  command = plan
  variables {
    r2_item_write_permission_group_id = "not-an-id"
  }
  expect_failures = [var.r2_item_write_permission_group_id]
}

run "log_classification_default_off" {
  command = plan

  # プロンプトと応答（対象リポジトリのコードを含む）を Cloudflare が分類するので、既定は無効
  assert {
    condition     = cloudflare_ai_gateway.this.log_classification == false
    error_message = "ログ分類が既定で無効になっていない"
  }
}

run "log_classification_can_be_enabled" {
  command = plan

  variables {
    ai_gateway_log_classification = true
  }

  assert {
    condition     = cloudflare_ai_gateway.this.log_classification == true
    error_message = "ai_gateway_log_classification が反映されていない"
  }
}

run "log_classification_requires_collect_logs" {
  command = plan

  variables {
    ai_gateway_collect_logs       = false
    ai_gateway_log_classification = true
  }

  expect_failures = [var.ai_gateway_log_classification]
}
