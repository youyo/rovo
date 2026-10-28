import { z } from "zod";
import { isoTimeSchema, LIMITS } from "./primitives";

/** check の名前の上限（外部が書ける非信頼データ） */
export const CHECK_NAME_MAX = 200;
/** 1 回の応答に入れる check の最大数（check run 100 件 + commit status 100 件） */
export const CHECKS_MAX = 200;

export const CHECKS_STATES = ["none", "passing", "failing", "pending", "unreadable"] as const;
export const CHECK_KINDS = ["check_run", "status"] as const;
export const CHECK_STATUSES = ["queued", "in_progress", "completed"] as const;

/**
 * check の GitHub へのリンク。check run の details_url / html_url と commit status の target_url は外部が任意に書ける
 * ので、`https://github.com/` で始まるもの（空白・制御文字・バックスラッシュなし）だけを通す。それ以外は gateway が null にする。
 */
export const checkUrlSchema = z
  .string()
  .max(LIMITS.url)
  .regex(/^https:\/\/github\.com\/[^\s\\\p{Cc}]*$/u);

export const CheckDtoSchema = z.strictObject({
  /** 外部が書ける非信頼テキスト。画面はテキストとしてだけ描く */
  name: z.string().min(1).max(CHECK_NAME_MAX),
  kind: z.enum(CHECK_KINDS),
  /** commit status の pending は "in_progress"、success / failure / error は "completed" */
  status: z.enum(CHECK_STATUSES),
  /** check run の conclusion / commit status の state（success・failure・error など）。実行中は null */
  conclusion: z.string().max(40).nullable(),
  started_at: isoTimeSchema.nullable(),
  completed_at: isoTimeSchema.nullable(),
  url: checkUrlSchema.nullable(),
});
export type CheckDto = z.infer<typeof CheckDtoSchema>;

/**
 * `GET /dashboard/api/tasks/:id/checks` の応答。タスクの PR の**今の head**に付いた check run と commit status。
 * - none: PR が無い（head_sha は null）か、PR に check がまだ無い
 * - passing / failing / pending: 集約（success・skipped・neutral は成功。failure が 1 つでもあれば failing）
 * - unreadable: 権限（GitHub App の Checks / Commit statuses の read）・時間切れ・GitHub の障害で読めない（checks は空）
 * - partial: check run か commit status の片方だけ読めた（読めた分だけ返す）
 * - truncated: 上限（check run 100 件 + commit status 100 件）を超えて、一部しか返していない
 */
export const ChecksDtoSchema = z.strictObject({
  head_sha: z
    .string()
    .regex(/^[0-9a-f]{40}$/)
    .nullable(),
  state: z.enum(CHECKS_STATES),
  checks: z.array(CheckDtoSchema).max(CHECKS_MAX),
  truncated: z.boolean(),
  partial: z.boolean(),
});
export type ChecksDto = z.infer<typeof ChecksDtoSchema>;
