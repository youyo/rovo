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

/** task_start の入力（design.md 4.3）。idempotency_key は含めない。 */
export const taskInputSchema = z.object({
  repository: z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/, "owner/name 形式"),
  base_ref: z.string().min(1).max(255),
  base_sha: z.string().regex(/^[0-9a-fA-F]{7,40}$/, "7〜40桁の16進"),
  title: z.string().min(1).max(MAX_TITLE),
  instructions: z.string().min(1).max(MAX_INSTRUCTIONS),
  acceptance_criteria: stringList.default([]),
  constraints: stringList.default([]),
});

export type TaskInput = z.infer<typeof taskInputSchema>;

/**
 * 入力の fingerprint（SHA-256, hex）。
 * 項目を固定順の配列にして JSON 化するので、プロパティ順や連結の曖昧さに影響されない。
 * 正規化: repository と base_sha は小文字化（GitHub 上は大文字小文字を区別しない）。
 * 配列の省略は空配列として扱う。base_ref などは区別するのでそのまま。
 */
export async function computeFingerprint(input: TaskInput): Promise<string> {
  const canonical = JSON.stringify([
    "v1",
    input.repository.toLowerCase(),
    input.base_ref,
    input.base_sha.toLowerCase(),
    input.title,
    input.instructions,
    input.acceptance_criteria ?? [],
    input.constraints ?? [],
  ]);
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonical));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
