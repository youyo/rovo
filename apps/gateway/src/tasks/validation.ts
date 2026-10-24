import { EFFORT_LEVELS, SELECTABLE_SANDBOX_INSTANCES } from "@rovo/models";
import { z } from "zod";

export const DEFAULT_WAIT_SECONDS = 30;
export const MAX_WAIT_SECONDS = 50;
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
 * 全体のテストとレビューをどこで行うか（review_policy）。マージはどちらでもクライアントが行う（task_pr_merge か、gh などで直接）。
 * client_review（既定）: ワーカーは関係するテストまでを担当し、完了で rovo が PR を Ready にする。全体のテストとレビューはクライアントが手元で行う。
 * worker_review: ワーカーの検証が通ったあと、完了にする前に、review_commands を流し、review_model が差分を読んで PR に COMMENT のレビューを書く
 * （review_model が必須。review_fix_rounds は 0 だけ。修正の回は未実装）。
 */
export const REVIEW_POLICIES = ["client_review", "worker_review"] as const;
export type ReviewPolicy = (typeof REVIEW_POLICIES)[number];
export const DEFAULT_REVIEW_POLICY: ReviewPolicy = "client_review";
/**
 * worker_review の review_fix_rounds。仕様では 0 か 1 だが、1（ワーカーが修正する回）はまだ実装していない。
 * 省略は 0（コメントだけで Ready）。
 */
const FIX_ROUNDS_NOT_IMPLEMENTED =
  "review_fix_rounds: 1 は指定できません（修正の回は未実装です。0 を指定するか省略してください）";

/**
 * 予算に近づいたときの扱い。ask（既定）は止めずにクライアントへ「あと task_budget_usd 使って続けるか」を聞く（延長は 1 タスク 2 回まで。
 * 月の枠はハードリミットのまま、延長の都度その場で予約する）。stop は今までどおり BUDGET_EXCEEDED で止まる（無人で回す用途）。
 */
export const BUDGET_POLICIES = ["ask", "stop"] as const;
export type BudgetPolicy = (typeof BUDGET_POLICIES)[number];
export const DEFAULT_BUDGET_POLICY: BudgetPolicy = "ask";

/** task_start の入力（design.md 4.3）。idempotency_key は含めない。 */
export const taskInputObject = z.object({
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
  review_policy: z.enum(REVIEW_POLICIES).default(DEFAULT_REVIEW_POLICY),
  /** worker_review のときだけ（必須）。レビューを書くモデル。作業の model とは独立で、黙って流用しない */
  review_model: z.string().min(1).max(MAX_MODEL_LENGTH).optional(),
  /** worker_review のときだけ。全体のテスト（verification_commands と同じ形）。省略・空なら差分と読み取りの道具だけのレビュー */
  review_commands: z.array(verificationCommandSchema).max(MAX_VERIFICATION_COMMANDS).optional(),
  /** worker_review のときだけ。この段階では 0（省略も 0）だけ。1 は「修正の回は未実装」 */
  review_fix_rounds: z.number().optional(),
  /** 廃止。review_policy に置き換えた（渡されたら invalid_input にして、黙って無視しない） */
  merge_policy: z
    .never({ error: "merge_policy was removed; use review_policy (client_review | worker_review)" })
    .optional(),
  budget_policy: z.enum(BUDGET_POLICIES).default(DEFAULT_BUDGET_POLICY),
  /** ワーカーのモデル（D10）。省略は env の AGENT_MODEL。env の AGENT_MODELS の中だけ（照合は service と TaskDO が env で行う） */
  model: z.string().min(1).max(MAX_MODEL_LENGTH).optional(),
  /**
   * ワーカーの Sandbox の大きさ。standard-1〜4 だけ（lite は選べない。packages/models の SELECTABLE_SANDBOX_INSTANCES が出どころ）。
   * 省略は agent の env の既定（SANDBOX_INSTANCE）。指定したらそのタスクの間はずっとその大きさ。
   */
  sandbox_instance: z.enum(SELECTABLE_SANDBOX_INSTANCES).optional(),
  /**
   * ワーカーのモデルの思考レベル（そのタスクだけの上書き）。値は packages/models の EFFORT_LEVELS（Effort の型）が出どころ。
   * 省略は、モデルごとの既定（env の MODEL_EFFORTS で上書きした値。models_list の effort）。
   * そのモデルが受け付けるか（supportedEfforts）は、最終のモデルが決まってから service と TaskDO が確かめる（invalid_input）。
   */
  effort: z.enum(EFFORT_LEVELS).optional(),
});

/** review_* の組み合わせの検査（taskInputSchema と、idempotency_key を足した MCP の入力の両方で使う） */
export function checkReviewFields(
  v: Pick<
    z.infer<typeof taskInputObject>,
    "review_policy" | "review_model" | "review_commands" | "review_fix_rounds"
  >,
  ctx: z.core.$RefinementCtx,
): void {
  const given = (["review_model", "review_commands", "review_fix_rounds"] as const).filter(
    (k) => v[k] !== undefined,
  );
  if (v.review_policy !== "worker_review") {
    // client_review で review_* が渡されたら、黙って無視せず断る
    for (const k of given) {
      ctx.addIssue({
        code: "custom",
        path: [k],
        message: `${k} is only for review_policy worker_review`,
      });
    }
    return;
  }
  if (v.review_model === undefined) {
    ctx.addIssue({
      code: "custom",
      path: ["review_model"],
      message: "review_model is required for review_policy worker_review",
    });
  }
  if (v.review_fix_rounds !== undefined) {
    if (v.review_fix_rounds === 1) {
      ctx.addIssue({
        code: "custom",
        path: ["review_fix_rounds"],
        message: FIX_ROUNDS_NOT_IMPLEMENTED,
      });
    } else if (v.review_fix_rounds !== 0) {
      ctx.addIssue({
        code: "custom",
        path: ["review_fix_rounds"],
        message: "review_fix_rounds must be 0 (or 1, which is not implemented yet)",
      });
    }
  }
}

