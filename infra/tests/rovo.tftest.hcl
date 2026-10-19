# plan の段階の振る舞いのテスト。Cloudflare の資格情報は要らない（mock_provider）。
# destination_conf のように apply まで値が決まらないものだけ、mock への apply で確かめる（実アカウントには触れない）。

mock_provider "cloudflare" {}

variables {
  # 32 桁の 16 進数のリテラルを置かない（scan:secrets が account id と区別できないため）
  account_id = "0123456789abcdef${"0123456789abcdef"}"
  # provider の mock は「オブジェクトのリストの属性」に値を入れられず、権限グループの検索結果（data）を差し替えられない。
  # そのため ID を直接渡し、検索（data）は count = 0 で省く。検索のほうは plan で確かめられない（README に書く）。
  r2_item_write_permission_group_id = "fedcba9876543210${"fedcba9876543210"}"
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

run "ai_gateway_without_auth" {
  command = plan

  assert {
    condition     = cloudflare_ai_gateway.this.authentication == false
    error_message = "AI Gateway に認証が付いている（不要）"
  }
  assert {
    condition     = cloudflare_ai_gateway.this.collect_logs == true
    error_message = "AI Gateway のログ収集が既定で有効ではない"
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

run "reject_bad_permission_group_id" {
  command = plan
  variables {
    r2_item_write_permission_group_id = "not-an-id"
  }
  expect_failures = [var.r2_item_write_permission_group_id]
}
