import { maskSecrets } from "@rovo/audit";

/** ログに残すメッセージの最大文字数 */
export const LOG_ERROR_MESSAGE_MAX = 200;

/**
 * 例外のメッセージを、ログに出せる形にする（資格情報らしき文字列をマスクし、200 文字で切る）。
 * 名前だけでは原因が分からない障害（本番だけの TypeError など）を追うためのもの。Error 以外は型名だけ。
 */
export function errorMessageForLog(e: unknown): string {
  if (!(e instanceof Error)) return typeof e;
  let message: string;
  try {
    message = String(e.message);
  } catch {
    return "";
  }
  return maskSecrets(message).slice(0, LOG_ERROR_MESSAGE_MAX);
}
