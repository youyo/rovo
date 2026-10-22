import { maskSecrets } from "./redact";
import { sanitizeText, truncateMiddle, truncateStart } from "./sanitize";
import { relPath, STRUCTURED_LIMITS } from "./structured";

/**
 * 実行中のコマンドの途中の出力（command_progress）。終わったコマンドの command イベントとは別物で、
 * gateway は履歴（events）に積まず、最新の 1 件だけを上書きで持つ。途中で漏れかけた断片を永続化しないため。
 * フィールド名は command イベントと同じ outputTail にして、AgentDO の maskEventStrings にも効くようにする。
 */
export interface CommandProgressEvent {
  type: "command_progress";
  command: string;
  cwd?: string;
  /** 実行を始めた時刻（epoch ms） */
  startedAt: number;
  outputTail?: string;
  /** コマンドが（command イベントを出さずに）終わった・失敗したので、進捗を消す合図 */
  ended?: true;
}

/** 最後の改行より後（まだ書き終わっていない行）を落とす。改行が無ければ空 */
function dropIncompleteLine(text: string): string {
  const i = text.lastIndexOf("\n");
  return i < 0 ? "" : text.slice(0, i + 1);
}

/** 閉じていない -----BEGIN があれば、その行頭から先を落とす（鍵の本文が出てから END が来るまでの間を見せない） */
function dropOpenPem(text: string): string {
  const begin = text.lastIndexOf("-----BEGIN");
  if (begin < 0 || text.lastIndexOf("-----END") > begin) return text;
  const lineStart = text.lastIndexOf("\n", begin) + 1;
  return text.slice(0, lineStart);
}

/**
 * 実行中の出力の窓（stream ごとの末尾 64KiB まで）から、ダッシュボードに出してよい末尾を作る。
 * 順序が要点: 整形（ANSI の除去）→ 未完の行と閉じていない鍵を落とす → **窓全体**をマスク → 最後に末尾 2,000 字へ切る。
 * 切ってからマスクすると、切り口で割れた秘密がパターンに合わず素通りする。
 */
export function buildProgressTail(streams: string[]): string {
  const parts = streams
    .map((s) => maskSecrets(dropOpenPem(dropIncompleteLine(sanitizeText(s)))))
    .filter((s) => s !== "");
  return truncateStart(parts.join("\n"), STRUCTURED_LIMITS.outputTail);
}

/** command_progress の正規化。command と startedAt が不正なら undefined。agent は積む前に、gateway は取り込み時に通す（冪等） */
export function normalizeCommandProgress(data: unknown): CommandProgressEvent | undefined {
  if (typeof data !== "object" || data === null || Array.isArray(data)) return undefined;
  const d = data as Record<string, unknown>;
  if (typeof d.command !== "string") return undefined;
  const command = maskSecrets(sanitizeText(d.command)).trim();
  if (command === "") return undefined;
  if (typeof d.startedAt !== "number" || !Number.isFinite(d.startedAt) || d.startedAt < 0) {
    return undefined;
  }
  const cwd = relPath(d.cwd);
  const outputTail =
    typeof d.outputTail === "string" && d.outputTail !== ""
      ? truncateStart(maskSecrets(sanitizeText(d.outputTail)), STRUCTURED_LIMITS.outputTail)
      : undefined;
  return {
    type: "command_progress",
    command: truncateMiddle(command, STRUCTURED_LIMITS.command),
    ...(cwd !== undefined && cwd !== "." ? { cwd } : {}),
    startedAt: Math.floor(d.startedAt),
    ...(outputTail !== undefined ? { outputTail } : {}),
    ...(d.ended === true ? { ended: true as const } : {}),
  };
}
