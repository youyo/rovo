import { type AuditFields, type AuditRecord, audit } from "@rovo/audit";

/**
 * agent 側の監査の薄い adapter（phase6.md「監査ログ」）。
 * 出力の形・allowlist・値の検証は @rovo/audit が持つ。ここは「console.log に出す」ことと、
 * ENVIRONMENT=test のときだけ DO のストレージにも残す test 用のシンクだけを持つ。本番では記録も読み出しもしない。
 */

const TEST_AUDIT_KEY = "test_audit";
/** test 用のシンクに残す最大件数（古いものから捨てる） */
const TEST_AUDIT_MAX = 500;

export const isTestEnv = (env: { ENVIRONMENT?: string }): boolean => env.ENVIRONMENT === "test";

/** DO の同期 KV（ctx.storage.kv）のうち、シンクが使う部分 */
export interface SyncKv {
  get<T = unknown>(key: string): T | undefined;
  put(key: string, value: unknown): void;
}

/** test 用のシンクに 1 件足す。 */
export function appendTestAudit(kv: SyncKv, record: AuditRecord): void {
  const all = kv.get<AuditRecord[]>(TEST_AUDIT_KEY) ?? [];
  all.push(record);
  if (all.length > TEST_AUDIT_MAX) all.splice(0, all.length - TEST_AUDIT_MAX);
  kv.put(TEST_AUDIT_KEY, all);
}

/** test のとき、シンクに残った監査イベントを発行順に返す。それ以外は例外（本番に読み出し口は無い）。 */
export function readTestAudit(env: { ENVIRONMENT?: string }, kv: SyncKv): AuditRecord[] {
  if (!isTestEnv(env)) throw new Error("test only");
  return kv.get<AuditRecord[]>(TEST_AUDIT_KEY) ?? [];
}

/**
 * DO から監査イベントを出す。console.log に 1 行の JSON を出し、test のときだけ DO のストレージにも記録する。
 * 記録の失敗は握りつぶす（監査の記録が本来の処理を壊してはならない）。
 */
export function emitAudit(
  env: { ENVIRONMENT?: string },
  kv: SyncKv,
  event: string,
  fields: AuditFields,
): AuditRecord | null {
  const record = audit(event, fields);
  if (record !== null && isTestEnv(env)) {
    try {
      appendTestAudit(kv, record);
    } catch (e) {
      console.error("audit_sink_error", e instanceof Error ? e.name : typeof e);
    }
  }
  return record;
}
