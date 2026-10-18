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

/** task_start の入力（design.md 4.3）。idempotency_key は含めない。 */
export const taskInputSchema = z.object({
  // GitHub の上限: owner は 39 文字、リポジトリ名は 100 文字
  repository: z.string().regex(/^[A-Za-z0-9_.-]{1,39}\/[A-Za-z0-9_.-]{1,100}$/, "owner/name 形式"),
  base_ref: z.string().min(1).max(255),
  base_sha: z.string().regex(/^[0-9a-fA-F]{7,40}$/, "7〜40桁の16進"),
  title: z.string().min(1).max(MAX_TITLE),
  instructions: z.string().min(1).max(MAX_INSTRUCTIONS),
  acceptance_criteria: stringList.default([]),
  constraints: stringList.default([]),
  verification_commands: z
    .array(verificationCommandSchema)
    .max(MAX_VERIFICATION_COMMANDS)
    .default([]),
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
    commands.length === 0 ? ["v1", ...fields] : ["v2", ...fields, commands],
  );
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonical));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
