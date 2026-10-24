import { z } from "zod";
import { VisibleTaskDtoSchema } from "./overview";
import { countSchema, isoTimeSchema, LIMITS } from "./primitives";

/** 「全員 / 自分」の絞り込みの値（overview と同じ） */
const WAITING_SCOPES = ["all", "me"] as const;

/**
 * `GET /dashboard/api/waiting` の応答。日付に関係なく「待っているタスク」だけを返す:
 * (a) 状態が INPUT_REQUIRED（入力待ち）、(b) COMPLETED で PR が open かつ Draft でない（レビュー・マージ待ち）。
 * 新しい順。件数の上限は `LIMITS.waitingTasks`（超えた分は `truncated`）。
 * 閲覧権限の無いタスクは個別の行を作らず、`hidden_count`（件数）だけ（D7）。
 */
export const WaitingDtoSchema = z.strictObject({
  generated_at: isoTimeSchema,
  scope: z.enum(WAITING_SCOPES),
  tasks: z.array(VisibleTaskDtoSchema).max(LIMITS.waitingTasks),
  /** 上限で打ち切ったか（見えるタスクがもっとある） */
  truncated: z.boolean(),
  /** 権限の無い待ちのタスクの件数（個別の情報は無い） */
  hidden_count: countSchema,
});
export type WaitingDto = z.infer<typeof WaitingDtoSchema>;
