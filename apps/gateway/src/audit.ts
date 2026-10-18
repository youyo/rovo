/**
 * 監査ログ（design 11.2 / phase6.md「監査ログ」）。
 *
 * 出力は 1 か所の関数 audit(event, fields) にまとめ、許可したフィールドと許可した形の値だけを通す（allowlist）。
 * 未知のフィールドと、形の合わない値は黙って落とす（変換して通さない）。トークン・本文・URL のパス・タスクの入力は
 * 出ない。reason など文字列は「固定のコード」の形（英小文字・数字・_）だけを許す。
 *
 * この文書は純粋関数だけを持つ（env にも DO にも触らない）。後で packages/audit や agent / web へ移しやすいように、
 * test 用のシンクは audit-sink.ts に分けてある。
 */

/** 監査イベントの名前（閉じた一覧）。一覧に無い名前は出力しない。 */
export const AUDIT_EVENTS = [
  "auth_failed",
  "authz_denied",
  "credential_issued",
  "credential_issue_failed",
  "credential_revoked",
  "credential_revoke_given_up",
  "task_cancelled",
  "task_ended_by_limit",
  "delivery_given_up",
] as const;

export type AuditEventName = (typeof AUDIT_EVENTS)[number];
export type AuditCaller = "parent" | "child" | "system";

/** 呼び出し側が渡せるフィールド。型は緩め（unknown）にして、値の検証は audit() が行う。 */
export type AuditFields = {
  userId?: number | string;
  taskId?: string;
  caller?: AuditCaller;
  /** 固定のコード（自由な文は不可） */
  reason?: string;
  /** 任意。DO の alarm の中では取れない */
  requestId?: string;
  /** ホスト名だけ。URL のパス・クエリ・userinfo は出さない */
  host?: string;
  /** 種別の固定コード（credential の start / refresh / final、配送の answer / steer など） */
  kind?: string;
};

/** 出力される 1 件。キーの順序は固定。 */
export type AuditRecord = {
  audit: true;
  event: AuditEventName;
  ts: number;
} & AuditFields;

const CODE_RE = /^[a-z0-9_]{1,64}$/;
const KIND_RE = /^[a-z0-9_]{1,32}$/;
const TASK_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const REQUEST_ID_RE = /^[A-Za-z0-9._-]{1,64}$/;
const DIGITS_RE = /^\d{1,20}$/;
const CALLERS: ReadonlySet<unknown> = new Set(["parent", "child", "system"]);
const EVENT_SET: ReadonlySet<string> = new Set(AUDIT_EVENTS);

/** host の最大長。ラベルにデータを載せる持ち出し（DNS 経由）の帯域を絞るため、実在のホスト名より短く切る。 */
export const MAX_HOST_LENGTH = 100;
const HOST_ALLOWED_RE = /^[a-z0-9._-]+$/;
/** トークンの接頭辞（GitHub の ghs_ / ghp_ / gho_ / ghu_ / ghr_、fine-grained PAT、OpenAI 形式など） */
const TOKEN_PREFIX_RE = /^(gh[a-z]_|github_pat_|sk-|xox[a-z]-|eyj)/i;
/** 長いラベルは、データを載せている可能性があるのでマスクする */
const LONG_LABEL = 32;
const MASK = "masked";

function safeCode(v: unknown, re: RegExp): string | undefined {
  return typeof v === "string" && re.test(v) ? v : undefined;
}

function safeUserId(v: unknown): number | string | undefined {
  if (typeof v === "number") return Number.isSafeInteger(v) && v >= 0 ? v : undefined;
  return typeof v === "string" && DIGITS_RE.test(v) ? v : undefined;
}

/** requestId は、トークン形式（接頭辞）や長い値を出さない。 */
function safeRequestId(v: unknown): string | undefined {
  const s = safeCode(v, REQUEST_ID_RE);
  return s !== undefined && !TOKEN_PREFIX_RE.test(s) ? s : undefined;
}

function maskLabel(label: string): string {
  return TOKEN_PREFIX_RE.test(label) || label.length >= LONG_LABEL ? MASK : label;
}

/** host: ホスト名の形だけを通す。パス・クエリ・userinfo・ポート・スキームを含む値は出さない。 */
function safeHost(v: unknown): string | undefined {
  if (typeof v !== "string") return undefined;
  const lower = v.toLowerCase();
  if (lower === "" || !HOST_ALLOWED_RE.test(lower)) return undefined;
  const masked = lower.split(".").map(maskLabel).join(".");
  return masked.slice(0, MAX_HOST_LENGTH);
}

/**
 * 監査イベントを組み立てる（純粋関数）。未知のイベント名は null。
 * フィールドは許可したものだけ、形の合う値だけを、固定の順序で入れる。
 */
export function buildAudit(
  event: string,
  fields: Record<string, unknown>,
  now: number,
): AuditRecord | null {
  if (!EVENT_SET.has(event)) return null;
  const record: Record<string, unknown> = {
    audit: true,
    event,
    ts: Number.isFinite(now) ? Math.trunc(now) : 0,
  };
  const put = (key: string, value: unknown) => {
    if (value !== undefined) record[key] = value;
  };
  put("userId", safeUserId(fields.userId));
  put("taskId", safeCode(fields.taskId, TASK_ID_RE));
  put("caller", CALLERS.has(fields.caller) ? fields.caller : undefined);
  put("reason", safeCode(fields.reason, CODE_RE));
  put("requestId", safeRequestId(fields.requestId));
  put("host", safeHost(fields.host));
  put("kind", safeCode(fields.kind, KIND_RE));
  return record as AuditRecord;
}

export type AuditOptions = {
  /** 時刻（epoch ms）。省略すると Date.now() */
  now?: number;
  /** 出力先。省略すると console.log */
  log?: (line: string) => void;
};

/**
 * 監査イベントを 1 行の JSON で出す。出した内容（テスト用シンクが記録する）を返す。未知のイベント名は何も出さず null。
 * 欠落してはならない事象は、呼び出し側が TaskDO の events にも積む（二重化。phase6.md）。
 */
export function audit(
  event: string,
  fields: Record<string, unknown> | AuditFields,
  opts: AuditOptions = {},
): AuditRecord | null {
  const record = buildAudit(event, fields as Record<string, unknown>, opts.now ?? Date.now());
  if (record === null) return null;
  (opts.log ?? ((line: string) => console.log(line)))(JSON.stringify(record));
  return record;
}
