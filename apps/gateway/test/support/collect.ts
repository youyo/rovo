/**
 * full E2E の collect（task_wait を cursor でつないで、条件が満たされるまでイベントを集める）の本体。
 * 待ち時間の上限は呼び出し側が決める（ここでは変えない）。判定（until）も呼び出し側のまま。
 * 上限を超えて落ちるときに、原因を後から追えるよう、状態（最後のイベントの seq・時刻・種別、経過時間）と
 * 診断（diagnose。AgentDO / SandboxDO の状態、wrangler のログ、docker ps など）をメッセージに含める。
 * 時刻は now で差し替えられる（Unit 用）。
 */
export interface CollectEvent {
  seq: number;
  type: string;
  payload: Record<string, unknown>;
  /** task_wait が返す時刻（ms）。無ければ省く */
  ts?: number;
}

export interface WaitPage {
  status: string;
  events: CollectEvent[];
  cursor: string;
}

export interface CollectTiming {
  /** 集め終わるまでの時間 */
  totalMs: number;
  /** 最初に status が RUNNING になったイベントを見るまでの時間（見なければ undefined） */
  firstRunningMs?: number;
}

export interface CollectOptions {
  wait(cursor: string | undefined): Promise<WaitPage>;
  until(status: string, events: CollectEvent[]): boolean;
  timeoutMs: number;
  now?: () => number;
  /** 上限を超えたときだけ呼ぶ。失敗しても元のエラーで落とす。 */
  diagnose?: () => Promise<string>;
  /** diagnose を待つ上限（ms）。固まっても元の timeout のエラーで落とすため。既定 30 秒。 */
  diagnoseTimeoutMs?: number;
}

export async function collectUntil(
  opts: CollectOptions,
): Promise<{ status: string; events: CollectEvent[]; timing: CollectTiming }> {
  const now = opts.now ?? Date.now;
  const events: CollectEvent[] = [];
  let cursor: string | undefined;
  const started = now();
  const deadline = started + opts.timeoutMs;
  let firstRunningMs: number | undefined;
  for (;;) {
    const w = await opts.wait(cursor);
    events.push(...w.events);
    cursor = w.cursor;
    if (
      firstRunningMs === undefined &&
      w.events.some((e) => e.type === "status_changed" && e.payload.status === "RUNNING")
    ) {
      firstRunningMs = now() - started;
    }
    if (opts.until(w.status, events)) {
      const timing: CollectTiming = { totalMs: now() - started };
      if (firstRunningMs !== undefined) timing.firstRunningMs = firstRunningMs;
      return { status: w.status, events, timing };
    }
    if (now() > deadline) {
      const last = events[events.length - 1];
      const lastText = last
        ? `seq ${last.seq} ${last.type}${last.ts !== undefined ? ` ts=${new Date(last.ts).toISOString()}` : ""}`
        : "none";
      let diag = "";
      if (opts.diagnose) {
        try {
          diag = maskTokens(await withTimeout(opts.diagnose(), opts.diagnoseTimeoutMs ?? 30_000));
        } catch (e) {
          diag = maskTokens(`diagnose failed: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
      throw new Error(
        `timeout; status=${w.status} events=${events.length} last=${lastText} elapsed=${now() - started}ms${
          firstRunningMs !== undefined ? ` firstRunning=${firstRunningMs}ms` : ""
        }${diag ? `\n${diag}` : ""}`,
      );
    }
  }
}

async function withTimeout(p: Promise<string>, ms: number): Promise<string> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      p,
      new Promise<string>((resolve) => {
        timer = setTimeout(() => resolve(`diagnose timed out after ${ms}ms`), ms);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * 診断に入る文字列（agent のイベントの data、wrangler のログの末尾）から、トークンらしいものを伏せる。
 * これらは test 専用の偽データ（偽 GitHub が発行した ghs_fake… など）だが、貼り付けて共有されうるので念のため。
 */
export function maskTokens(text: string): string {
  return text
    .replace(/github_pat_[A-Za-z0-9_]+/g, "[masked]")
    .replace(/\bgh[opsur]_[A-Za-z0-9_]+/g, "[masked]")
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [masked]");
}
