/**
 * 監査ログ（design 11.2 / phase6.md「監査ログ」）。gateway・agent・web が共有する純粋関数。
 *
 * 出力は 1 か所の関数 audit(event, fields) にまとめ、許可したフィールドと許可した形の値だけを通す（allowlist）。
 * 未知のフィールドと、形の合わない値は黙って落とす（変換して通さない）。トークン・本文・URL のパス・タスクの入力は
 * 出ない。reason など文字列は「固定のコード」の形（英小文字・数字・_）だけを許す。
 *
 * allowlist はこのパッケージが持ち、呼び出し側は変えられない（引数に allowlist を取らない）。
 * レコードの枠（audit / event / ts）は固定で、fields で上書きできない。
 * Worker 生成の Env 型にも Cloudflare 専用の型にも Node 専用の API にも依存しない。
 * console 出力の先（既定は console.log）以外の副作用は持たない。test 用のシンクなどは各 app の adapter が持つ。
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
  // agent（M2）
  "sandbox_privileged_op",
  "outbound_denied",
  "agent_cancelled",
  "boot_superseded",
  "start_cancelled_by_tombstone",
  "start_conflict",
  // gateway（M3）: タスクの要約（数値と固定コードだけ）
  "task_summary",
  // gateway（M4）: R2 アーカイブ（本文は出さない。キーの接頭辞とサイズだけ）
  "archive_skipped",
  "archive_failed",
  "archive_completed",
  // web（M5）
  "web_blocked",
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
  /** sandbox_privileged_op だけ: 特権操作の種類（SANDBOX_OPS のどれか） */
  op?: string;
  /** outbound_denied だけ: 宛先の分類（OUTBOUND_DESTS のどれか。ホスト名そのものではない） */
  dest?: string;
  /** task_summary だけ: 数値の項目（キーは TASK_SUMMARY_METRICS のどれか。値は非負の有限数） */
  metrics?: Record<string, number>;
  /** archive_completed だけ: R2 のキーの接頭辞（`tasks/<yyyy>/<mm>/<task_id>/`。キーの全体ではない） */
  prefix?: string;
  /** archive_completed だけ: 書き込んだ 3 オブジェクトの合計サイズ（バイト） */
  bytes?: number;
};

/** 出力される 1 件。キーの順序は固定。 */
export type AuditRecord = {
  audit: true;
  event: AuditEventName;
  ts: number;
} & AuditFields;

/** Sandbox の特権操作の種類（固定）。 */
export const SANDBOX_OPS = ["terminate", "destroy", "set_deadline", "extend_deadline"] as const;
/** task_summary の metrics に載せられるキー（固定。title や自由な文のキーは無い）。 */
export const TASK_SUMMARY_METRICS = [
  "duration_ms",
  "transitions",
  "claude_usd",
  "input_tokens",
  "output_tokens",
  "cache_read_tokens",
  "cache_write_tokens",
  "sandbox_runtime_ms",
  "sandbox_restarts",
  "sandbox_boot_retries",
  "sandbox_usd_estimate",
  "web_search",
  "web_fetch",
  "web_browse",
  "web_usd_estimate",
  "questions",
  "verification_attempts",
  "verification_passed",
  "agent_errors",
] as const;
/** 外向き通信の宛先の分類（固定）。 */
export const OUTBOUND_DESTS = ["github", "registry", "other"] as const;

const CODE_RE = /^[a-z0-9_]{1,64}$/;
const KIND_RE = /^[a-z0-9_]{1,32}$/;
const TASK_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const REQUEST_ID_RE = /^[A-Za-z0-9._-]{1,64}$/;
const DIGITS_RE = /^\d{1,20}$/;
const CALLERS: ReadonlySet<unknown> = new Set(["parent", "child", "system"]);
const EVENT_SET: ReadonlySet<string> = new Set(AUDIT_EVENTS);
const SANDBOX_OP_SET: ReadonlySet<unknown> = new Set(SANDBOX_OPS);
const OUTBOUND_DEST_SET: ReadonlySet<unknown> = new Set(OUTBOUND_DESTS);

/** イベント固有のフィールド。ここに無いイベントは共通のものだけ通す。 */
const EVENT_FIELDS: Readonly<
  Partial<Record<AuditEventName, readonly ("op" | "dest" | "metrics" | "prefix" | "bytes")[]>>
