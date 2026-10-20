import { z } from "zod";

export const DEFAULT_WAIT_SECONDS = 30;
export const MAX_WAIT_SECONDS = 60;
export const MAX_EVENTS_PER_WAIT = 100;
export const MAX_CONCURRENT_WAITERS = 16;
export const WAIT_RETRY_AFTER_SECONDS = 5;

const IDEMPOTENCY_KEY_RE = /^[A-Za-z0-9_-]{1,128}$/;

export function isValidIdempotencyKey(value: unknown): value is string {
  return typeof value === "string" && IDEMPOTENCY_KEY_RE.test(value);
}

export type Parsed<T> = { ok: true; value: T } | { ok: false };

const CURSOR_RE = /^[0-9]+$/;

/** cursor は 10進の非負整数（安全整数の範囲）。省略は 0（先頭から）。 */
export function parseCursor(raw: string | undefined): Parsed<number> {
  if (raw === undefined) return { ok: true, value: 0 };
  if (typeof raw !== "string" || !CURSOR_RE.test(raw)) return { ok: false };
  const n = Number(raw);
  if (!Number.isSafeInteger(n)) return { ok: false };
  return { ok: true, value: n };
}

/** timeout_seconds は 0 以上の整数。省略は既定値、上限はクランプする。 */
export function parseTimeoutSeconds(raw: number | undefined): Parsed<number> {
  if (raw === undefined) return { ok: true, value: DEFAULT_WAIT_SECONDS };
  if (typeof raw !== "number" || !Number.isInteger(raw) || raw < 0) return { ok: false };
  return { ok: true, value: Math.min(raw, MAX_WAIT_SECONDS) };
}

// 行サイズ（DO の SQLite は 1 行 2MB まで）を超えないための上限。仕様に数値の指定は無い。
const MAX_TITLE = 200;
const MAX_MODEL_LENGTH = 100;
const MAX_INSTRUCTIONS = 100_000;
const MAX_LIST_ITEMS = 50;
const MAX_LIST_ITEM_LENGTH = 2_000;

const stringList = z.array(z.string().min(1).max(MAX_LIST_ITEM_LENGTH)).max(MAX_LIST_ITEMS);

// 検証コマンドの上限。AgentDO が Sandbox で実行するので、件数・長さ・時間を抑える（bash ツールの上限 30 分に合わせる）。
export const MAX_VERIFICATION_COMMANDS = 10;
const MAX_ARGV_ITEMS = 64;
const MAX_ARGV_ITEM_LENGTH = 1_000;
const MAX_CWD_LENGTH = 500;
export const MAX_VERIFICATION_TIMEOUT_SECONDS = 1_800;

/** リポジトリのルートからの相対パス。絶対パス・.. ・NUL・空要素を許さない。 */
function isSafeRelativePath(p: string): boolean {
  if (p.includes("\0") || p.startsWith("/")) return false;
  return p.split("/").every((seg) => seg !== ".." && seg !== "");
}

export const verificationCommandSchema = z
  .object({
    argv: z.array(z.string().min(1).max(MAX_ARGV_ITEM_LENGTH)).min(1).max(MAX_ARGV_ITEMS),
    cwd: z
      .string()
      .min(1)
      .max(MAX_CWD_LENGTH)
      .refine(isSafeRelativePath, "リポジトリのルートからの相対パス")
      .optional(),
    timeout_seconds: z.number().int().min(1).max(MAX_VERIFICATION_TIMEOUT_SECONDS).optional(),
  })
  .strict();

export type VerificationCommandInput = z.infer<typeof verificationCommandSchema>;

/**
 * PR のマージの方針（D9）。human_review は人のレビューを待つ（task_pr_merge を使えない）、
 * agent_merge は呼び出し元の AI がレビューしてマージまでできる。強制は利用者の GitHub のブランチ保護に任せる。
 */
export const MERGE_POLICIES = ["human_review", "agent_merge"] as const;
export type MergePolicy = (typeof MERGE_POLICIES)[number];
export const DEFAULT_MERGE_POLICY: MergePolicy = "human_review";

/** task_start の入力（design.md 4.3）。idempotency_key は含めない。 */
export const taskInputSchema = z.object({
  // GitHub の上限: owner は 39 文字、リポジトリ名は 100 文字
  repository: z.string().regex(/^[A-Za-z0-9_.-]{1,39}\/[A-Za-z0-9_.-]{1,100}$/, "owner/name 形式"),
  base_ref: z.string().min(1).max(255),
  // 短縮形は準備の段階（GitHub の commit 取得）で使えず FAILED になるので、入力の段階で 40 桁だけに絞る
  base_sha: z
    .string()
    .regex(
      /^[0-9a-fA-F]{40}$/,
      "base_sha must be a full 40-digit commit SHA (hex); abbreviated SHAs are not supported",
    ),
  title: z.string().min(1).max(MAX_TITLE),
  instructions: z.string().min(1).max(MAX_INSTRUCTIONS),
  acceptance_criteria: stringList.default([]),
  constraints: stringList.default([]),
  verification_commands: z
    .array(verificationCommandSchema)
    .max(MAX_VERIFICATION_COMMANDS)
    .default([]),
  merge_policy: z.enum(MERGE_POLICIES).default(DEFAULT_MERGE_POLICY),
  /** 子のモデル（D10）。省略は env の AGENT_MODEL。env の AGENT_MODELS の中だけ（照合は service と TaskDO が env で行う） */
  model: z.string().min(1).max(MAX_MODEL_LENGTH).optional(),
});

/** 入力全体（JSON）の上限。項目ごとの上限だけでは合計が大きくなりうるため。 */
export const MAX_INPUT_BYTES = 256 * 1024;

