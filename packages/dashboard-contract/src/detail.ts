import { z } from "zod";
import { VisibleTaskDtoSchema } from "./overview";
import { countSchema, isoTimeSchema, LIMITS, singleLineText, untrustedText } from "./primitives";

/** 準備 → 実行 → 検証 → 完了の帯 */
export const PHASES = ["prepare", "run", "verify", "done"] as const;

/** 止まった段階（done は止まっていないので含めない） */
export const STOPPED_PHASES = ["prepare", "run", "verify"] as const;

/** 「いまは X を実行中」の X の種類 */
export const NOW_KINDS = ["command", "edit", "commit", "web", "tool", "waiting"] as const;

/**
 * モデルの選び方（task_start の model を指定したか、省略して rovo が選んだか）。確率・時間・選んだモデルは持たない（モデルは task.model にある）。
 * `reason` は固定のコード（clef_flash など。画面が日本語にする。知らないコードはそのまま出す）で、自由文は受け付けない。追加のみの項目。
 */
export const ModelSelectionDtoSchema = z.strictObject({
  mode: z.enum(["auto", "explicit"]),
  reason: z.string().regex(/^[a-z][a-z0-9_]{0,39}$/),
});
export type ModelSelectionDto = z.infer<typeof ModelSelectionDtoSchema>;

/** 設定の欄。`sandbox_instance` は表にある名前だけ（standard-2 など） */
export const SettingsDtoSchema = z.strictObject({
  merge_policy: z.enum(["human_review", "agent_merge"]),
  deps_cache: z.enum(["hit", "miss", "built", "disabled"]).optional(),
  cache_build_ms: countSchema.optional(),
  sandbox_runtime_ms: countSchema.optional(),
  sandbox_instance: z
    .string()
    .regex(/^[a-z0-9][a-z0-9-]{0,31}$/)
    .optional(),
  /** 無いのは旧い gateway・記録の無い古いタスク（画面は行を出さない） */
  model_selection: ModelSelectionDtoSchema.optional(),
});
export type SettingsDto = z.infer<typeof SettingsDtoSchema>;

/**
 * `GET /dashboard/api/tasks/:id`。閲覧権限があるタスクだけで、権限が無いときは `ErrorDto`（404）。
 * `instructions` の全文・トークン・暗号文は持たない。
 */
export const TaskDetailDtoSchema = z.strictObject({
  generated_at: isoTimeSchema,
  task: VisibleTaskDtoSchema,
  phase: z.enum(PHASES),
  /**
   * 終端（失敗・予算超過・キャンセル）で、どの段階で止まったか。完了・非終端は null。省略は旧い gateway（画面は状態から推定する）。
   * 追加のみの項目。
   */
  stopped_phase: z.enum(STOPPED_PHASES).nullable().optional(),
  /** 最新の command / edit などから作る一言。無ければ null（画面は「待機中」等） */
  now: z
    .strictObject({
      kind: z.enum(NOW_KINDS),
      text: singleLineText(LIMITS.nowText),
      /** その手順の記録時刻（command / edit / commit / web は完了時刻、tool は開始時刻）。無ければ省く */
      at: isoTimeSchema.optional(),
    })
    .nullable(),
  settings: SettingsDtoSchema,
  /** 出力の末尾。`redacted` は常に true（秘密を常に伏せている旨を表示する） */
  output: z.strictObject({
    tail: untrustedText(LIMITS.outputTail).nullable(),
    /** 末尾の出力を出した command（1 行に整形・300 字まで）と、その記録時刻。tail が null のときは省く */
    command: singleLineText(LIMITS.nowText).optional(),
    at: isoTimeSchema.optional(),
    /**
     * いま実行中のコマンドの途中の出力か（追加のみ・任意。無ければ終わったコマンドの出力）。true のとき、tail は実行中の出力の末尾
     * （未完の行は含まない）で、command はそのコマンド、at は最後に更新した時刻。false は表さない（印を付けないことで表す）。
     */
    running: z.literal(true).optional(),
    /** 実行中のコマンドの開始時刻（running のときだけ。経過時間の表示用） */
    started_at: isoTimeSchema.optional(),
    redacted: z.literal(true),
  }),
});
export type TaskDetailDto = z.infer<typeof TaskDetailDtoSchema>;
