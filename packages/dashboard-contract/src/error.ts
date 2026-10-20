import { z } from "zod";

/**
 * エラーの本文。コードだけで、理由の文章・タスクやリポジトリの名前は持たない
 * （権限が無い・存在しない・`repository_id` が無いは、どれも `not_found` で見分けがつかない）。
 */
export const ERROR_CODES = [
  "unauthorized", // 401: 未ログイン・セッション失効
  "forbidden", // 403: 別 Origin からの呼び出し
  "not_found", // 404
  "bad_request", // 400
  "unavailable", // 503: GitHub の障害など
] as const;

export const ErrorDtoSchema = z.strictObject({ error: z.enum(ERROR_CODES) });
export type ErrorDto = z.infer<typeof ErrorDtoSchema>;
