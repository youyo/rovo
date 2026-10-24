import { z } from "zod";

/**
 * 長さの上限（UTF-16 のコード単位）。子エージェント由来の文字列は非信頼データなので、必ず上限を持たせる。
 * D14 の値（command 1,000 / output_tail 2,000 / path 300 / commit 200）に合わせる。
 */
export const LIMITS = {
  title: 300,
  repository: 140,
  login: 39,
  model: 100,
  reason: 100,
  callId: 100,
  toolName: 100,
  summary: 500,
  command: 1_000,
  outputTail: 2_000,
  path: 300,
  commitMessage: 200,
  host: 253,
  agentType: 64,
  nowText: 300,
  url: 300,
  overviewTasks: 1_000,
  overviewConsults: 2_000,
  models: 50,
  eventsPerPage: 200,
} as const;

/** タスク ID（ULID。Crockford base32 の大文字 26 桁）。 */
export const ULID_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/;
export const ulidSchema = z.string().regex(ULID_RE);

/** consult の ID（`consult-<ULID>`）。 */
export const consultIdSchema = z.string().regex(/^consult-[0-9A-HJKMNP-TV-Z]{26}$/);

/** 時刻は UTC の ISO 8601（末尾 Z）だけ。オフセット付き・日付だけ・数値は受けない。 */
export const isoTimeSchema = z.iso.datetime().max(40);

/** 金額（USD）。負・NaN・Infinity は不可。 */
export const usdSchema = z.number().min(0).max(1_000_000_000);

/** 件数・トークン数・ミリ秒など（0 以上の整数）。 */
export const countSchema = z.int().min(0).max(Number.MAX_SAFE_INTEGER);

/** GitHub のログイン名（英数字とハイフン。39 桁まで）。 */
export const loginSchema = z.string().regex(/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/);

/** `owner/repo`。 */
export const repositorySchema = z
  .string()
  .max(LIMITS.repository)
  .regex(/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9._-]{1,100}$/);

/**
 * モデル ID（任意の文字列を通さない。英数字で始まり、`._:/@-` を許す）。
 * `@` は Workers AI のカタログのキー（`workers-ai/@cf/openai/gpt-oss-120b`）に要る。
 */
export const modelIdSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,99}$/);

export const EFFORTS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export const effortSchema = z.enum(EFFORTS);

export const REVIEW_POLICIES = ["client_review", "worker_review"] as const;

/**
 * タスクの状態。gateway の TASK_STATUSES（apps/gateway/src/tasks/state.ts）と同じ 9 つ。
 * 契約のパッケージは gateway に依存しないので写している。
 */
export const TASK_STATUSES = [
  "CREATING",
  "RUNNING",
  "INPUT_REQUIRED",
  "VERIFYING",
  "RECOVERING",
  "COMPLETED",
  "FAILED",
  "BUDGET_EXCEEDED",
  "CANCELLED",
] as const;
export const taskStatusSchema = z.enum(TASK_STATUSES);
export type TaskStatusDto = z.infer<typeof taskStatusSchema>;

/**
 * Draft PR の URL。`https://github.com/<owner>/<repo>/pull/<n>` に厳密に一致するものだけ。
 * query・fragment・userinfo・他のホスト・他の scheme を通さない（画面ではこの形だけをリンクにする）。
 */
export const prUrlSchema = z
  .string()
  .max(LIMITS.url)
  .regex(
    /^https:\/\/github\.com\/[A-Za-z0-9-]{1,39}\/[A-Za-z0-9._-]{1,100}\/pull\/[1-9][0-9]{0,9}$/,
  );

/** 失敗の理由コード（`base_sha_not_found` など。自由文は通さない）。 */
export const reasonCodeSchema = z
  .string()
  .max(LIMITS.reason)
  .regex(/^[a-z0-9][a-z0-9_.:-]*$/);

/** Git の SHA-1（40 桁の小文字 16 進）。 */
export const shaSchema = z.string().regex(/^[0-9a-f]{40}$/);

/** 制御文字（C0 のうち改行・タブ以外、DEL、C1）を含まない文字列。 */
// biome-ignore lint/suspicious/noControlCharactersInRegex: 制御文字の検出が目的
const CONTROL_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/;
/** 子エージェント由来の非信頼テキスト。長さの上限を必ず付ける（表示前の整形は画面側の責務）。 */
export const untrustedText = (max: number) => z.string().max(max);
/** 1 行だけのテキスト（改行・制御文字なし）。 */
export const singleLineText = (max: number) =>
  z
    .string()
    .max(max)
    .refine((s) => !CONTROL_CHARS.test(s) && !/[\r\n]/.test(s), "改行・制御文字は不可");

/** ワークスペースからの相対パス（絶対パス・`..`・制御文字・バックスラッシュを拒否）。 */
export const relativePathSchema = singleLineText(LIMITS.path)
  .refine((p) => p.length > 0, "空は不可")
  .refine((p) => !p.startsWith("/") && !/^[A-Za-z]:/.test(p) && !p.includes("\\"), "相対パスのみ")
  .refine((p) => !p.split("/").includes(".."), ".. は不可");

/** ホスト名だけ（scheme・パス・クエリ・userinfo・ポート・空白を持てない）。 */
export const hostSchema = z
  .string()
  .max(LIMITS.host)
  .regex(/^(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,62})\.)*[A-Za-z0-9](?:[A-Za-z0-9-]{0,62})$/);

/** 期間（半開区間）。 */
export const periodSchema = z.strictObject({ start: isoTimeSchema, end: isoTimeSchema });
