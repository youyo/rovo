import { type AuditFields, type AuditRecord, audit } from "./audit";

/**
 * 監査イベントの test 用シンク（ENVIRONMENT=test のときだけ有効。それ以外は何も記録しない）。
 *
 * 通しの E2E が stdout を走査せずに監査イベントを検証するための口。既存の /__test/ ルートと同じ形で、
 * 読み出しは POST /__test/audit（test-routes.ts）。
 *   - DO（TaskDO）が発行したものは、その DO の SQLite（test_audit テーブル）に記録し、testAudit() で読む。
 *     DO の中は同期で書けて、DO の退避をまたいで残る。
 *   - DO の外（Worker の認証失敗など）が発行したものは、OAUTH_KV に TTL つきで記録する（このファイル）。
 *     新しいバインディングは足さない。既存の test 用の仕組み（test-script:）と同じ置き場。
 */

export const AUDIT_KV_PREFIX = "test-audit:";
const AUDIT_KV_TTL_SECONDS = 3600;

let counter = 0;

const isTest = (env: Pick<Env, "ENVIRONMENT">): boolean => env.ENVIRONMENT === "test";

/**
 * DO の外（Worker）から監査イベントを出す。通常は console.log に出すだけ。test のときだけ KV にも記録する。
 * 記録の失敗は握りつぶす（監査の記録が本来の処理を壊してはならない）。
 */
export async function auditFromWorker(
  env: Pick<Env, "ENVIRONMENT" | "OAUTH_KV">,
  event: string,
  fields: AuditFields,
): Promise<void> {
  const record = audit(event, fields);
  if (record === null || !isTest(env)) return;
  // 時刻 → 同じプロセスでの発行順 → 乱数。キーの辞書順が発行順になる
  const key = `${AUDIT_KV_PREFIX}${String(record.ts).padStart(15, "0")}:${String(counter++ % 1_000_000).padStart(6, "0")}:${crypto.randomUUID()}`;
  try {
    await env.OAUTH_KV.put(key, JSON.stringify(record), { expirationTtl: AUDIT_KV_TTL_SECONDS });
  } catch (e) {
    console.error("audit_sink_error", e instanceof Error ? e.name : typeof e);
  }
}

/** test のとき、KV に記録された Worker 側の監査イベントを発行順に返す。それ以外は空。 */
export async function readWorkerAudit(
  env: Pick<Env, "ENVIRONMENT" | "OAUTH_KV">,
): Promise<AuditRecord[]> {
  if (!isTest(env)) return [];
  const names: string[] = [];
  let cursor: string | undefined;
  do {
    const page = await env.OAUTH_KV.list({
      prefix: AUDIT_KV_PREFIX,
      ...(cursor ? { cursor } : {}),
    });
    names.push(...page.keys.map((k) => k.name));
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);
  names.sort();
  const out: AuditRecord[] = [];
  for (const name of names) {
    const raw = await env.OAUTH_KV.get(name);
    if (raw !== null) out.push(JSON.parse(raw) as AuditRecord);
  }
  return out;
}
