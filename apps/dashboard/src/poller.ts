/**
 * 自動更新のポーリング（D15）。React に依存しない核。タイマー・可視状態は差し替えられる（Unit で決定的に試す）。
 *
 * - 成功したら 5 秒後に次を取る。失敗は 10→20→40→最大 60 秒の backoff（成功で 5 秒に戻る）
 * - タブが hidden の間は予約せず、visible に戻ったら即 1 回取る
 * - 同時に 2 本走らせない（取得中の refresh は、終わってからもう 1 回）
 * - 401（unauthorized）と 404（not_found）は止まる。手動の refresh だけが再開できる
 * - finished（終端のタスクを追い終えた）も同じく止まる
 * - 自動更新を切ると予約を消す。手動の refresh は取れる
 * - hidden でも続ける条件（工場の小窓が見えている間など）は withKeepAlive で isHidden に差し込む（ポーラーは 1 本のまま）
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
  /** 次の取得までの間隔。関数なら予約のたびに呼び直す（PR の CI は、実行中は短く、終わったら長くする） */
  intervalMs?: number | (() => number);
  autoRefresh?: boolean;
  deps?: PollerDeps;
}): Poller {
  const deps = opts.deps ?? browserDeps;
  const intervalOf = (): number => {
    const v = opts.intervalMs;
    return (typeof v === "function" ? v() : v) ?? DEFAULT_INTERVAL_MS;
  };
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
    const interval = intervalOf();
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

/**
 * hidden でも自動更新を続ける条件（docs/specs/dashboard-factory.md の「小窓」）。条件は 1 つだけ差し込める（後から set したもので置き換わる）。
 * 工場の小窓（遅延チャンク）が開いている間、「小窓の文書が visible か」を set し、小窓の visibilitychange で notify、閉じたら set(null)。
 */
export type KeepAlive = {
  /** 今、hidden でも続けるか */
  active(): boolean;
  /** 条件の変化を購読する。戻り値は購読の解除 */
  subscribe(cb: () => void): () => void;
  /** 条件を差し込む（null で外す）。購読者に知らせる */
  set(fn: (() => boolean) | null): void;
  /** 条件の値が変わったかもしれないことを知らせる */
  notify(): void;
};

export function createKeepAlive(): KeepAlive {
  let cond: (() => boolean) | null = null;
  const subs = new Set<() => void>();
  const notify = () => {
    for (const cb of [...subs]) cb();
  };
  return {
    active: () => cond?.() === true,
    subscribe(cb) {
      subs.add(cb);
      return () => subs.delete(cb);
    },
    set(fn) {
      cond = fn;
      notify();
    },
    notify,
  };
}

/** 一覧（use-overview）の自動更新に差し込む条件。工場の小窓が使う */
export const overviewKeepAlive = createKeepAlive();

/**
 * 元の可視状態に「hidden でも続ける条件」を重ねた PollerDeps。hidden = 元が hidden かつ条件が立っていない。
 * 元の visibilitychange・条件の通知とも、重ねた hidden の判定が変わったときだけ渡す
 * （小窓を開いただけ・小窓が見えている間に元が hidden になっただけでは取り直さない。ポーラーは 1 本）。
 */
export function withKeepAlive(deps: PollerDeps, keep: KeepAlive): PollerDeps {
  const isHidden = () => deps.isHidden() && !keep.active();
  return {
    setTimer: deps.setTimer,
    clearTimer: deps.clearTimer,
    isHidden,
    onVisibilityChange(cb) {
      let last = isHidden();
      const check = () => {
        const now = isHidden();
        if (now === last) return;
        last = now;
        cb();
      };
      const offBase = deps.onVisibilityChange(check);
      const offKeep = keep.subscribe(check);
      return () => {
        offBase();
        offKeep();
      };
    },
  };
}
