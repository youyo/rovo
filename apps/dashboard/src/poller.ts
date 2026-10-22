/**
 * 自動更新のポーリング（D15）。React に依存しない核。タイマー・可視状態は差し替えられる（Unit で決定的に試す）。
 *
 * - 成功したら 5 秒後に次を取る。失敗は 10→20→40→最大 60 秒の backoff（成功で 5 秒に戻る）
 * - タブが hidden の間は予約せず、visible に戻ったら即 1 回取る
 * - 同時に 2 本走らせない（取得中の refresh は、終わってからもう 1 回）
 * - 401（unauthorized）と 404（not_found）は止まる。手動の refresh だけが再開できる
 * - finished（終端のタスクを追い終えた）も同じく止まる
 * - 自動更新を切ると予約を消す。手動の refresh は取れる
 */

export type PollOutcome = "ok" | "error" | "unauthorized" | "not_found" | "finished";

export type PollerDeps = {
  setTimer: (fn: () => void, ms: number) => unknown;
  clearTimer: (handle: unknown) => void;
  isHidden: () => boolean;
  /** 可視状態の変化を購読する。戻り値は購読の解除 */
  onVisibilityChange: (cb: () => void) => () => void;
};

export const DEFAULT_INTERVAL_MS = 5_000;
export const MAX_BACKOFF_MS = 60_000;

export const browserDeps: PollerDeps = {
  setTimer: (fn, ms) => setTimeout(fn, ms),
  clearTimer: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
  isHidden: () => typeof document !== "undefined" && document.visibilityState === "hidden",
  onVisibilityChange: (cb) => {
    document.addEventListener("visibilitychange", cb);
    return () => document.removeEventListener("visibilitychange", cb);
  },
};

export type Poller = {
  start(): void;
  stop(): void;
  /** 手動の取り直し（自動更新が切れていても、hidden でも、止まっていても取る） */
  refresh(): void;
  setAutoRefresh(on: boolean): void;
};

export function createPoller(opts: {
  run: () => Promise<PollOutcome>;
  intervalMs?: number;
  autoRefresh?: boolean;
  deps?: PollerDeps;
}): Poller {
  const deps = opts.deps ?? browserDeps;
  const interval = opts.intervalMs ?? DEFAULT_INTERVAL_MS;
  let auto = opts.autoRefresh ?? true;
  let started = false;
  let inflight = false;
  let rerun = false;
  let terminal = false;
  let failures = 0;
  let timer: unknown = null;
  let unsubscribe: (() => void) | null = null;

  const clear = () => {
    if (timer !== null) {
      deps.clearTimer(timer);
      timer = null;
    }
  };

  const schedule = () => {
    clear();
    if (!started || !auto || terminal || deps.isHidden()) return;
    const delay = failures === 0 ? interval : Math.min(interval * 2 ** failures, MAX_BACKOFF_MS);
    timer = deps.setTimer(() => {
      timer = null;
      void tick();
    }, delay);
  };

  const tick = async (): Promise<void> => {
    if (!started || inflight) return;
    inflight = true;
    clear();
    let outcome: PollOutcome;
    try {
      outcome = await opts.run();
    } catch {
      outcome = "error";
    }
    inflight = false;
    if (!started) return;
    if (outcome === "ok") {
      failures = 0;
      terminal = false;
    } else if (outcome === "error") {
      failures += 1;
    } else {
      terminal = true;
    }
    if (rerun) {
      rerun = false;
      void tick();
      return;
    }
    schedule();
  };

  const onVisibility = () => {
    if (!started) return;
    if (deps.isHidden()) {
      clear();
      return;
    }
    if (auto && !terminal && !inflight) void tick();
  };

  return {
    start() {
      if (started) return;
      started = true;
      unsubscribe = deps.onVisibilityChange(onVisibility);
      if (!deps.isHidden()) void tick();
    },
    stop() {
      started = false;
      clear();
      unsubscribe?.();
      unsubscribe = null;
    },
    refresh() {
      if (!started) return;
      terminal = false;
      if (inflight) rerun = true;
      else void tick();
    },
    setAutoRefresh(on) {
      auto = on;
      if (on) schedule();
      else clear();
    },
  };
}