> = {
  sandbox_privileged_op: ["op"],
  outbound_denied: ["dest"],
  task_summary: ["metrics"],
  archive_completed: ["prefix", "bytes"],
};

/** R2 のキーの接頭辞。キーの全体や任意の文字列は通さない。 */
const ARCHIVE_PREFIX_RE = /^tasks\/\d{4}\/\d{2}\/[A-Za-z0-9_-]{1,64}\/$/;

/** metrics: 固定のキーの、非負の有限数だけを通す（自分のプロパティだけ読む）。1 つも無ければ出さない。 */
function safeMetrics(v: unknown): Record<string, number> | undefined {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return undefined;
  const out: Record<string, number> = {};
  for (const key of TASK_SUMMARY_METRICS) {
    if (!Object.hasOwn(v, key)) continue;
    const n = (v as Record<string, unknown>)[key];
    if (typeof n === "number" && Number.isFinite(n) && n >= 0) out[key] = n;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/** host の最大長。ラベルにデータを載せる持ち出し（DNS 経由）の帯域を絞るため、実在のホスト名より短く切る。 */
export const MAX_HOST_LENGTH = 100;
const HOST_ALLOWED_RE = /^[a-z0-9._-]+$/;
/**
 * トークンの形式（GitHub の ghs_ / ghp_ / gho_ / ghu_ / ghr_、fine-grained PAT、OpenAI 形式、Slack、JWT など）。
 * 接頭辞が先頭でない値（`xghs_...`）も拾うため、位置は問わない。ラベル / 値のどこに出てもマスクする。
 * 代償として `desk-1` のような普通の名前にも当たる（sk-）。監査ログでは取りこぼしより過検出を選ぶ。
 */
const TOKEN_RE = /gh[a-z]_|github_pat_|sk-|xox[a-z]-|eyj/i;
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

/** requestId は、トークン形式（位置は問わない）や長い値を出さない。 */
function safeRequestId(v: unknown): string | undefined {
  const s = safeCode(v, REQUEST_ID_RE);
  return s !== undefined && !TOKEN_RE.test(s) ? s : undefined;
}

function maskLabel(label: string): string {
  return TOKEN_RE.test(label) || label.length >= LONG_LABEL ? MASK : label;
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
  // 自分のプロパティだけ読む（プロトタイプ経由の値や __proto__ を拾わない）。許可していないキーは見ない
  const own = (key: string): unknown => (Object.hasOwn(fields, key) ? fields[key] : undefined);
  const put = (key: string, value: unknown) => {
    if (value !== undefined) record[key] = value;
  };
  put("userId", safeUserId(own("userId")));
  put("taskId", safeCode(own("taskId"), TASK_ID_RE));
  const caller = own("caller");
  put("caller", CALLERS.has(caller) ? caller : undefined);
  put("reason", safeCode(own("reason"), CODE_RE));
  put("requestId", safeRequestId(own("requestId")));
  put("host", safeHost(own("host")));
  put("kind", safeCode(own("kind"), KIND_RE));
  const extra = EVENT_FIELDS[event as AuditEventName] ?? [];
  if (extra.includes("op")) {
    const op = own("op");
    put("op", SANDBOX_OP_SET.has(op) ? op : undefined);
  }
  if (extra.includes("dest")) {
    const dest = own("dest");
    put("dest", OUTBOUND_DEST_SET.has(dest) ? dest : undefined);
  }
  if (extra.includes("prefix")) put("prefix", safeCode(own("prefix"), ARCHIVE_PREFIX_RE));
  if (extra.includes("bytes")) {
    const bytes = own("bytes");
    put(
      "bytes",
      typeof bytes === "number" && Number.isSafeInteger(bytes) && bytes >= 0 ? bytes : undefined,
    );
  }
  if (extra.includes("metrics")) put("metrics", safeMetrics(own("metrics")));
  return record as AuditRecord;
}

/** 既定の出力先。console の型（DOM / Node / Workers のどれ）に依存しないよう globalThis から引く。 */
function defaultLog(line: string): void {
  (globalThis as { console?: { log(line: string): void } }).console?.log(line);
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
  (opts.log ?? defaultLog)(JSON.stringify(record));
  return record;
}