export function exceedsInputLimit(input: unknown): boolean {
  return new TextEncoder().encode(JSON.stringify(input)).length > MAX_INPUT_BYTES;
}

export type TaskInput = z.infer<typeof taskInputSchema>;

/**
 * 入力の fingerprint（SHA-256, hex）。
 * 項目を固定順の配列にして JSON 化するので、プロパティ順や連結の曖昧さに影響されない。
 * 正規化: repository と base_sha は小文字化（GitHub 上は大文字小文字を区別しない）。
 * 配列の省略は空配列として扱う。base_ref などは区別するのでそのまま。
 * verification_commands は argv / cwd / timeout_seconds を順序込みで含める（検証の入力が違えば別のタスク）。
 * merge_policy は既定（human_review）なら含めない（保存済みの値と一致させる）。agent_merge のときだけ v3 として足す。
 * model は未指定なら含めない（従来の v1 / v2 / v3 のまま）。指定があれば v4 として merge_policy と一緒に末尾へ足す。
 */
export async function computeFingerprint(input: TaskInput): Promise<string> {
  const fields: unknown[] = [
    input.repository.toLowerCase(),
    input.base_ref,
    input.base_sha.toLowerCase(),
    input.title,
    input.instructions,
    input.acceptance_criteria ?? [],
    input.constraints ?? [],
  ];
  // 検証コマンドが無ければ v1 のまま（Phase 1 で保存済みの値と一致させる）。あれば v2 として末尾に足す。
  const commands = (input.verification_commands ?? []).map((c) => [
    c.argv,
    c.cwd ?? null,
    c.timeout_seconds ?? null,
  ]);
  const canonical = JSON.stringify(
    input.model !== undefined
      ? ["v4", ...fields, commands, input.merge_policy, input.model]
      : input.merge_policy === "agent_merge"
        ? ["v3", ...fields, commands, input.merge_policy]
        : commands.length === 0
          ? ["v1", ...fields]
          : ["v2", ...fields, commands],
  );
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonical));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** task_answer の answer / task_steer の message の長さの上限（文字数）。 */
export const MAX_ANSWER_LENGTH = 20_000;
export const MAX_STEER_LENGTH = 20_000;
const MAX_ID_LENGTH = 128;

/** task_answer の入力。回答は認証された親からの指示なので内容は縛らず、長さだけ制限する。 */
export const answerInputSchema = z.object({
  task_id: z.string(),
  question_id: z.string().min(1).max(MAX_ID_LENGTH),
  answer: z.string().min(1).max(MAX_ANSWER_LENGTH),
});

export type AnswerInput = z.infer<typeof answerInputSchema>;

/** task_steer の入力。idempotency_key があれば steer_id をそこから導く。 */
export const steerInputSchema = z.object({
  task_id: z.string(),
  message: z.string().min(1).max(MAX_STEER_LENGTH),
  idempotency_key: z
    .string()
    .regex(/^[A-Za-z0-9_-]{1,128}$/, "idempotency_key must match [A-Za-z0-9_-]{1,128}")
    .optional(),
});

export type SteerInput = z.infer<typeof steerInputSchema>;

/** task_pr_ready の入力。リポジトリと PR 番号は受け取らない（TaskDO の記録から取る）。余計な項目は捨てる。 */
export const prReadyInputSchema = z.object({ task_id: z.string() });

export const MERGE_METHODS = ["squash", "merge", "rebase"] as const;
export type MergeMethod = (typeof MERGE_METHODS)[number];

/** task_pr_merge の入力。sha も受け取らない（検証済みの head を TaskDO の記録から取る）。 */
export const prMergeInputSchema = z.object({
  task_id: z.string(),
  merge_method: z.enum(MERGE_METHODS).default("squash"),
  delete_branch: z.boolean().default(false),
});

/** consult の入力の上限。行サイズではなく、予約額（CONSULT_BUDGET_USD）に収まる大きさの目安。厳密な判定は AgentDO が行う。 */
export const MAX_CONSULT_SYSTEM = 100_000;
export const MAX_CONSULT_CONTENT = 100_000;
export const MAX_CONSULT_MESSAGES = 100;
export const MAX_CONSULT_OUTPUT_TOKENS = 64_000;
export const MAX_CONSULT_INPUT_BYTES = 256 * 1024;

/** consult の入力。messages は最初と最後が user（Anthropic の API の制約と、「最後の user の質問に答える」意味に合わせる）。 */
export const consultInputSchema = z
  .object({
    model: z.string().min(1).max(MAX_MODEL_LENGTH).optional(),
    system: z.string().max(MAX_CONSULT_SYSTEM).optional(),
    messages: z
      .array(
        z.object({
          role: z.enum(["user", "assistant"]),
          content: z.string().min(1).max(MAX_CONSULT_CONTENT),
        }),
      )
      .min(1)
      .max(MAX_CONSULT_MESSAGES),
    max_output_tokens: z.number().int().min(1).max(MAX_CONSULT_OUTPUT_TOKENS).optional(),
  })
  .superRefine((v, ctx) => {
    if (v.messages[0]?.role !== "user") {
      ctx.addIssue({ code: "custom", path: ["messages", 0], message: "最初のメッセージは user" });
    }
    if (v.messages[v.messages.length - 1]?.role !== "user") {
      ctx.addIssue({
        code: "custom",
        path: ["messages", v.messages.length - 1],
        message: "最後のメッセージは user",
      });
    }
    if (new TextEncoder().encode(JSON.stringify(v)).length > MAX_CONSULT_INPUT_BYTES) {
      ctx.addIssue({ code: "custom", path: [], message: "input is too large" });
    }
  });

export type ConsultInput = z.infer<typeof consultInputSchema>;
