/**
 * TaskDO から Directory への配送が失敗したときの再試行間隔（定数はここ 1 か所）。
 * 10 秒から倍々で、上限は 5 分。失敗が 10 回続いたら（長い障害とみなして）上限を 1 時間に延ばす。
 * 打ち切りはしない（復旧したら追いつく）。復旧の瞬間に全タスクが一斉に送らないよう、±20% のジッターを付ける。
 */
export const INDEX_BACKOFF = {
  baseMs: 10_000,
  maxMs: 5 * 60_000,
  /** この回数だけ失敗が続いたら、上限を slowMaxMs にする */
  slowAfterAttempts: 10,
  slowMaxMs: 60 * 60_000,
  /** ±の割合 */
  jitter: 0.2,
} as const;

/**
 * attempts 回目（1 から）の失敗の後に待つ時間（ms）。random は [0, 1) の乱数（テストで差し替える）。
 */
export function indexBackoffMs(attempts: number, random: () => number): number {
  const n = Math.max(1, Math.floor(attempts));
  const raw =
    n >= INDEX_BACKOFF.slowAfterAttempts
      ? INDEX_BACKOFF.slowMaxMs
      : Math.min(INDEX_BACKOFF.maxMs, INDEX_BACKOFF.baseMs * 2 ** (n - 1));
  const factor = 1 + (random() * 2 - 1) * INDEX_BACKOFF.jitter;
  return Math.round(raw * factor);
}
