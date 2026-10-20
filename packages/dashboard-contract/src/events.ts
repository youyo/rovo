import { z } from "zod";
import {
  countSchema,
  hostSchema,
  isoTimeSchema,
  LIMITS,
  prUrlSchema,
  reasonCodeSchema,
  relativePathSchema,
  shaSchema,
  singleLineText,
  taskStatusSchema,
  ulidSchema,
  untrustedText,
  usdSchema,
} from "./primitives";

/**
 * 進み具合のイベント（`GET /dashboard/api/tasks/:id/events`）。`type` で判別する。
 * 子エージェント由来の文字列（command・パス・commit のメッセージなど）はマスク済みでも非信頼データとして扱い、
 * 型ごとに長さの上限と形式を持つ。差分の本文・URL のパスやクエリは持てない（D14）。
 */
const base = { seq: z.int().min(1), at: isoTimeSchema };

/** 状態の変化（`status_changed`） */
const StatusChangedEvent = z.strictObject({
  ...base,
  type: z.literal("status_changed"),
  from: taskStatusSchema.optional(),
  to: taskStatusSchema,
  reason: reasonCodeSchema.optional(),
});

const DraftPrCreatedEvent = z.strictObject({
  ...base,
  type: z.literal("draft_pr_created"),
  pr_number: z.int().min(1),
  pr_url: prUrlSchema,
});

/** 既存のイベント（後方互換。古い agent の履歴はこの 2 つの要約だけで縮退して表示する） */
const ToolStartEvent = z.strictObject({
  ...base,
  type: z.literal("tool_start"),
  call_id: singleLineText(LIMITS.callId),
  name: singleLineText(LIMITS.toolName),
  summary: untrustedText(LIMITS.summary),
});

const ToolEndEvent = z.strictObject({
  ...base,
  type: z.literal("tool_end"),
  call_id: singleLineText(LIMITS.callId),
  is_error: z.boolean(),
  summary: untrustedText(LIMITS.summary),
});

/** 子エージェントの累計の使用量 */
const UsageEvent = z.strictObject({
  ...base,
  type: z.literal("usage"),
  cost_usd: usdSchema,
  input_tokens: countSchema,
  output_tokens: countSchema,
  cache_read_tokens: countSchema,
  cache_write_tokens: countSchema,
});

/** 構造化イベント（D14）: 実行したコマンド */
const CommandEvent = z.strictObject({
  ...base,
  type: z.literal("command"),
  /** argv を人が読める 1 つの文字列にしたもの（先頭と末尾を残して 1,000 字まで） */
  command: untrustedText(LIMITS.command),
  /** ワークスペースからの相対パス */
  cwd: relativePathSchema.optional(),
  exit_code: z.int().nullable(),
  duration_ms: countSchema.optional(),
  output_tail: untrustedText(LIMITS.outputTail).optional(),
});

/** 構造化イベント（D14）: ファイルの編集。差分の本文は持たない */
const EditEvent = z.strictObject({
  ...base,
  type: z.literal("edit"),
  path: relativePathSchema,
  op: z.enum(["create", "modify", "delete"]),
  added: countSchema,
  removed: countSchema,
});

/** 構造化イベント（D14）: commit。メッセージは 1 行目だけ */
const CommitEvent = z.strictObject({
  ...base,
  type: z.literal("commit"),
  message: singleLineText(LIMITS.commitMessage),
  sha: shaSchema,
  files: countSchema,
});

/** 構造化イベント（D14）: Web の利用。ホストだけ（URL のパス・クエリは持たない） */
const WebEvent = z.strictObject({
  ...base,
  type: z.literal("web"),
  kind: z.enum(["search", "fetch", "browse"]),
  host: hostSchema.optional(),
});

/** gateway が知らない型への縮退。型名だけで、中身は持たない */
const AgentEvent = z.strictObject({
  ...base,
  type: z.literal("agent_event"),
  agent_type: singleLineText(LIMITS.agentType),
});

export const TaskEventDtoSchema = z.discriminatedUnion("type", [
  StatusChangedEvent,
  DraftPrCreatedEvent,
  ToolStartEvent,
  ToolEndEvent,
  UsageEvent,
  CommandEvent,
  EditEvent,
  CommitEvent,
  WebEvent,
  AgentEvent,
]);
export type TaskEventDto = z.infer<typeof TaskEventDtoSchema>;

/** 構造化イベントの型（D14）。新しい agent だけが出す */
export const STRUCTURED_EVENT_TYPES = ["command", "edit", "commit", "web"] as const;

/** events の 1 ページ。`seq` の昇順。最初は末尾（新しい側）から取り、古い側は has_older で遡る（D15） */
export const TaskEventsPageDtoSchema = z.strictObject({
  task_id: ulidSchema,
  events: z.array(TaskEventDtoSchema).max(LIMITS.eventsPerPage),
  oldest_seq: z.int().min(1).nullable(),
  newest_seq: z.int().min(1).nullable(),
  has_older: z.boolean(),
});
export type TaskEventsPageDto = z.infer<typeof TaskEventsPageDtoSchema>;