export const taskInputSchema = taskInputObject.superRefine(checkReviewFields);

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
 * review_policy は client_review だけが使えるので、v1 / v2 には含めない。model または sandbox_instance があるときの v4 / v5 には
 * review_policy を一緒に足す（merge_policy の頃の形を引き継ぐ）。
 * model は未指定なら含めない。指定があれば v4 として review_policy と一緒に末尾へ足す。
 * sandbox_instance も未指定なら含めない（v1〜v4 のまま）。指定があれば v5 として、model（無ければ null）の後ろへ足す。
 * worker_review のときは v6 として、review_policy・model・sandbox_instance（無ければ null）に続けて review_model・review_commands・
 * review_fix_rounds（省略は 0）を足す（client_review の指紋は変えない。次の budget_policy の v6 の包みとは、2 番目の要素が文字列か配列かで区別できる）。
 * budget_policy は既定（ask）なら含めない（これまでの値と一致させる）。stop のときだけ、上の全体を v6 で包んで足す。
 * effort は未指定なら含めない（これまでの値と一致させる）。指定があれば、上の全体を v7 で包んで末尾に足す（利用者の入力なので、
 * model を rovo が選んだとき（mode: auto）も含める）。
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
  const base =
    input.review_policy === "worker_review"
      ? [
          "v6",
          ...fields,
          commands,
          input.review_policy,
          input.model ?? null,
          input.sandbox_instance ?? null,
          input.review_model ?? null,
          (input.review_commands ?? []).map((c) => [
            c.argv,
            c.cwd ?? null,
            c.timeout_seconds ?? null,
          ]),
          input.review_fix_rounds ?? 0,
        ]
      : input.sandbox_instance !== undefined
        ? [
            "v5",
            ...fields,
            commands,
            input.review_policy,
            input.model ?? null,
            input.sandbox_instance,
          ]
        : input.model !== undefined
          ? ["v4", ...fields, commands, input.review_policy, input.model]
          : commands.length === 0
            ? ["v1", ...fields]
            : ["v2", ...fields, commands];
  const withBudget = input.budget_policy === "stop" ? ["v6", base] : base;
  const canonical = JSON.stringify(
    input.effort !== undefined ? ["v7", withBudget, input.effort] : withBudget,
  );
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonical));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * task_review の入力（docs/specs/worker-review.md「task_review」）。クライアントが作った PR のレビューだけを頼む。
 * review_model は必須（作業のモデルを黙って使わない）。review_commands は verification_commands と同じ形で、空なら差分だけのレビュー。
 * strict: 宣言に無いキー（初版では使えない review_fix_rounds など）は invalid_input にする（黙って捨てない）。idempotency_key は含めない。
 */
export const reviewInputSchema = z
  .object({
    repository: taskInputObject.shape.repository,
    pull_number: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
    review_model: z.string().min(1).max(MAX_MODEL_LENGTH),
    review_commands: z.array(verificationCommandSchema).max(MAX_VERIFICATION_COMMANDS).default([]),
    budget_policy: z.enum(BUDGET_POLICIES).default(DEFAULT_BUDGET_POLICY),
    sandbox_instance: z.enum(SELECTABLE_SANDBOX_INSTANCES).optional(),
  })
  .strict();

export type ReviewInput = z.infer<typeof reviewInputSchema>;

/**
 * task_review の指紋（SHA-256, hex）。repository（小文字）・PR の番号・**その時点の head の SHA**（小文字）・review_model・
 * review_commands（argv / cwd / timeout_seconds を順序込み）・budget_policy・sandbox_instance から作る。
 * 同じ PR の同じ head に同じ条件で頼み直しても同じ値（二重に投稿しない）。head が進めば別の値。
 * task_start の指紋（computeFingerprint）とは別の接頭辞にして、衝突させない（task_start の指紋は変えない）。
 */
export async function computeReviewFingerprint(
  input: ReviewInput,
  headSha: string,
): Promise<string> {
  const canonical = JSON.stringify([
    "review-v1",
    input.repository.toLowerCase(),
    input.pull_number,
    headSha.toLowerCase(),
    input.review_model,
    input.review_commands.map((c) => [c.argv, c.cwd ?? null, c.timeout_seconds ?? null]),
    input.budget_policy,
    input.sandbox_instance ?? null,
  ]);
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonical));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** task_answer の answer / task_steer の message の長さの上限（文字数）。 */
export const MAX_ANSWER_LENGTH = 20_000;
export const MAX_STEER_LENGTH = 20_000;
const MAX_ID_LENGTH = 128;

/** task_answer の入力。回答は認証されたクライアントからの指示なので内容は縛らず、長さだけ制限する。 */
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
