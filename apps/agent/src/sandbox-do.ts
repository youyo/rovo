import { DurableObject } from "cloudflare:workers";
import { posix } from "node:path";
import { Files } from "@cloudflare/sandbox";
import type { AuditFields, AuditRecord } from "@rovo/audit";
import {
  resolveMaxSandboxInstance,
  resolveSandboxInstance,
  SANDBOX_INSTANCES,
  type SandboxInstance,
  type SandboxPromotionReason,
  type SandboxPromotionTrigger,
} from "@rovo/models";
import type {
  GitCredential,
  SandboxMetrics,
  SandboxPromotionFailure,
  SandboxPromotionRecord,
  SandboxScaleDecision,
  SandboxScaleStats,
} from "./agent/types";
import { appendTestAudit, emitAudit, readTestAudit } from "./audit-adapter";
import { PROCESS_SCRIPT, PROMOTE_STATE_SCRIPT, SCALE_FACTS_SCRIPT } from "./container-scripts";
import { decryptString, encryptString, importEncryptionKey } from "./crypto";
import {
  DEPS_BUILD_TIMEOUT_MS,
  DEPS_CACHE_DIR,
  DEPS_INSTALLS,
  type DepsBuildRequest,
  type DepsBuildResult,
  type DepsCacheStatus,
  type DepsEnsureRequest,
  type DepsEnsureResult,
  type DepsLockfile,
  type DepsMissReason,
  type DepsSpec,
  depsCacheKey,
  depsSnapshotName,
  parseDepsSpec,
} from "./deps-cache";
import { DEPS_FETCH_SCRIPT, DEPS_RESTORE_SCRIPT, DEPS_STASH_SCRIPT } from "./deps-scripts";
import type { OutboundGatewayProps } from "./outbound-gateway";
import { maskSecrets } from "./redact";
import type {
  ExecOptions,
  ExecResult,
  PeekedOutput,
  PushPermit,
  SandboxPort,
  WorkspaceSpec,
} from "./sandbox-port";
import {
  buildDecisionState,
  decideSandboxSize,
  type RecentCommand,
  resolveClefThresholds,
} from "./sandbox-scale-decision";
import { isLightCommand, scaleCmd } from "./scale-cmd";
import { TailBuffer } from "./tail-buffer";
import {
  isInsideWorkspace,
  parseRepository,
  resolveWorkspacePath,
  validateWorkspaceSpec,
} from "./workspace-path";

const WORKSPACE = "/workspace";
const CA_CERT = "/etc/cloudflare/certs/cloudflare-containers-ca.crt";
/** HTTPS 傍受の CA を各ツールに信用させる。exec は PATH しか引き継がないので毎回渡す。 */
const BASE_ENV: Record<string, string> = {
  NODE_EXTRA_CA_CERTS: CA_CERT,
  GIT_SSL_CAINFO: CA_CERT,
  REQUESTS_CA_BUNDLE: CA_CERT,
  SSL_CERT_FILE: CA_CERT,
  // 作業ツリー（/workspace）に npm のキャッシュなどが書かれて git add -A に混ざらないよう、HOME は外に置く
  HOME: "/root",
  // pnpm / yarn の本体はイメージのビルド時にここへ入れてある（apps/agent/Dockerfile）
  COREPACK_HOME: "/opt/corepack",
  // corepack が pnpm / yarn の本体を取るときに「ダウンロードしてよいか」の確認で止まらないようにする
  COREPACK_ENABLE_DOWNLOAD_PROMPT: "0",
  GIT_TERMINAL_PROMPT: "0",
  GIT_CONFIG_COUNT: "1",
  GIT_CONFIG_KEY_0: "safe.directory",
  GIT_CONFIG_VALUE_0: WORKSPACE,
};
const DEFAULT_TIMEOUT_MS = 10 * 60_000;
/** 自動の push の許可証（storage の kv）のキー。exec の間だけ置き、finally で消す。 */
const PUSH_PERMIT_KEY = "push_permit";
/** 許可証の期限は exec の時間切れ + この猶予（消し忘れても、この後は無効になる）。 */
const PUSH_PERMIT_GRACE_MS = 30_000;
const DEFAULT_MAX_OUTPUT = 64 * 1024;
const MAX_FILE_BYTES = 8 * 1024 * 1024;
/**
 * コンテナの無操作の期限（container.setInactivityTimeout）。設定しないと、DO が inactive になった直後にコンテナが止まり、
 * push していない作業が消える。KEEPALIVE_MS（60 秒の alarm）より十分長い。
 * 期限は上限であり、タスクの期限・terminate では rovo 自身がこれまでどおり destroy する。DO が restart すると消えるので、constructor で設定し直す。
 */
const INACTIVITY_TIMEOUT_MS = 2 * 60 * 60_000;
const KEEPALIVE_MS = 60_000;
const REAPER_TIMEOUT_MS = 10_000;
const STREAM_GRACE_MS = 2_000;
const DESTROY_WAIT_MS = 15_000;
const CLONE_TIMEOUT_MS = 5 * 60_000;
/** pnpm / yarn の本体を用意するスクリプト（Dockerfile が置く）と、その期限。 */
const PM_PREPARE_SCRIPT = "/usr/local/lib/rovo/pm-prepare.mjs";
const PM_PREPARE_TIMEOUT_MS = 3 * 60_000;
/** 残り時間がこれ未満なら、用意しない(間に合わない) */
const PM_PREPARE_MIN_MS = 10_000;
/**
 * コンテナが ready になる（exec が応答する）までの 1 回あたりの期限。
 * 正常な起動は E2E の実測で ensureReady 全体が 0.9 秒前後（最大 0.92 秒、clone を含む）。その約 25 倍を見る。
 * 止まった起動は何分待っても進まないので、これを超えたら破棄して起動し直す。
 * 待ちは試行ごとに数える（前の試行の破棄にかかった時間で、次の試行の待ちを削らない）。
 */
const BOOT_ATTEMPT_MS = 25_000;
const BOOT_MAX_ATTEMPTS = 3;
/**
 * 起動の途中で行う破棄の待ちの上限（1 回あたり）。通常の DESTROY_WAIT_MS（15 秒）より短くする。
 * 起動全体の最悪時間 = 最初の破棄 10 + 3 x (待ち 25 + 破棄 10) = 115 秒 < E2E の 1 操作の期限 120 秒。
 * 破棄が上限内に止まらなければ、そこで "container did not stop" として失敗する（残りの試行は行わない）。
 */
const BOOT_DESTROY_MS = 10_000;
const BOOT_POLL_MS = 500;
/** 期限の延長の上限: 作成から 2 時間（タスクの最長）+ 回答待ちの累計の上限 24 時間 */
const MAX_TASK_MS = 2 * 60 * 60_000;
const MAX_INPUT_PAUSE_MS = 24 * 60 * 60_000;

/** 昇格のためのスナップショット（実行中のコンテナのディスクの保存）を待つ上限。超えたら昇格を諦めて小さいまま続ける */
const PROMOTE_SNAPSHOT_MS = 2 * 60_000;
/** 昇格の前後で作業ツリーの状態を読む（HEAD・差分・追跡されていないファイル）のに許す時間 */
const PROMOTE_STATE_TIMEOUT_MS = 60_000;
/** usage.sandbox_promotion_failures に残す最大の件数（超えた分は捨てる） */
const MAX_PROMOTION_FAILURES = 8;

// ---- Clef による昇格の判断（sandbox-scale-decision.ts）----
/** 判断の記録（usage.sandbox_scale_decisions）に残す最大の件数。超えたら古い方から捨てる（集計は捨てずに数え続ける） */
const MAX_SCALE_DECISIONS = 50;
/** リポジトリの事実（設定ファイルの生のテキスト）の最大の文字数と、集めるのに許す時間 */
const SCALE_FACTS_MAX_CHARS = 6_000;
const SCALE_FACTS_TIMEOUT_MS = 10_000;
/** 事実を覚えておく時間（ワーカーが設定ファイルを書き換えたときに作り直す）と、覚えておく cwd の数 */
const SCALE_FACTS_TTL_MS = 10 * 60_000;
const SCALE_FACTS_KEEP = 3;
/** state に入れる直近のコマンドの数 */
const RECENT_COMMANDS_KEEP = 3;
/** 「上げなかったのに長くかかった」とみなすコマンドの実行時間（ms） */
const SLOW_COMMAND_MS = 60_000;

/** 依存関係のキャッシュの ensure（作成を待つことがある）を待つ上限。作成の時間切れ + 余裕 */
const DEPS_ENSURE_WAIT_MS = DEPS_BUILD_TIMEOUT_MS + 60_000;
/** 退避した node_modules を作業ツリーへ戻す（同じファイルシステム内の mv）のに許す時間 */
const DEPS_RESTORE_TIMEOUT_MS = 2 * 60_000;
const DEPS_STATUS_RANK: Record<DepsCacheStatus, number> = {
  disabled: 0,
  miss: 1,
  hit: 2,
  built: 3,
};
const DEPS_KEY = /^[0-9a-f]{64}$/;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** 例外の文面（診断ログ用。長さを抑え、秘密を伏せる） */
const errorText = (e: unknown): string =>
  maskSecrets(e instanceof Error ? e.message : String(e)).slice(0, 300);

/** キャッシュを作る途中の失敗。reason は固定コード（例外の文面は外へ出さない）。 */
class DepsBuildError extends Error {
  constructor(
    readonly reason: DepsMissReason,
    readonly detail = "",
  ) {
    super(reason);
  }
}

/** promise を期限（絶対時刻）まで待つ。期限が来たら "timeout"（promise は放置する）。 */
async function withDeadline<T>(promise: Promise<T>, until: number): Promise<T | "timeout"> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => resolve("timeout"), Math.max(0, until - Date.now()));
  });
  // 放置した promise の失敗を Unhandled にしない
  promise.catch(() => {});
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * 昇格のスナップショットの名前（人が見分けるための名前。識別は id で行う）。DO の名前（= タスク ID）と、何回目の昇格か（seq）から作る。
 * 昇格はワーカーの要求で何回も起きるので、同じ名前を使い回さない（同名の扱いに依存しない）。
 */
function promoteSnapshotName(taskId: string | undefined, seq: number): string {
  return `promote-${(taskId ?? "").replace(/[^A-Za-z0-9_-]/g, "").slice(0, 32)}-${seq}`;
}

/** 中断（回答待ちの間にコンテナを止める）のスナップショットの名前。昇格と同じ考え方（名前の重複に依存しない） */
function suspendSnapshotName(taskId: string | undefined, seq: number): string {
  return `suspend-${(taskId ?? "").replace(/[^A-Za-z0-9_-]/g, "").slice(0, 32)}-${seq}`;
}

/** 確率を小数 2 桁にする（記録を小さくする） */
const round2 = (n: number): number => Math.round(n * 100) / 100;

interface RawResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/** stream を読み続けて buf に溜める（読むのを止めるとプロセスが書き込みで詰まる）。cancel で打ち切れる。 */
function drain(stream: ReadableStream<Uint8Array> | null | undefined, buf: TailBuffer) {
  const reader = stream?.getReader();
  const done = (async () => {
    if (!reader) return;
    try {
      for (;;) {
        const { done: end, value } = await reader.read();
        if (end) break;
        buf.append(value);
      }
    } catch {
      // cancel されたか、プロセスが落ちた
    }
  })();
  return { done, cancel: () => void reader?.cancel().catch(() => {}) };
}

/** terminate 後の exec の結果。exitCode は 0 以外なので、呼び出し側は失敗として扱う。 */
const TERMINATED_RESULT: ExecResult = {
  exitCode: -1,
  stdout: "",
  stderr: "sandbox was terminated",
  timedOut: false,
  truncated: false,
  terminated: true,
};

/** 起動の前に決める、依存関係のキャッシュの扱い */
type DepsPlan =
  | { kind: "disabled" }
  | { kind: "miss"; reason: DepsMissReason }
  | { kind: "snapshot"; key: string; snapshotId: string; built: boolean };

/** start したコンテナ 1 つぶんの記録（メモリのみ。停止の診断に使う） */
interface ContainerLife {
  startGen: number;
  /** rovo 自身が destroy を呼んだか */
  destroyedByRovo: boolean;
}

/** monitor が観測した停止（メモリのみ） */
interface ObservedExit {
  at: number;
  outcome: "resolved" | "rejected";
  exitCode?: number;
  destroyedByRovo: boolean;
}

export class SandboxDO extends DurableObject<Env> implements SandboxPort {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    // DO が restart すると無操作の期限は消える。コンテナが動いていれば、最初のリクエストの前に設定し直す
    if (ctx.container?.running) {
      void ctx.blockConcurrencyWhile(() => this.rearmInactivityTimeout());
    }
  }

  /** 起動の世代。boot ごとに増える。古い boot の結果が新しい状態を上書きしないようにする。 */
  private gen = 0;
  private readyGen = -1;
  private booting?: { gen: number; promise: Promise<boolean> };
  /** すべての操作（exec / ファイル）を 1 つずつ実行するための鎖 */
  private queue: Promise<unknown> = Promise.resolve();
  private failNextReapFlag = false;
  private reapQueue: Promise<unknown> = Promise.resolve();
  /** destroy の監視期限（ms）。destroy() の Promise を待つ前から数える。 */
  private destroyWaitMs = DESTROY_WAIT_MS;
  /** ready を待つ 1 回あたりの期限と、起動中の破棄の待ちの上限（ms）。テストで短くする。 */
  private bootAttemptMs = BOOT_ATTEMPT_MS;
  private bootDestroyMs = BOOT_DESTROY_MS;
  /** 依存関係のキャッシュの ensure を待つ上限（ms）。テストで短くする。 */
  private depsEnsureWaitMs = DEPS_ENSURE_WAIT_MS;
  /** 昇格のスナップショットを待つ上限（ms）。テストで短くする。 */
  private promoteSnapshotMs = PROMOTE_SNAPSHOT_MS;
  /** 「上げなかったのに長くかかった」とみなす実行時間（ms）。テストで短くする。 */
  private slowCommandMs = SLOW_COMMAND_MS;
  /** 設定の警告を 1 回だけ出すための印（永続しない） */
  private warnedScaleConfig = new Set<string>();
  /** 実行中のワーカーのコマンド（origin 付き）の出力バッファ。peekOutput が serial の外から読む（永続しない）。 */
  private activeExec?: { startedAt: number; out: TailBuffer; err: TailBuffer };
  /** キャッシュを作る処理（builder として使われたとき）。同時の依頼は 1 つを共有する。 */
  private depsBuilding?: Promise<DepsBuildResult>;
  /** 今のコンテナの記録と、monitor が最後に観測した停止（診断。永続しない） */
  private life?: ContainerLife;
  private lastExit?: ObservedExit;

  // ---- 永続状態 ----

  private spec(): WorkspaceSpec | undefined {
    return this.ctx.storage.kv.get<WorkspaceSpec>("spec");
  }
  private terminated(): boolean {
    return this.ctx.storage.kv.get<boolean>("terminated") === true;
  }
  private baseline(): string[] | undefined {
    return this.ctx.storage.kv.get<string[]>("baseline");
  }
  /** コンテナのハンドル。vitest 上では ctx.container が無いので、Unit は fake に差し替える。 */
  private maybeContainer(): Container | undefined {
    return this.ctx.container;
  }
  private container(): Container {
    const c = this.maybeContainer();
    if (!c) throw new Error("container binding is not configured");
    return c;
  }

  /** ensureReady 済みで、終端でも期限切れでもないことを確かめて spec を返す。 */
  private requireSpec(): WorkspaceSpec {
    if (this.terminated()) throw new Error("sandbox was terminated");
    const spec = this.spec();
    if (!spec) throw new Error("sandbox is not ready: call ensureReady first");
    if (Date.now() >= spec.deadlineAt) throw new Error("sandbox deadline exceeded");
    return spec;
  }

  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const p = this.queue.then(fn);
    this.queue = p.catch(() => {});
    return p;
  }

  // ---- 監査 ----

  /** 監査イベントを出す（@rovo/audit 経由。test のときだけ DO にも記録する）。taskId は DO の名前。 */
  private audit(event: string, fields: AuditFields = {}): void {
    emitAudit(this.env, this.ctx.storage.kv, event, {
      taskId: this.ctx.id.name,
      caller: "child",
      ...fields,
    });
  }

  /** E2E / Unit 専用: この DO が出した監査イベント（outbound_denied を含む）を発行順に返す。test 以外は例外。 */
  async testAudit(): Promise<unknown[]> {
    return readTestAudit(this.env, this.ctx.storage.kv);
  }

  /** E2E 専用: OutboundGateway（DO ではない）が出した監査イベントを、タスクの SandboxDO に記録する。 */
  testRecordAudit(record: unknown): void {
    if (this.env.ENVIRONMENT !== "test") throw new Error("test only");
    appendTestAudit(this.ctx.storage.kv, record as AuditRecord);
  }

  // ---- 実行時間と起動世代のカウンタ（永続。観測性 11.1 / phase6.md「観測性」）----
  //
  // 定義（Unit で固定する）:
  //  - runtimeMs: コンテナの start から停止（destroy の確認）までの累計。実行中の区間は現在までを足して返す。
  //    DO が退避されて停止を観測できなかったときは、keepalive の alarm が最後に観測した時刻（rt_seen）までを数える。
  //  - restarts: コンテナの作り直し。start の回数から最初の 1 回を引いたもの（止まった起動の破棄 → 再 start も数える）。
  //  - bootRetries: 起動の確認点で止まった試行（BOOT_ATTEMPT_MS 内に ready にならなかった）と、
  //    世代が変わって破棄された（superseded）boot の回数。成功した起動は数えない。
  // メモリ上の gen は DO が退避されると 0 に戻るので、カウンタは ctx.storage.kv に持つ。

  private num(key: string): number {
    return this.ctx.storage.kv.get<number>(key) ?? 0;
  }

  /** 実行区間を開く（コンテナを start した、または動いているのを初めて見た）。開いていれば何もしない。 */
  private openRuntime(now = Date.now()): void {
    const kv = this.ctx.storage.kv;
    if (kv.get<number>("rt_since") !== undefined) return;
    kv.put("rt_since", now);
    kv.put("rt_seen", now);
  }

  /** 実行区間を end で閉じて累計に足す。開いていなければ何もしない。 */
  private closeRuntime(end: number): void {
    const kv = this.ctx.storage.kv;
    const since = kv.get<number>("rt_since");
    if (since === undefined) return;
    kv.put("rt_total", this.num("rt_total") + Math.max(0, end - since));
    kv.delete("rt_since");
    kv.delete("rt_seen");
  }

  /** 開いたままの区間が、コンテナが落ちていたのに閉じられていないなら、最後に観測した時刻で閉じる。 */
  private settleRuntime(): void {
    const kv = this.ctx.storage.kv;
    const since = kv.get<number>("rt_since");
    if (since === undefined) return;
    if (this.maybeContainer()?.running) {
      kv.put("rt_seen", Date.now());
    } else {
      this.closeRuntime(Math.max(since, this.num("rt_seen")));
    }
  }

  /** コンテナを start した記録（restarts の元の回数と、実行区間の開始）。 */
  private recordStart(): void {
    // 前の区間が閉じられていなければ（落ちたのを観測できなかった）、最後に観測した時刻で閉じる
    const since = this.ctx.storage.kv.get<number>("rt_since");
    if (since !== undefined) this.closeRuntime(Math.max(since, this.num("rt_seen")));
    this.ctx.storage.kv.put("starts", this.num("starts") + 1);
    // E2E の診断用: 最後に start した時刻（ready までの時間を出す）
    if (this.env.ENVIRONMENT === "test") this.ctx.storage.kv.put("last_start_at", Date.now());
    this.openRuntime();
  }

  private recordBootRetry(): void {
    this.ctx.storage.kv.put("boot_retries", this.num("boot_retries") + 1);
  }

  /**
   * キャッシュを作ったときの所要時間を、このタスクの Sandbox の時間として数える（少なく数えない）。
   * 作ったコンテナは別のインスタンスなので、rt_total（実行時間の累計）に足す。
   */
  private recordCacheBuild(buildMs: number): void {
    const kv = this.ctx.storage.kv;
    const ms = Math.max(0, Math.floor(buildMs));
    kv.put("cache_build_ms", this.num("cache_build_ms") + ms);
    kv.put("rt_total", this.num("rt_total") + ms);
    kv.put("deps_built", true);
  }

  /**
   * 起動の結果として usage に出す値を残す。順位（disabled < miss < hit < built）が下がる更新はしない。
   * 最初に作った（built）タスクが、コンテナの作り直しで hit になっても built のまま。
   */
  private recordDepsStatus(status: DepsCacheStatus): void {
    const kv = this.ctx.storage.kv;
    const next: DepsCacheStatus =
      status === "hit" && kv.get<boolean>("deps_built") === true ? "built" : status;
    const prev = kv.get<DepsCacheStatus>("deps_cache");
    if (prev === undefined || DEPS_STATUS_RANK[next] >= DEPS_STATUS_RANK[prev]) {
      kv.put("deps_cache", next);
    }
  }

  /** AgentDO が usage イベントに載せる値。読み取りだけで書き込まない。 */
  async metrics(): Promise<SandboxMetrics> {
    const depsCache = this.ctx.storage.kv.get<DepsCacheStatus>("deps_cache");
    const cacheBuildMs = this.num("cache_build_ms");
    const instance = this.ctx.storage.kv.get<SandboxInstance>("instance");
    const promotedTo = this.ctx.storage.kv.get<SandboxInstance>("promoted_to");
    const promotions = this.ctx.storage.kv.get<SandboxPromotionRecord[]>("promotions");
    const promotionReason = this.ctx.storage.kv.get<SandboxPromotionReason>("promotion_reason");
    const failures = this.ctx.storage.kv.get<SandboxPromotionFailure[]>("promotion_failures");
    const scaleStats = this.ctx.storage.kv.get<SandboxScaleStats>("scale_stats");
    const scaleLog = this.ctx.storage.kv.get<SandboxScaleDecision[]>("scale_log");
    const depsMissReason =
      depsCache === "miss"
        ? this.ctx.storage.kv.get<DepsMissReason>("deps_miss_reason")
        : undefined;
    return {
      runtimeMs: this.runtimeTotal(),
      restarts: Math.max(0, this.num("starts") - 1),
      bootRetries: this.num("boot_retries"),
      ...(depsCache !== undefined ? { depsCache } : {}),
      ...(depsMissReason !== undefined ? { depsMissReason } : {}),
      ...(cacheBuildMs > 0 ? { cacheBuildMs } : {}),
      ...(instance !== undefined ? { instance } : {}),
      // 昇格（重いコマンドの初回に大きい Sandbox へ）。昇格した後は promotedTo と、その時点までの時間（費用の按分に使う）
      ...(promotedTo !== undefined
        ? {
            promotedTo,
            promotedAt: this.num("promoted_at"),
            runtimeMsBeforePromotion: this.num("rt_before_promotion"),
          }
        : {}),
      ...(promotionReason !== undefined ? { promotionReason } : {}),
      // 成功した昇格の履歴（trigger つき）
      ...(promotions !== undefined && promotions.length > 0 ? { promotions } : {}),
      // Clef の判断の集計と、判断ごとの記録（直近 50 件）。Clef を呼んだタスクだけ
      ...(scaleStats !== undefined && (scaleStats.decisions > 0 || scaleStats.skippedLight > 0)
        ? { scaleStats }
        : {}),
      ...(scaleLog !== undefined && scaleLog.length > 0 ? { scaleDecisions: scaleLog } : {}),
      // 見送り・失敗の内訳（昇格の試みごとに 1 件。promotionReason は最後の理由だけ）
      ...(failures !== undefined && failures.length > 0 ? { promotionFailures: failures } : {}),
    };
  }

  /** Sandbox を動かした累計の時間（ms）。実行中の区間は現在までを足す。 */
  private runtimeTotal(): number {
    const since = this.ctx.storage.kv.get<number>("rt_since");
    let open = 0;
    if (since !== undefined) {
      const end = this.maybeContainer()?.running
        ? Date.now()
        : Math.max(since, this.num("rt_seen"));
      open = Math.max(0, end - since);
    }
    return this.num("rt_total") + open;
  }

  /** E2E 専用: 失敗した E2E の診断（ready になった時刻、start の回数、restarts / bootRetries など）。test 以外は例外。 */
  async testDiagnostics(): Promise<{
    starts: number;
    restarts: number;
    bootRetries: number;
    runtimeMs: number;
    running: boolean;
    lastStartAt?: number;
    readyAt?: number;
  }> {
    if (this.env.ENVIRONMENT !== "test") throw new Error("test only");
    const m = await this.metrics();
    const kv = this.ctx.storage.kv;
    const lastStartAt = kv.get<number>("last_start_at");
    const readyAt = kv.get<number>("ready_at");
    return {
      starts: this.num("starts"),
      restarts: m.restarts,
      bootRetries: m.bootRetries,
      runtimeMs: m.runtimeMs,
      running: this.maybeContainer()?.running === true,
      ...(lastStartAt !== undefined ? { lastStartAt } : {}),
      ...(readyAt !== undefined ? { readyAt } : {}),
    };
  }

  // ---- SandboxPort ----

  async ensureReady(input: WorkspaceSpec): Promise<void> {
    const spec = validateWorkspaceSpec(input);
    if (this.terminated()) throw new Error("sandbox was terminated");
    const stored = this.spec();
    if (stored) {
      if (
        stored.repository !== spec.repository ||
        stored.baseSha !== spec.baseSha ||
        stored.branch !== spec.branch ||
        stored.initialSha !== spec.initialSha ||
        stored.checkout?.pullNumber !== spec.checkout?.pullNumber ||
        stored.checkout?.sha !== spec.checkout?.sha
      ) {
        throw new Error("conflict: this sandbox is already bound to a different workspace");
      }
      // 期限は延長しない
    } else {
      if (spec.deadlineAt <= Date.now()) throw new Error("sandbox deadline exceeded");
      this.ctx.storage.kv.put("spec", spec);
      this.ctx.storage.kv.put("created_at", Date.now());
    }
    this.requireSpec();
    await this.armAlarm();
    await this.serial(async () => {
      this.requireSpec();
      await this.ensureRunning();
    });
    await this.armAlarm();
  }

  /**
   * 期限を延ばす（AgentDO が、ask_parent で回答待ちの上限まで先に延ばすために呼ぶ。回答のときに正確な値へ戻すのは setDeadline）。
   * 単調増加だけ受け付け（小さい・同じ値は無視）、上限は作成時刻 + 2h + 24h。alarm も新しい期限で張り直す。
   */
  async extendDeadline(deadlineAt: number): Promise<void> {
    const spec = this.checkedDeadline(deadlineAt);
    if (deadlineAt <= spec.deadlineAt) return;
    this.ctx.storage.kv.put("spec", { ...spec, deadlineAt });
    this.audit("sandbox_privileged_op", { op: "extend_deadline" });
    await this.armAlarm();
  }

  /**
   * 期限を正確な値に設定する（AgentDO が、回答のときに質問で延ばした上限から戻すために submit より前に呼ぶ）。
   * 短くもできる。上限は extendDeadline と同じ。現在時刻より前の値は、alarm がすぐ発火して期限切れとして扱われる。
   */
  async setDeadline(deadlineAt: number): Promise<void> {
    const spec = this.checkedDeadline(deadlineAt);
    this.ctx.storage.kv.put("spec", { ...spec, deadlineAt });
    this.audit("sandbox_privileged_op", { op: "set_deadline" });
    await this.armAlarm();
  }

  private checkedDeadline(deadlineAt: number) {
    if (typeof deadlineAt !== "number" || !Number.isFinite(deadlineAt)) {
      throw new Error("invalid deadline");
    }
    if (this.terminated()) throw new Error("sandbox was terminated");
    const spec = this.spec();
    if (!spec) throw new Error("sandbox is not ready: call ensureReady first");
    const created = this.ctx.storage.kv.get<number>("created_at") ?? spec.deadlineAt - MAX_TASK_MS;
    if (deadlineAt > created + MAX_TASK_MS + MAX_INPUT_PAUSE_MS) {
      throw new Error("deadline exceeds the limit");
    }
    return spec;
  }

  // ---- Git の認証トークン（コンテナには入れない。OutboundGateway が判定を通ったリクエストにだけ注入する）----
  // ensureReady より前に届き、push（exec の最中）の間にも読まれるので、直列キューにも requireSpec にも依存させない。

  private credentialAad(): string {
    return `git-credential:${this.ctx.id.name ?? ""}`;
  }

  /** 暗号化して保存する。保存済みより新しい expiresAt のものだけ採用する（冪等）。 */
  async setGitCredential(input: GitCredential): Promise<void> {
    const c = input as Partial<GitCredential> | null;
    if (
      !c ||
      typeof c.token !== "string" ||
      !/^[\x21-\x7e]{1,2048}$/.test(c.token) ||
      typeof c.expiresAt !== "number" ||
      !Number.isFinite(c.expiresAt)
    ) {
      throw new Error("invalid git credential");
    }
    if (this.terminated()) throw new Error("sandbox was terminated");
    const stored = this.ctx.storage.kv.get<{ ct: string; expiresAt: number }>("git_credential");
    if (stored && stored.expiresAt >= c.expiresAt) return;
    const key = await importEncryptionKey(this.env.TOKEN_ENC_KEY ?? "");
    const ct = await encryptString(key, c.token, this.credentialAad());
    // 暗号化の間に terminate されていたら保存しない
    if (this.terminated()) throw new Error("sandbox was terminated");
    const again = this.ctx.storage.kv.get<{ expiresAt: number }>("git_credential");
    if (again && again.expiresAt >= c.expiresAt) return;
    this.ctx.storage.kv.put("git_credential", { ct, expiresAt: c.expiresAt });
  }

  /** OutboundGateway 用。無い・終端・復号できないときは undefined（= 401）。 */
  async readGitCredential(): Promise<GitCredential | undefined> {
    if (this.terminated()) return undefined;
    const stored = this.ctx.storage.kv.get<{ ct: string; expiresAt: number }>("git_credential");
    if (!stored) return undefined;
    try {
      const key = await importEncryptionKey(this.env.TOKEN_ENC_KEY ?? "");
      const token = await decryptString(key, stored.ct, this.credentialAad());
      return { token, expiresAt: stored.expiresAt };
    } catch {
      return undefined;
    }
  }

  /**
   * OutboundGateway 用。いま自動の push の exec が走っているとき（exec の pushPermit）だけ、その ref と newSha を返す。
   * 無い・期限切れ・終端は undefined（= receive-pack は 403）。serial を通さない（exec が鎖の中で待っている間に読まれる）。
   */
  async readPushPermit(): Promise<PushPermit | undefined> {
    if (this.terminated()) return undefined;
    const stored = this.ctx.storage.kv.get<{ ref: string; newSha: string; expiresAt: number }>(
      PUSH_PERMIT_KEY,
    );
    if (!stored || !(stored.expiresAt > Date.now())) return undefined;
    return { ref: stored.ref, newSha: stored.newSha };
  }

  /**
   * 実行中のワーカーのコマンドの途中の出力。serial を通さない（exec が鎖の中で待っている間も返る）ので、ストレージにも触れない。
   * origin の無い内部の exec（git など）は見せない。
   */
  async peekOutput(): Promise<PeekedOutput> {
    const a = this.activeExec;
    if (!a) return { running: false, stdout: "", stderr: "" };
    return { running: true, startedAt: a.startedAt, stdout: a.out.peek(), stderr: a.err.peek() };
  }

  async exec(argv: string[], options: ExecOptions = {}): Promise<ExecResult> {
    if (!Array.isArray(argv) || argv.length === 0 || argv.some((a) => typeof a !== "string")) {
      throw new Error("argv must be a non-empty array of strings");
    }
    const cwd = options.cwd ? resolveWorkspacePath(WORKSPACE, options.cwd) : WORKSPACE;
    // 終端後の exec は例外にしない（workerd は呼び出され側の例外を Uncaught として記録するため、結果型で返す）
    if (this.terminated()) return TERMINATED_RESULT;
    this.requireSpec();
    return this.serial(async () => {
      if (this.terminated()) return TERMINATED_RESULT;
      this.requireSpec();
      await this.runningOrThrowRestarted();
      // ワーカーのコマンドと検証コマンド（origin 付き）の前に、Clef が「今の大きさで足りるか」を判断し、足りなければ大きい Sandbox へ昇格する
      // （fail-soft。判断・昇格に失敗しても、今の大きさでコマンドは動く）。Sandbox 自身の内部の exec（origin なし）は判断しない。
      let pending = false;
      if (options.origin !== undefined) {
        const decided = await this.maybeScale(argv, cwd);
        if (decided === "terminated") return TERMINATED_RESULT;
        pending = decided === "recorded";
      }
      const startedAt = Date.now();
      // 許可証は、この exec の間だけ（serial の中なので同時に 1 つ）。期限は exec の時間切れまで。finally で必ず消す
      const permit = options.pushPermit;
      if (permit !== undefined) {
        if (
          typeof permit.ref !== "string" ||
          !/^refs\/heads\/[^\s]+$/.test(permit.ref) ||
          typeof permit.newSha !== "string" ||
          !/^[0-9a-f]{40}$/.test(permit.newSha)
        ) {
          throw new Error("invalid push permit");
        }
        this.ctx.storage.kv.put(PUSH_PERMIT_KEY, {
          ref: permit.ref,
          newSha: permit.newSha,
          expiresAt: startedAt + (options.timeoutMs ?? DEFAULT_TIMEOUT_MS) + PUSH_PERMIT_GRACE_MS,
        });
      }
      try {
        const result = await this.runExec(argv, { ...options, cwd });
        if (options.origin !== undefined) {
          this.finishCommand(argv, result, Date.now() - startedAt, pending);
        }
        return result;
      } finally {
        if (permit !== undefined) this.ctx.storage.kv.delete(PUSH_PERMIT_KEY);
      }
    });
  }

  // readFile / writeFile は、terminate / 期限切れの後も例外（"sandbox was terminated" など）を投げる。exec のように結果型へそろえない。
  // 理由: (1) 戻り値が文字列 / void で、結果型にすると SandboxPort の契約と全ツール・fake・AgentDO を巻き込む。
  // (2) 呼び出し元はツール（guarded が例外をツールのエラー結果にする）だけで、AgentDO は終端後に呼ばない。
  //     終端の後に呼ばれうるのは中断し損ねた実行中ツール 1 回分程度で、その分の Uncaught ログは許容する。
  // (3) exec を結果型にしたのは、AgentDO の確定処理（patch の取得・検証）が終端の後にも呼ぶため。
  async readFile(path: string): Promise<string> {
    const abs = resolveWorkspacePath(WORKSPACE, path);
    this.requireSpec();
    return this.serial(async () => {
      this.requireSpec();
      await this.runningOrThrowRestarted();
      const real = await this.realPath(abs, true);
      const size = await this.rawExec(["stat", "-c", "%s", "--", real], { timeoutMs: 10_000 });
      if (size.exitCode !== 0) throw new Error(`cannot read ${abs}: ${size.stderr.trim()}`);
      if (Number(size.stdout.trim()) > MAX_FILE_BYTES) throw new Error(`file is too large: ${abs}`);
      const res = await new Files(this.container()).readFile(real);
      return res.text();
    });
  }

  async writeFile(path: string, content: string): Promise<void> {
    const abs = resolveWorkspacePath(WORKSPACE, path);
    if (typeof content !== "string") throw new Error("content must be a string");
    if (new TextEncoder().encode(content).byteLength > MAX_FILE_BYTES) {
      throw new Error("content is too large");
    }
    this.requireSpec();
    await this.serial(async () => {
      this.requireSpec();
      await this.runningOrThrowRestarted();
      const real = await this.realPath(abs, false);
      const mk = await this.rawExec(["mkdir", "-p", "--", posix.dirname(real)], {
        timeoutMs: 10_000,
      });
      if (mk.exitCode !== 0) throw new Error(`cannot create directory: ${mk.stderr.trim()}`);
      // mkdir の後にもう一度確かめる（途中に外を指すリンクが無いこと）
      await this.realPath(abs, false);
      await new Files(this.container()).writeFile(real, content);
    });
  }

  /**
   * 実行中のプロセスをすべて止める（reaper）。止まらなければコンテナごと止め、停止を確かめてから戻る。
   * 再開は可能（次の操作で再起動する）。キューを待たない。
   */
  async stop(): Promise<{ stopped: boolean }> {
    const container = this.maybeContainer();
    if (!container?.running) return { stopped: true };
    const clean = await this.reap();
    if (clean) return { stopped: true };
    await this.destroyAudited("reap_failed");
    return { stopped: !container.running };
  }

  /**
   * 回答待ちの間の中断（予算の延長の承認待ち）。serial の中（実行中の exec が終わってから）で、作業ツリーの状態を読み、
   * スナップショットを取ってコンテナを止める。スナップショットの id と状態は kv に残し、次の起動（boot）が戻す。
   * 取れなかったとき: allowReclone なら止める（戻すときは image から起動して再 clone）。そうでなければ止めずに running を返す。
   */
  async suspend(options: {
    allowReclone: boolean;
  }): Promise<{ mode: "snapshot" | "destroyed" | "running" }> {
    if (this.terminated()) throw new Error("sandbox was terminated");
    return this.serial(async () => {
      this.requireSpec();
      const kv = this.ctx.storage.kv;
      const container = this.container();
      if (!container.running) {
        return {
          mode: kv.get("suspend") !== undefined ? ("snapshot" as const) : ("destroyed" as const),
        };
      }
      const keepOrDrop = async (): Promise<{ mode: "destroyed" | "running" }> => {
        if (!options.allowReclone) return { mode: "running" };
        await this.destroyContainer(this.bootDestroyMs);
        kv.delete("suspend");
        return { mode: "destroyed" };
      };
      if (typeof container.snapshotContainer !== "function") return keepOrDrop();
      const before = await this.workspaceState();
      if (before === undefined) return keepOrDrop();
      const seq = this.num("suspend_seq") + 1;
      kv.put("suspend_seq", seq);
      let snapshotId: string | undefined;
      try {
        const snapshot = await withDeadline(
          container.snapshotContainer({ name: suspendSnapshotName(this.ctx.id.name, seq) }),
          Date.now() + this.promoteSnapshotMs,
        );
        if (snapshot !== "timeout" && typeof snapshot?.id === "string" && snapshot.id !== "") {
          snapshotId = snapshot.id;
        }
      } catch {
        // snapshot_failed として扱う（例外の文面は残さない）
      }
      this.requireSpec();
      if (snapshotId === undefined) return keepOrDrop();
      await this.destroyContainer(this.bootDestroyMs);
      kv.put("suspend", { snapshotId, state: before });
      this.audit("sandbox_privileged_op", { op: "suspend" });
      return { mode: "snapshot" };
    });
  }

  /**
   * 永続的な終端停止（cancel 用）。コンテナを破棄し、以後の ensureReady / exec / ファイル操作を拒否する。
   * 遅れて届いた指示で再起動しないための tombstone。停止の保証は destroy だけで行う。
   * 進行中の boot は無効化し、収束した後にもう一度停止を確かめる。
   */
  async terminate(): Promise<{ stopped: boolean }> {
    this.audit("sandbox_privileged_op", { op: "terminate" });
    this.ctx.storage.kv.put("terminated", true);
    this.ctx.storage.kv.delete("git_credential");
    this.ctx.storage.kv.delete(PUSH_PERMIT_KEY);
    this.invalidateBoot();
    await this.ctx.storage.deleteAlarm();
    let error: unknown;
    for (let i = 0; i < 3; i++) {
      try {
        await this.destroyContainer();
        error = undefined;
      } catch (e) {
        error = e;
      }
      // 進行中の boot が収束するのを待つ（無効化済みなので、これ以上 start はしない）
      const booting = this.booting;
      if (booting) await booting.promise.catch(() => undefined);
      if (!this.maybeContainer()?.running) break;
    }
    if (error && this.maybeContainer()?.running) throw error;
    return { stopped: !this.maybeContainer()?.running };
  }

  /** 進行中の boot を無効化する（世代を進める）。boot は次の確認点で止まる。 */
  private invalidateBoot(): void {
    this.gen += 1;
    this.readyGen = -1;
  }

  /** コンテナを起こさずに状態を返す（E2E と監視用）。 */
  status(): { running: boolean; terminated: boolean; expired: boolean; hasSpec: boolean } {
    const spec = this.spec();
    return {
      running: this.maybeContainer()?.running === true,
      terminated: this.terminated(),
      expired: spec ? Date.now() >= spec.deadlineAt : false,
      hasSpec: spec !== undefined,
    };
  }

  /**
   * E2E 専用: Clef の応答を仕込む（AI.run の代わりに、この応答を順に返し、最後の 1 つは使い回す）。実際の Clef は呼ばない。
   * 判断のあとの手順（スナップショット・昇格・作業ツリーの確認）と state の組み立て（リポジトリの事実の収集）は、本物のコンテナで通す。
   */
  async setClefForTest(responses: unknown[]): Promise<void> {
    if (this.env.ENVIRONMENT !== "test") throw new Error("only available in test");
    this.ctx.storage.kv.put("test_clef", { responses });
  }

  /** E2E 専用: 直近に Clef（の fake）へ渡した state（JSON の文字列）。無ければ undefined */
  async lastClefStateForTest(): Promise<string | undefined> {
    if (this.env.ENVIRONMENT !== "test") throw new Error("only available in test");
    return this.ctx.storage.kv.get<string>("test_clef_state");
  }

  /** E2E 専用: コンテナだけを落とす（DO の状態は残す）。 */
  async destroyForTest(): Promise<void> {
    if (this.env.ENVIRONMENT !== "test") throw new Error("only available in test");
    await this.destroyContainer();
  }

  /**
   * E2E 専用: 作業ブランチだけを持つ空の作業ツリーを、起動済みのコンテナに用意する。
   * 認証なしの実ネットワーク E2E（clone が 401 で失敗する）で、exec に進めるようにするため。冪等。
   */
  async seedWorkspaceForTest(): Promise<void> {
    if (this.env.ENVIRONMENT !== "test") throw new Error("only available in test");
    this.requireSpec();
    await this.serial(async () => {
      const spec = this.requireSpec();
      const script =
        'git -C "$1" rev-parse --verify -q HEAD >/dev/null 2>&1 && exit 0; ' +
        'mkdir -p "$1" && git init -q -b "$2" "$1" && ' +
        'git -C "$1" -c user.name=t -c user.email=t@e commit -q --allow-empty -m seed';
      const r = await this.rawExec(["bash", "-c", script, "rovo-seed", WORKSPACE, spec.branch], {
        timeoutMs: 60_000,
        cwd: "/",
      });
      if (r.exitCode !== 0) throw new Error(`seed failed: ${r.stderr.trim().slice(0, 300)}`);
    });
  }

  /** E2E 専用: 次の reaper を失敗させる。 */
  failNextReapForTest(): void {
    if (this.env.ENVIRONMENT !== "test") throw new Error("only available in test");
    this.failNextReapFlag = true;
  }

  // ---- 期限と keepalive ----

  private async armAlarm(): Promise<void> {
    const spec = this.spec();
    if (!spec || this.terminated()) return;
    await this.ctx.storage.setAlarm(Math.min(Date.now() + KEEPALIVE_MS, spec.deadlineAt));
  }

  /** 1 分ごとの keepalive を兼ねる。期限を超えていたら自分でコンテナを止める（AgentDO へは通知しない）。 */
  override async alarm(): Promise<void> {
    this.settleRuntime();
    const spec = this.spec();
    if (!spec) return;
    if (this.terminated() || Date.now() >= spec.deadlineAt) {
      this.ctx.storage.kv.delete("git_credential");
      this.ctx.storage.kv.delete(PUSH_PERMIT_KEY);
      try {
        await this.destroyContainer();
      } catch {
        await this.ctx.storage.setAlarm(Date.now() + 10_000);
      }
      return;
    }
    if (this.maybeContainer()?.running) await this.armAlarm();
  }

  // ---- 無操作の期限と停止の診断 ----

  /**
   * start の直後に呼ぶ（start したすべての経路）。monitor を始め、無操作の期限を設定し、keepalive の alarm を張る。
   * 期限の設定や alarm の失敗では起動を失敗にしない（警告だけ）。
   */
  private async onContainerStarted(
    container: Container,
    g: number,
    timeoutMs = INACTIVITY_TIMEOUT_MS,
  ): Promise<void> {
    const life: ContainerLife = { startGen: g, destroyedByRovo: false };
    this.life = life;
    this.lastExit = undefined;
    this.watchContainer(container, life);
    try {
      await container.setInactivityTimeout(timeoutMs);
    } catch (e) {
      console.warn(`[sandbox-boot] setInactivityTimeout failed: ${errorText(e)}`);
    }
    try {
      // boot が途中で投げても keepalive の鎖が切れないように、start の直後に張る（armAlarm は spec が無い・terminated なら何もしない）
      await this.armAlarm();
    } catch (e) {
      console.warn(`[sandbox-boot] armAlarm failed: ${errorText(e)}`);
    }
  }

  /** DO の再起動の後、動いているコンテナの無操作の期限を設定し直す。terminated・期限切れのコンテナは延命しない。失敗しても投げない。 */
  private async rearmInactivityTimeout(): Promise<void> {
    try {
      const container = this.maybeContainer();
      if (!container?.running || this.terminated()) return;
      const spec = this.spec();
      if (spec && Date.now() >= spec.deadlineAt) return;
      await container.setInactivityTimeout(INACTIVITY_TIMEOUT_MS);
    } catch (e) {
      console.warn(`[sandbox-boot] setInactivityTimeout failed after restart: ${errorText(e)}`);
    }
  }

  /**
   * コンテナの停止を記録する（console のみ。監査ログには出さない）。monitor の promise は waitUntil に渡す
   * （monitor が DO を最大 15 分 memory に留めることは既知の振る舞い）。
   */
  private watchContainer(container: Container, life: ContainerLife): void {
    if (typeof container.monitor !== "function") return;
    const observe = (outcome: "resolved" | "rejected", error?: unknown) => {
      const text = error === undefined ? undefined : errorText(error);
      const code = text?.match(/exit code:?\s*(\d+)/i)?.[1];
      let exitCode: number | undefined;
      if (outcome === "resolved") exitCode = 0;
      else if (code !== undefined) exitCode = Number(code);
      const exit: ObservedExit = {
        at: Date.now(),
        outcome,
        destroyedByRovo: life.destroyedByRovo,
        ...(exitCode !== undefined ? { exitCode } : {}),
      };
      if (this.life === life) this.lastExit = exit;
      console.warn(
        JSON.stringify({
          event: "sandbox_container_exited",
          at: exit.at,
          outcome,
          exit_code: exitCode,
          error: text,
          gen: this.gen,
          start_gen: life.startGen,
          destroyed_by_rovo: life.destroyedByRovo,
        }),
      );
    };
    try {
      const watched = Promise.resolve(container.monitor()).then(
        () => observe("resolved"),
        (e: unknown) => observe("rejected", e),
      );
      this.ctx.waitUntil(watched);
    } catch (e) {
      console.warn(`[sandbox-boot] monitor failed: ${errorText(e)}`);
    }
  }

  /** 止まっていたので起動した（作業ツリーが作り直された）。直前に alarm が見た時刻と、monitor で停止を観測していたかを残す。 */
  private logRestartDetected(
    g: number,
    before: { rtSeen: number | undefined; lastExit: ObservedExit | undefined },
  ): void {
    console.warn(
      JSON.stringify({
        event: "sandbox_restart_detected",
        at: Date.now(),
        gen: g,
        rt_seen: before.rtSeen ?? null,
        monitor_observed_exit: before.lastExit !== undefined,
        exit_at: before.lastExit?.at ?? null,
        exit_code: before.lastExit?.exitCode ?? null,
        destroyed_by_rovo: before.lastExit?.destroyedByRovo ?? null,
      }),
    );
  }

  // ---- 起動 ----

  /** 起動直後の操作が「再起動した」ことを伝える。以降の操作は、最後に push した状態から再 clone した作業ツリーで動く。 */
  private async runningOrThrowRestarted(): Promise<void> {
    const started = await this.ensureRunning();
    if (started) {
      throw new Error(
        "the sandbox container was restarted and the workspace was re-cloned from the last pushed checkpoint " +
          "(the task branch on the remote); uncommitted changes and commits that were not pushed were lost. Redo your work.",
      );
    }
  }

  /**
   * コンテナが動いていて、傍受・CA・作業ツリーが整っていることを保証する。並行して呼ばれても、
   * 設定の完了前に先へ進まない。戻り値は、この呼び出しがコンテナを起動した（= 作業ツリーが作り直された）か。
   * 起動中・準備完了・世代を分けて持ち、「running が見えない瞬間」に二重に boot しない。
   */
  private ensureRunning(): Promise<boolean> {
    const container = this.container();
    if (this.booting) return this.booting.promise.then(() => false);
    if (this.readyGen === this.gen && container.running) return Promise.resolve(false);
    const g = ++this.gen;
    // 起動の診断（止まっていたので起動した、と判定したときに出す）。boot が値を消す前に控える
    const before = {
      starts: this.num("starts"),
      rtSeen: this.ctx.storage.kv.get<number>("rt_seen"),
      lastExit: this.lastExit,
    };
    const promise = this.boot(g).then((started) => {
      if (this.gen === g) this.readyGen = g;
      if (started && before.starts > 0) this.logRestartDetected(g, before);
      return started;
    });
    const entry = { gen: g, promise };
    this.booting = entry;
    const cleanup = () => {
      if (this.booting === entry) this.booting = undefined;
    };
    promise.then(cleanup, cleanup);
    return promise;
  }

  /** boot の確認点: terminate・期限・起動世代が変わっていたら、それ以上進まない。 */
  private assertBootCurrent(g: number): WorkspaceSpec {
    if (this.gen !== g) {
      this.recordBootRetry();
      this.audit("boot_superseded", { caller: "system", reason: "generation_changed" });
      throw new Error("boot was superseded");
    }
    return this.requireSpec(); // terminated / 期限切れならここで投げる
  }

  private async boot(g: number): Promise<boolean> {
    const container = this.container();
    const spec = this.assertBootCurrent(g);
    // 基準プロセスの記録が無いコンテナは信用できないので、作り直す
    if (container.running && !this.baseline()) await this.destroyContainer(this.bootDestroyMs);
    // destroy を待っている間に terminate・期限・世代が変わりうる。start の直前に必ず確かめ直す
    this.assertBootCurrent(g);
    // 中断（回答待ち）で止めたコンテナは、同じスナップショットから戻す。戻せなければ捨てて、下の image からの起動（再 clone）に進む
    if (!container.running && this.ctx.storage.kv.get("suspend") !== undefined) {
      if (await this.resumeSuspended(g, spec)) return false;
      this.assertBootCurrent(g);
    }
    // 動いているコンテナを初めて見たなら、ここから実行区間を数える（start を見ていない DO の再起動の後など）
    if (container.running) this.openRuntime();
    let started = false;
    const trace: string[] = [];
    let ready = false;
    // 依存関係のキャッシュ（D14）。コンテナを新しく起動するときだけ、スナップショットからの復元を試みる。
    // どこで失敗しても image からの普通の起動に戻る（fail-soft）。復元に失敗した試行は、通常の試行の回数に数えない。
    let deps: DepsPlan = container.running ? { kind: "disabled" } : await this.planDeps(g, spec);
    let restoring: Extract<DepsPlan, { kind: "snapshot" }> | undefined =
      deps.kind === "snapshot" ? deps : undefined;
    let attemptLimit = BOOT_MAX_ATTEMPTS;
    /** 復元を諦めて image に戻す（理由をログに残し、スナップショットを無効にする） */
    const abandonRestore = (reason: DepsMissReason) => {
      if (!restoring) return;
      this.logDepsMiss(reason);
      this.invalidateDeps(restoring);
      deps = { kind: "miss", reason };
      restoring = undefined;
      attemptLimit += 1;
    };
    for (let attempt = 1; attempt <= attemptLimit && !ready; attempt++) {
      const attemptStart = Date.now();
      // この試行の期限（破棄の時間は含めない）
      const until = attemptStart + this.bootAttemptMs;
      if (!container.running) {
        this.ctx.storage.kv.delete("baseline");
        // scheduling_policy=durable_object では wrangler の instance_type は効かず、start() の instance が大きさを決める
        // （指定しないと lite = 1/16 vCPU・256 MiB で、npm ci が遅くメモリ不足で落ちる）。不正な値は既定に戻す（D13）。
        // タスクが明示した大きさ（spec.instance。検証済みで standard-1〜4）があればそれ、無ければ env の既定
        // 昇格した後（重いコマンドの初回に大きくした）は、作り直しも昇格先で起動する（小さく戻さない）
        const explicit = (spec.instance ?? this.promotedTo()) as SandboxInstance | undefined;
        const { instance, ignored } =
          explicit !== undefined
            ? { instance: explicit, ignored: undefined }
            : resolveSandboxInstance(this.env.SANDBOX_INSTANCE);
        if (ignored !== undefined) {
          console.warn(
            `[sandbox-boot] SANDBOX_INSTANCE=${JSON.stringify(ignored.slice(0, 40))} is not supported; using ${instance}`,
          );
        }
        if (restoring) {
          // 復元: image とは同時に渡せない。スナップショットは作ったイメージの版に結び付く
          try {
            container.start({
              containerSnapshot: { id: restoring.snapshotId },
              enableInternet: false,
              instance,
              env: BASE_ENV,
            });
          } catch {
            abandonRestore("restore_failed");
            continue;
          }
        } else {
          container.start({
            image: container.images.workspace,
            enableInternet: false,
            instance,
            env: BASE_ENV,
          });
        }
        this.recordStart();
        await this.onContainerStarted(container, g);
        // 最初に start() に渡した大きさ（usage.sandbox.instance として gateway へ。単価の計算に使う）。昇格した後の作り直しでは上書きしない
        if (this.promotedTo() === undefined) this.ctx.storage.kv.put("instance", instance);
        started = true;
      }
      // DO だけが再起動してコンテナが生きている場合も、傍受は登録し直す（同じ宛先の再登録はハンドラを置き換える）。
      // リポジトリは永続化した spec から導く（未設定のまま登録することはない）。
      const props: OutboundGatewayProps = {
        repo: parseRepository(spec.repository),
        task: spec.branch,
        // トークンの読み出しと push 先の ref はこの値で決める（DO の名前 = task id）
        taskId: this.ctx.id.name ?? "",
      };
      const gateway = this.ctx.exports.OutboundGateway({ props });
      let stage = "intercept";
      let probes = 0;
      let lastError = "";
      const stageEnds: string[] = [];
      const lap = (name: string, from: number) => stageEnds.push(`${name}=${Date.now() - from}ms`);
      const t0 = Date.now();
      // 傍受の登録も止まりうるので、ready の待ちと同じ期限の中で数える
      const intercepted = await this.raceUntil(
        g,
        until,
        Promise.all([
          container.interceptOutboundHttps("*", gateway),
          container.interceptAllOutboundHttp(gateway),
        ]),
      );
      lap("intercept", t0);
      this.assertBootCurrent(g);
      if (intercepted.timedOut) {
        stage = "intercept";
      } else {
        stage = "probe";
        // 起動直後は exec が失敗しうるので、応答するまで待つ。exec が返らないこと自体が「起動が止まった」の典型なので、
        // 呼び出しを待ち続けず、期限と terminate・世代の確認を一定間隔で挟む。
        const t1 = Date.now();
        for (;;) {
          probes += 1;
          const probe = await this.raceUntil(
            g,
            until,
            (async () => {
              const p = await container.exec(["true"]);
              return (await p.exitCode) === 0;
            })().catch((e: unknown) => {
              lastError = e instanceof Error ? e.message.slice(0, 120) : "error";
              return false;
            }),
          );
          this.assertBootCurrent(g);
          if (!probe.timedOut && probe.value === true) {
            ready = true;
            break;
          }
          if (probe.timedOut || Date.now() >= until) break;
          await sleep(BOOT_POLL_MS);
          this.assertBootCurrent(g);
          if (Date.now() >= until) break;
        }
        lap("probe", t1);
      }
      trace.push(
        `#${attempt} ${ready ? "ready" : `stalled-at-${stage}`}${restoring ? " snapshot" : ""} ${stageEnds.join(" ")} probes=${probes}${lastError ? ` last="${lastError}"` : ""}`,
      );
      if (ready && restoring) {
        // 復元したコンテナで、HTTPS 傍受の CA 証明書が読めること（無ければ git / npm が失敗する）。無ければ image から起動し直す
        const cert = await this.rawExec(["test", "-r", CA_CERT], { timeoutMs: 10_000, cwd: "/" });
        this.assertBootCurrent(g);
        if (cert.exitCode !== 0) {
          abandonRestore("cert_missing");
          ready = false;
          await this.destroyContainer(this.bootDestroyMs);
          this.assertBootCurrent(g);
          continue;
        }
      }
      if (ready) break;
      // 復元したコンテナが ready にならなかった: スナップショットが原因かもしれないので、image に戻す
      abandonRestore("restore_failed");
      this.recordBootRetry();
      // 起動が止まった: 破棄して停止を確かめ、最初からやり直す。破棄の時間は待ちの期限に数えない
      await this.destroyContainer(this.bootDestroyMs);
      this.assertBootCurrent(g);
    }
    if (trace.length > 0) console.warn(`[sandbox-boot] ${trace.join(" | ")}`);
    if (!ready) {
      // 失敗は従来どおりのメッセージ。E2E のときだけ、段階ごとの所要時間を診断ログに残すために添える
      const detail = this.env.ENVIRONMENT === "test" ? ` (${trace.join(" | ")})` : "";
      throw new Error(`container did not become ready${detail}`);
    }
    this.assertBootCurrent(g);
    if (this.env.ENVIRONMENT === "test") this.ctx.storage.kv.put("ready_at", Date.now());
    if (started) {
      // 信頼できる状態（ユーザーのコードを動かす前）で、残してよいプロセスを記録する
      const list = await this.rawExec(["bash", "-c", PROCESS_SCRIPT, "rovo-baseline", "list"], {
        timeoutMs: REAPER_TIMEOUT_MS,
      });
      if (list.exitCode !== 0) throw new Error("could not record baseline processes");
      this.assertBootCurrent(g);
      this.ctx.storage.kv.put("baseline", list.stdout.split("\n").filter(Boolean));
    }
    await this.prepareWorkspace(spec);
    this.assertBootCurrent(g);
    this.recordDepsStatus(await this.finishDeps(deps, restoring));
    // 起動をタスクの期限の先までブロックしない(足りなければ諦める。corepack が従来どおり自分で取る)
    await this.preparePackageManager(spec.deadlineAt);
    await this.armAlarm();
    return started;
  }

  // ---- 昇格（小さく始めて、コマンドの前に Clef が上げると判断したら大きい Sandbox へ。docs/deploy.md の 11）----
  //
  // 判断は Clef（Workers AI の決定モデル。sandbox-scale-decision.ts）だけが行う。ワーカーのコマンド（bash ツール）と検証コマンド
  // （exec の options.origin）の前に、コマンド・cwd・今の大きさ・リポジトリの事実・直近のコマンドを渡して「今の大きさで足りるか」を聞き、
  // 足りなければ上限（env SANDBOX_MAX_INSTANCE）までの大きさへ上げる。コマンドの種類を表で判定する規則は持たない。
  // 上げる方向だけで、下げない。何回でも上げられる（2 → 3 → 4）。手順は runPromotion。
  //
  // 動いているコンテナの大きさは変えられない。コマンドの前に、今のコンテナのスナップショットを取り、止めて、
  // 同じスナップショットから大きい大きさで起動し直す（スナップショットはイメージの版に結び付き、大きさには結び付かない。
  // node_modules のネイティブのバイナリも動く）。作業ツリー（HEAD と未 commit の変更）がそのまま残っていることを確かめてから、
  // 元のコマンドを実行する。一度上げたら戻さない（作り直しも最終の大きさで起動する）。
  //
  // fail-soft（コマンドは必ず動く。理由は固定コードで promotion_reason に残し、ログにも出す）:
  //  - Clef の失敗（例外・時間切れ・想定外の応答。数回再試行する）→ 今の大きさのまま実行する。判断の記録に failed を残す
  //  - スナップショットが使えない・失敗 → 昇格せず小さいまま続ける（snapshot_unsupported / snapshot_failed / state_unreadable）
  //  - 昇格先の起動・確認に失敗 → 同じスナップショットで元の大きさに起動し直す。作業ツリーは失わない（start_failed / cert_missing / workspace_mismatch）
  //  - それも失敗 → image からの起動（作業ツリーの作り直し）に乗せる。呼び出し側へは「再起動した」例外（fallback_failed）
  // task_start で大きさを明示したタスク・設定で無効・今の大きさがすでに上限なら Clef を呼ばない。

  private promotedTo(): SandboxInstance | undefined {
    const v = this.ctx.storage.kv.get<string>("promoted_to");
    return v !== undefined && Object.hasOwn(SANDBOX_INSTANCES, v)
      ? (v as SandboxInstance)
      : undefined;
  }

  /** 今の大きさ（昇格していれば最終の大きさ。していなければ最初に起動した大きさ） */
  private currentInstance(): SandboxInstance {
    return this.promotedTo() ?? this.startedInstance();
  }

  /** 最初に起動した大きさ（起動の記録が無ければ env の既定） */
  private startedInstance(): SandboxInstance {
    const v = this.ctx.storage.kv.get<string>("instance");
    if (v !== undefined && Object.hasOwn(SANDBOX_INSTANCES, v)) return v as SandboxInstance;
    return resolveSandboxInstance(this.env.SANDBOX_INSTANCE).instance;
  }

  /** 昇格の理由を固定コードで残す（usage.sandbox_promotion_reason と、ログの sandbox_promotion_skipped / _failed） */
  private recordPromotionReason(
    reason: SandboxPromotionReason,
    kind: "skipped" | "failed",
    trigger: SandboxPromotionTrigger,
  ): void {
    this.ctx.storage.kv.put("promotion_reason", reason);
    // 内訳（usage.sandbox_promotion_failures）。試みごとに 1 件、最大 MAX_PROMOTION_FAILURES 件（超えた分は捨てる）
    const failures = this.ctx.storage.kv.get<SandboxPromotionFailure[]>("promotion_failures") ?? [];
    if (failures.length < MAX_PROMOTION_FAILURES) {
      this.ctx.storage.kv.put("promotion_failures", [...failures, { trigger, reason }]);
    }
    console.warn(`[sandbox-promote] sandbox_promotion_${kind}: ${reason}`);
  }

  /** 作業ツリーの状態の指紋（HEAD・追跡ファイルの差分・追跡されていないファイルのハッシュ）。読めなければ undefined */
  private async workspaceState(): Promise<string | undefined> {
    const r = await this.rawExec(
      ["bash", "-c", PROMOTE_STATE_SCRIPT, "rovo-promote-state", WORKSPACE],
      { timeoutMs: PROMOTE_STATE_TIMEOUT_MS, cwd: "/" },
    );
    return r.exitCode === 0 && r.stdout.trim() !== "" ? r.stdout : undefined;
  }

  /**
   * コマンドの前に、Clef が上げると判断したら昇格する。exec の serial の中（コンテナが動いている状態）で呼ぶ。
   * 戻り値: "recorded" = 判断して記録した（コマンドの実行後に所要時間と終了コードを足す）/ "none" = 判断しなかった / "terminated" = 終端になった。
   * Clef の失敗・昇格の失敗では投げない。投げるのは、元の大きさでも起動し直せずに image から起動し直したとき（「再起動した」）と、期限切れだけ。
   */
  private async maybeScale(
    argv: string[],
    cwd: string,
  ): Promise<"recorded" | "none" | "terminated"> {
    const kv = this.ctx.storage.kv;
    const spec = this.requireSpec();
    const max = resolveMaxSandboxInstance(
      (this.env as unknown as { SANDBOX_MAX_INSTANCE?: string }).SANDBOX_MAX_INSTANCE,
    );
    if (max.ignored !== undefined) {
      this.warnOnce(
        "max",
        `[sandbox-promote] SANDBOX_MAX_INSTANCE=${JSON.stringify(max.ignored.slice(0, 40))} is not supported; scaling up is disabled`,
      );
    }
    // 設定で無効: 何も記録しない（理由も残さない）
    if (max.instance === null) return "none";
    // 明示した大きさ（task_start の sandbox_instance）は、そのタスクの間は固定。Clef は呼ばない。理由は 1 回だけ残す
    if (spec.instance !== undefined) {
      if (kv.get<boolean>("scale_fixed_noted") !== true) {
        kv.put("scale_fixed_noted", true);
        this.recordPromotionReason("fixed_instance", "skipped", "clef");
      }
      return "none";
    }
    const current = this.currentInstance();
    // 今の大きさがすでに上限なら、聞いても上げられないので呼ばない
    if (SANDBOX_INSTANCES[current].vcpu >= SANDBOX_INSTANCES[max.instance].vcpu) return "none";
    // 明らかに軽いコマンドは Clef を呼ばずに今の大きさのまま実行する（判断の記録は増やさず、省いた回数だけ数える）
    if (isLightCommand(argv)) {
      const prev = kv.get<SandboxScaleStats>("scale_stats");
      kv.put("scale_stats", {
        decisions: prev?.decisions ?? 0,
        raised: prev?.raised ?? 0,
        clefFailures: prev?.clefFailures ?? 0,
        slowNotRaised: prev?.slowNotRaised ?? 0,
        skippedLight: (prev?.skippedLight ?? 0) + 1,
      });
      return "none";
    }
    const gatewayId = (this.env as unknown as { AI_GATEWAY_ID?: string }).AI_GATEWAY_ID ?? "";
    const ai = this.scaleAi(gatewayId);
    if (ai === undefined) {
      // Clef を呼べない（AI Gateway の ID が空・AI バインディングが無い）。今の大きさのまま実行する
      this.warnOnce(
        "gateway",
        "[sandbox-promote] AI_GATEWAY_ID is empty or the AI binding is missing; scaling up by Clef is disabled",
      );
      return "none";
    }
    const thresholds = resolveClefThresholds(
      (this.env as unknown as { SANDBOX_CLEF_THRESHOLDS?: string }).SANDBOX_CLEF_THRESHOLDS,
    );
    if (thresholds.ignored !== undefined) {
      this.warnOnce(
        "thresholds",
        `[sandbox-promote] SANDBOX_CLEF_THRESHOLDS=${JSON.stringify(thresholds.ignored.slice(0, 80))} is not supported; using the defaults`,
      );
    }
    const facts = await this.scaleFacts(cwd);
    if (this.terminated()) return "terminated";
    const state = buildDecisionState({
      argv,
      cwd,
      current,
      max: max.instance,
      facts,
      recent: kv.get<RecentCommand[]>("recent_cmds") ?? [],
    });
    const decision = await decideSandboxSize(
      {
        ai: ai.ai,
        gatewayId: ai.gatewayId,
        // userId は SandboxDO に無い（WorkspaceSpec に入れない）ので、caller と taskId だけ
        metadata: { caller: "sandbox_scale", taskId: this.ctx.id.name ?? "" },
        thresholds: thresholds.thresholds,
      },
      { state, current, max: max.instance },
    );
    // Clef を待つ間に terminate / 期限切れになっていないか
    if (this.terminated()) return "terminated";
    this.requireSpec();
    const base = {
      at: Date.now(),
      from: current,
      clefMs: Math.round(decision.ms),
      cmd: scaleCmd(argv),
    };
    if (!decision.ok) {
      // Clef の失敗。例外の文面は残さず、固定のコードだけ。今の大きさのまま実行する
      console.warn(`[sandbox-promote] sandbox_scale_decision_failed: ${decision.reason}`);
      this.recordScaleDecision({ ...base, to: null, failed: true });
      return "recorded";
    }
    const detail: Partial<SandboxScaleDecision> = {
      ...(decision.probs !== undefined
        ? {
            heavy: round2(decision.probs.heavy),
            fast4: round2(decision.probs.fast4),
            ...(decision.probs.choice !== undefined
              ? { choice: decision.probs.choice.map(round2) }
              : {}),
          }
        : {}),
      model: decision.model,
    };
    let to: SandboxInstance | null = null;
    if (decision.target !== null) {
      let r: "done" | "skipped" | "terminated";
      try {
        r = await this.runPromotion(decision.target, "clef");
      } catch (e) {
        // 元の大きさでも起動し直せず「再起動した」例外になった。判断は上げられなかったものとして記録してから伝える
        this.recordScaleDecision({ ...base, ...detail, to: null });
        throw e;
      }
      if (r === "terminated") return "terminated";
      if (r === "done") to = decision.target;
    }
    this.recordScaleDecision({ ...base, ...detail, to });
    return "recorded";
  }

  /** Clef を呼ぶ AI。ENVIRONMENT=test のときだけ、E2E が仕込んだ応答（kv の test_clef）を使う。呼べなければ undefined */
  private scaleAi(gatewayId: string): { ai: Ai; gatewayId: string } | undefined {
    if (this.env.ENVIRONMENT === "test") {
      const fake = this.ctx.storage.kv.get<{ responses: unknown[] }>("test_clef");
      if (fake !== undefined && fake.responses.length > 0) {
        const ai = {
          run: async (_model: string, input: { state?: unknown }) => {
            // Clef に渡した state（リポジトリの事実の収集を含む）を E2E が確かめられるように残す
            this.ctx.storage.kv.put("test_clef_state", String(input?.state ?? ""));
            // 最後の 1 つは使い回す
            const stored = this.ctx.storage.kv.get<{ responses: unknown[] }>("test_clef") ?? fake;
            const next =
              stored.responses.length > 1 ? stored.responses.shift() : stored.responses[0];
            this.ctx.storage.kv.put("test_clef", stored);
            return next;
          },
        } as unknown as Ai;
        return { ai, gatewayId: "test" };
      }
    }
    const ai = (this.env as unknown as { AI?: Ai }).AI;
    return gatewayId !== "" && ai !== undefined ? { ai, gatewayId } : undefined;
  }

  private warnOnce(key: string, message: string): void {
    if (this.warnedScaleConfig.has(key)) return;
    this.warnedScaleConfig.add(key);
    console.warn(message);
  }

  /**
   * コマンドの cwd のリポジトリの事実（設定ファイルの生のテキスト）。コンテナ内のスクリプトで集め（container-scripts.ts の
   * SCALE_FACTS_SCRIPT）、cwd ごとに最大 3 つ、10 分だけ storage に覚える。集められなかったら空で、覚えない（次回また試す）。
   * 事実の収集だけで、判断はしない。リポジトリの中身は非信頼のデータで、Clef には state にだけ入れる（質問には混ぜない）。
   */
  private async scaleFacts(cwd: string): Promise<string> {
    const kv = this.ctx.storage.kv;
    const now = Date.now();
    const entries = kv.get<{ cwd: string; at: number; text: string }[]>("scale_facts") ?? [];
    const hit = entries.find((e) => e.cwd === cwd && now - e.at < SCALE_FACTS_TTL_MS);
    if (hit) return hit.text;
    const r = await this.rawExec(
      ["node", "-e", SCALE_FACTS_SCRIPT, cwd, String(SCALE_FACTS_MAX_CHARS)],
      { timeoutMs: SCALE_FACTS_TIMEOUT_MS, cwd: "/" },
    );
    if (r.exitCode !== 0) return "";
    const text = r.stdout.slice(0, SCALE_FACTS_MAX_CHARS);
    kv.put(
      "scale_facts",
      [...entries.filter((e) => e.cwd !== cwd), { cwd, at: now, text }].slice(-SCALE_FACTS_KEEP),
    );
    return text;
  }

  /** 判断を記録に足す（最大 MAX_SCALE_DECISIONS 件。超えたら古い方から捨てる）。集計は捨てずに数える */
  private recordScaleDecision(d: SandboxScaleDecision): void {
    const kv = this.ctx.storage.kv;
    const log = [...(kv.get<SandboxScaleDecision[]>("scale_log") ?? []), d];
    kv.put("scale_log", log.slice(-MAX_SCALE_DECISIONS));
    const prev = kv.get<SandboxScaleStats>("scale_stats");
    kv.put("scale_stats", {
      decisions: (prev?.decisions ?? 0) + 1,
      raised: (prev?.raised ?? 0) + (d.to !== null ? 1 : 0),
      clefFailures: (prev?.clefFailures ?? 0) + (d.failed === true ? 1 : 0),
      slowNotRaised: prev?.slowNotRaised ?? 0,
      skippedLight: prev?.skippedLight ?? 0,
    });
  }

  /**
   * ワーカーのコマンド・検証コマンドの実行後。直近のコマンド（次の判断の state）に足し、直前の判断の記録に実行時間と終了コードを足す。
   * 上げなかったのに（Clef が失敗したときは数えない）長くかかったコマンドは、集計に数える（Clef の見落としの振り返り用）。
   */
  private finishCommand(argv: string[], result: ExecResult, ms: number, pending: boolean): void {
    const kv = this.ctx.storage.kv;
    const recent = kv.get<RecentCommand[]>("recent_cmds") ?? [];
    kv.put(
      "recent_cmds",
      [
        ...recent,
        {
          command: maskSecrets(argv.join(" ")).slice(0, 200),
          seconds: Math.round(ms / 100) / 10,
          exitCode: result.exitCode,
        },
      ].slice(-RECENT_COMMANDS_KEEP),
    );
    if (!pending) return;
    const log = kv.get<SandboxScaleDecision[]>("scale_log");
    const last = log?.at(-1);
    if (!log || !last) return;
    last.cmdMs = ms;
    last.exitCode = result.exitCode;
    kv.put("scale_log", log);
    if (last.to === null && last.failed !== true && ms > this.slowCommandMs) {
      const stats = kv.get<SandboxScaleStats>("scale_stats");
      if (stats) kv.put("scale_stats", { ...stats, slowNotRaised: stats.slowNotRaised + 1 });
    }
  }

  /**
   * target へ昇格する本体。呼び出し側が、設定・固定・今の大きさとの比較を済ませている。
   * 昇格の失敗では投げない（理由は promotion_reason と promotion_failures）。
   */
  private async runPromotion(
    target: SandboxInstance,
    trigger: SandboxPromotionTrigger,
  ): Promise<"done" | "skipped" | "terminated"> {
    const spec = this.requireSpec();
    const current = this.currentInstance();
    const skip = (reason: SandboxPromotionReason) => {
      this.recordPromotionReason(reason, "skipped", trigger);
      return "skipped" as const;
    };
    const container = this.container();
    // スナップショットに対応しないランタイム（ローカルの wrangler dev など）。コンテナには触らない
    if (typeof container.snapshotContainer !== "function") return skip("snapshot_unsupported");
    const before = await this.workspaceState();
    if (this.terminated()) return "terminated";
    if (before === undefined) return skip("state_unreadable");
    const g = ++this.gen;
    this.readyGen = -1;
    try {
      return await this.promote(g, target, current, before, spec, trigger);
    } catch (e) {
      if (this.terminated()) {
        await this.destroyContainer(this.bootDestroyMs).catch(() => undefined);
        return "terminated";
      }
      throw e;
    }
  }

  private async promote(
    g: number,
    target: SandboxInstance,
    current: SandboxInstance,
    before: string,
    spec: WorkspaceSpec,
    trigger: SandboxPromotionTrigger,
  ): Promise<"done" | "skipped"> {
    const container = this.container();
    const kv = this.ctx.storage.kv;
    /** terminate・期限切れ・世代の変化なら投げる（昇格をそれ以上進めない） */
    const alive = () => {
      if (this.gen !== g) throw new Error("promotion was superseded");
      this.requireSpec();
    };

    // (a) 今のコンテナのスナップショット。失敗しても、コンテナは触っていないので小さいまま続ける
    let snapshotId: string | undefined;
    // 何回目の昇格か（スナップショットの名前に入れる。失敗した試みも数える）
    const seq = this.num("promote_seq") + 1;
    kv.put("promote_seq", seq);
    try {
      const snapshot = await withDeadline(
        container.snapshotContainer?.({ name: promoteSnapshotName(this.ctx.id.name, seq) }) ??
          Promise.reject(new Error("snapshot is not supported")),
        Date.now() + this.promoteSnapshotMs,
      );
      if (snapshot !== "timeout" && typeof snapshot?.id === "string" && snapshot.id !== "") {
        snapshotId = snapshot.id;
      }
    } catch {
      // snapshot_failed として扱う（例外の文面は残さない）
    }
    alive();
    if (snapshotId === undefined) {
      this.recordPromotionReason("snapshot_failed", "skipped", trigger);
      if (container.running) this.readyGen = g;
      else await this.runningOrThrowRestarted();
      return "skipped";
    }

    // (b) 止める。止まったことを確かめる（止まらなければ、起動し直しに乗せる）
    try {
      await this.destroyContainer(this.bootDestroyMs);
    } catch {
      alive();
      return this.promotionFallbackFailed(trigger);
    }
    alive();
    const ranMs = this.num("rt_total");

    // (c)(d)(e) 同じスナップショットから起動し、確認する。成功なら undefined、失敗なら理由
    const startFromSnapshot = async (
      instance: SandboxInstance,
    ): Promise<SandboxPromotionReason | undefined> => {
      const fail = async (reason: SandboxPromotionReason) => {
        await this.destroyContainer(this.bootDestroyMs).catch(() => undefined);
        return reason;
      };
      alive();
      try {
        container.start({
          containerSnapshot: { id: snapshotId as string },
          enableInternet: false,
          instance,
          env: BASE_ENV,
        });
      } catch {
        return "start_failed";
      }
      this.openRuntime();
      await this.onContainerStarted(container, g);
      try {
        if (!(await this.waitContainerReady(g, spec))) return await fail("start_failed");
        // HTTPS 傍受の CA 証明書が読めること（無ければ git / npm が失敗する）
        const cert = await this.rawExec(["test", "-r", CA_CERT], { timeoutMs: 10_000, cwd: "/" });
        alive();
        if (cert.exitCode !== 0) return await fail("cert_missing");
        // 作業ツリー（HEAD と未 commit の変更）がそのまま残っていること
        const after = await this.workspaceState();
        alive();
        if (after !== before) return await fail("workspace_mismatch");
        // 信頼できる状態（ユーザーのコードを動かす前）で、残してよいプロセスを記録し直す
        const list = await this.rawExec(["bash", "-c", PROCESS_SCRIPT, "rovo-baseline", "list"], {
          timeoutMs: REAPER_TIMEOUT_MS,
        });
        alive();
        if (list.exitCode !== 0) return await fail("start_failed");
        kv.put("baseline", list.stdout.split("\n").filter(Boolean));
        return undefined;
      } catch (e) {
        // terminate・期限切れ・世代の変化はそのまま伝える。それ以外（傍受の登録の失敗など）は起動の失敗
        if (this.gen !== g || this.terminated()) throw e;
        return await fail("start_failed");
      }
    };

    const failure = await startFromSnapshot(target);
    if (failure === undefined) {
      const at = Date.now();
      kv.put("promoted_to", target);
      // 最初の昇格の時刻とそれまでの時間（usage.sandbox_promoted_at / sandbox_runtime_ms_before_promotion）。2 回目以降は promotions だけに足す
      if (kv.get<number>("promoted_at") === undefined) {
        kv.put("promoted_at", at);
        kv.put("rt_before_promotion", ranMs);
      }
      const record: SandboxPromotionRecord = {
        to: target,
        at,
        trigger,
        runtimeMsBefore: ranMs,
      };
      kv.put("promotions", [...(kv.get<SandboxPromotionRecord[]>("promotions") ?? []), record]);
      this.readyGen = g;
      await this.armAlarm();
      console.log(`[sandbox-promote] sandbox_promoted: ${current} -> ${target} (${trigger})`);
      return "done";
    }
    // 昇格先が使えない: 同じスナップショットで元の大きさに起動し直す（作業ツリーを失わない）
    this.recordPromotionReason(failure, "failed", trigger);
    const back = await startFromSnapshot(current);
    if (back === undefined) {
      this.readyGen = g;
      await this.armAlarm();
      return "skipped";
    }
    return this.promotionFallbackFailed(trigger);
  }

  /** 元の大きさでも起動し直せなかった: image からの起動（作業ツリーの作り直し）に乗せる。「再起動した」例外になる */
  private async promotionFallbackFailed(trigger: SandboxPromotionTrigger): Promise<"skipped"> {
    this.recordPromotionReason("fallback_failed", "failed", trigger);
    await this.destroyContainer(this.bootDestroyMs).catch(() => undefined);
    await this.runningOrThrowRestarted();
    return "skipped";
  }

  /**
   * 中断したコンテナを、スナップショットから戻す。起動・CA 証明書・作業ツリーの状態（中断前と同じ）を確かめ、成功なら true。
   * どこで失敗しても false（スナップショットは捨てる。呼び出し側が image からの起動に進む）。terminate・世代の変化は投げる。
   */
  private async resumeSuspended(g: number, spec: WorkspaceSpec): Promise<boolean> {
    const container = this.container();
    const kv = this.ctx.storage.kv;
    const saved = kv.get<{ snapshotId: string; state: string }>("suspend");
    kv.delete("suspend");
    if (saved === undefined) return false;
    const fail = async (): Promise<false> => {
      await this.destroyContainer(this.bootDestroyMs).catch(() => undefined);
      return false;
    };
    try {
      container.start({
        containerSnapshot: { id: saved.snapshotId },
        enableInternet: false,
        instance: this.currentInstance(),
        env: BASE_ENV,
      });
    } catch {
      return false;
    }
    this.openRuntime();
    await this.onContainerStarted(container, g);
    try {
      if (!(await this.waitContainerReady(g, spec))) return await fail();
      const cert = await this.rawExec(["test", "-r", CA_CERT], { timeoutMs: 10_000, cwd: "/" });
      this.assertBootCurrent(g);
      if (cert.exitCode !== 0) return await fail();
      const after = await this.workspaceState();
      this.assertBootCurrent(g);
      if (after !== saved.state) return await fail();
      const list = await this.rawExec(["bash", "-c", PROCESS_SCRIPT, "rovo-baseline", "list"], {
        timeoutMs: REAPER_TIMEOUT_MS,
      });
      this.assertBootCurrent(g);
      if (list.exitCode !== 0) return await fail();
      kv.put("baseline", list.stdout.split("\n").filter(Boolean));
      await this.armAlarm();
      return true;
    } catch (e) {
      if (this.gen !== g || this.terminated()) throw e;
      return await fail();
    }
  }

  /** 起動したコンテナの傍受を登録し、exec が応答するまで待つ（boot と同じ。期限は 1 回の起動の待ち）。応答すれば true */
  private async waitContainerReady(g: number, spec: WorkspaceSpec): Promise<boolean> {
    const container = this.container();
    const until = Date.now() + this.bootAttemptMs;
    const props: OutboundGatewayProps = {
      repo: parseRepository(spec.repository),
      task: spec.branch,
      taskId: this.ctx.id.name ?? "",
    };
    const gateway = this.ctx.exports.OutboundGateway({ props });
    const intercepted = await this.raceUntil(
      g,
      until,
      Promise.all([
        container.interceptOutboundHttps("*", gateway),
        container.interceptAllOutboundHttp(gateway),
      ]),
    );
    this.assertBootCurrent(g);
    if (intercepted.timedOut) return false;
    for (;;) {
      const probe = await this.raceUntil(
        g,
        until,
        (async () => {
          const p = await container.exec(["true"]);
          return (await p.exitCode) === 0;
        })().catch(() => false),
      );
      this.assertBootCurrent(g);
      if (!probe.timedOut && probe.value === true) return true;
      if (probe.timedOut || Date.now() >= until) return false;
      await sleep(BOOT_POLL_MS);
      this.assertBootCurrent(g);
      if (Date.now() >= until) return false;
    }
  }

  // ---- 依存関係のキャッシュ（D14。docs/specs/design.md 15.8）----

  /** キャッシュを使うか。DEPS_CACHE_ENABLED が "false" / "0" / "off" のときだけ無効（既定は有効）。 */
  private depsCacheEnabled(): boolean {
    const v = (this.env as unknown as { DEPS_CACHE_ENABLED?: unknown }).DEPS_CACHE_ENABLED;
    if (typeof v !== "string") return true;
    return !["false", "0", "off"].includes(v.trim().toLowerCase());
  }

  /** 鍵ごとの DepsCacheDO。テストで差し替える。 */
  private depsCacheStub(key: string): {
    ensure(req: DepsEnsureRequest): Promise<DepsEnsureResult>;
    invalidate(snapshotId: string): Promise<void>;
  } {
    return this.env.DEPS_CACHE_DO.getByName(key) as unknown as {
      ensure(req: DepsEnsureRequest): Promise<DepsEnsureResult>;
      invalidate(snapshotId: string): Promise<void>;
    };
  }

  /** キャッシュを使えなかった理由を固定コードでログに残す（入力や例外の文面は出さない）。 */
  private logDepsMiss(reason: DepsMissReason): void {
    // usage にも出すため、最後の理由を覚える（metrics は deps_cache が miss のときだけ載せる）
    this.ctx.storage.kv.put("deps_miss_reason", reason);
    console.warn(`[sandbox-boot] deps_cache_miss: ${reason}`);
  }

  /** 復元に失敗したスナップショットを DepsCacheDO に知らせる（待ちの後に作り直される）。失敗は握りつぶす。 */
  private invalidateDeps(plan: { key: string; snapshotId: string }): void {
    void Promise.resolve()
      .then(() => this.depsCacheStub(plan.key).invalidate(plan.snapshotId))
      .catch(() => undefined);
  }

  /**
   * 起動の前に、依存関係のスナップショットを用意する（無ければ DepsCacheDO が作る。最初のタスクは作るのを待つ）。
   * 例外は投げない（terminate・期限・世代の変化による boot の中断だけは、そのまま伝える）。
   */
  private async planDeps(g: number, spec: WorkspaceSpec): Promise<DepsPlan> {
    if (!this.depsCacheEnabled() || spec.deps === undefined || spec.deps === null) {
      return { kind: "disabled" };
    }
    const deps = parseDepsSpec(spec.deps);
    if (!deps) return this.depsMiss("invalid_deps");
    let key: string;
    try {
      key = await depsCacheKey(deps, String(this.container().images?.workspace ?? ""));
    } catch {
      return this.depsMiss("ensure_failed");
    }
    const request: DepsEnsureRequest = {
      key,
      deps,
      repository: spec.repository,
      baseSha: spec.baseSha,
      branch: spec.branch,
      taskId: this.ctx.id.name ?? "",
    };
    // RPC の失敗は値にして raceUntil に渡す（raceUntil が投げるのは、boot の中断のときだけにする）
    const call: Promise<DepsEnsureResult> = Promise.resolve()
      .then(() => this.depsCacheStub(key).ensure(request))
      .catch((): DepsEnsureResult => ({ ok: false, reason: "ensure_failed" }));
    const raced = await this.raceUntil(g, Date.now() + this.depsEnsureWaitMs, call);
    if (raced.timedOut) return this.depsMiss("ensure_timeout");
    const result = raced.value;
    if (!result || typeof result !== "object" || !("ok" in result)) {
      return this.depsMiss("ensure_failed");
    }
    if (!result.ok) return this.depsMiss(result.reason);
    if (result.built) this.recordCacheBuild(result.buildMs);
    // 運用の手がかり（鍵はハッシュで秘密ではない。イメージの参照は出さない）
    console.log(`[sandbox-boot] deps_cache key=${key.slice(0, 16)} built=${result.built}`);
    return { kind: "snapshot", key, snapshotId: result.snapshotId, built: result.built };
  }

  private depsMiss(reason: DepsMissReason): DepsPlan {
    this.logDepsMiss(reason);
    return { kind: "miss", reason };
  }

  /**
   * リポジトリの packageManager（pnpm / yarn）の本体を、npm の経路で先に corepack のキャッシュへ用意する。
   * 大きな本体を実行時に Node の fetch で取らせると、外向き通信の中継越しに undici が落ちる（apps/agent/container/pm-prepare.mjs）。
   * 焼き込んだ版と同じなら何もしない。失敗してもタスクは続ける（従来どおり corepack が自分で取りに行く）。
   */
  private async preparePackageManager(until = Number.POSITIVE_INFINITY): Promise<void> {
    const timeoutMs = Math.min(PM_PREPARE_TIMEOUT_MS, until - Date.now());
    if (timeoutMs < PM_PREPARE_MIN_MS) return;
    const r = await this.rawExec(["node", PM_PREPARE_SCRIPT, WORKSPACE], {
      timeoutMs,
      cwd: "/",
    });
    if (r.exitCode !== 0) {
      console.warn(
        `[sandbox-boot] pm_prepare_failed: ${maskSecrets((r.stderr || r.stdout).trim()).slice(-200)}`,
      );
    }
  }

  /**
   * 作業ツリーを clone した後に、スナップショットから起動していたら node_modules を戻す。usage に出す結果を返す。
   * 戻すのに失敗してもタスクは続ける（miss。ワーカーは自分で導入する）。
   */
  private async finishDeps(
    deps: DepsPlan,
    restoring: Extract<DepsPlan, { kind: "snapshot" }> | undefined,
  ): Promise<DepsCacheStatus> {
    if (!restoring) return deps.kind === "disabled" ? "disabled" : "miss";
    const r = await this.rawExec(
      ["bash", "-c", DEPS_RESTORE_SCRIPT, "rovo-deps-restore", WORKSPACE, DEPS_CACHE_DIR],
      { timeoutMs: DEPS_RESTORE_TIMEOUT_MS, cwd: "/" },
    );
    if (r.exitCode !== 0) {
      this.logDepsMiss("move_failed");
      return "miss";
    }
    return restoring.built ? "built" : "hit";
  }

  /**
   * promise を、期限（絶対時刻）まで待つ。待っている間も BOOT_POLL_MS ごとに terminate・世代を確かめ、
   * 変わっていたら（boot を止めるため）すぐに投げる。期限が来たら timedOut を返す（promise は放置する）。
   */
  private async raceUntil<T>(
    g: number,
    until: number,
    promise: Promise<T>,
  ): Promise<{ timedOut: false; value: T } | { timedOut: true }> {
    const settled = promise.then(
      (value) => ({ done: true as const, value }),
      (error: unknown) => ({ done: true as const, error }),
    );
    for (;;) {
      const remaining = until - Date.now();
      const r = await Promise.race([
        settled,
        sleep(Math.max(0, Math.min(BOOT_POLL_MS, remaining))),
      ]);
      if (r) {
        if ("error" in r) throw r.error;
        return { timedOut: false, value: r.value };
      }
      this.assertBootCurrent(g);
      if (Date.now() >= until) {
        // 放置した promise の失敗を Unhandled にしない（settled が拾っている）
        return { timedOut: true };
      }
    }
  }

  /**
   * /workspace を spec の状態にする。冪等（既に作業ブランチにいれば何もしない）。
   * 初回も含め、常にリモートの作業ブランチ（TaskDO が作成済み）を checkout する。base_sha がその祖先でなければ失敗する。
   */
  private async prepareWorkspace(spec: WorkspaceSpec): Promise<void> {
    const git = (args: string[], timeoutMs = 60_000) =>
      this.rawExec(["git", "-C", WORKSPACE, ...args], { timeoutMs });
    const must = (r: RawResult, what: string) => {
      if (r.exitCode !== 0) {
        throw new Error(
          `${what} failed: ${maskSecrets((r.stderr || r.stdout).trim()).slice(0, 500)}`,
        );
      }
    };
    // task_review: 作業ブランチの代わりに、PR の head（refs/pull/<n>/head）を detached で取り出す。push はしない
    if (spec.checkout) {
      const { pullNumber, sha } = spec.checkout;
      const at = await git(["rev-parse", "--verify", "-q", "HEAD"]);
      if (at.exitCode === 0 && at.stdout.trim() === sha) return;
      if (at.exitCode !== 0) {
        await this.rawExec(["find", WORKSPACE, "-mindepth", "1", "-delete"], { timeoutMs: 60_000 });
        must(
          await this.rawExec(
            [
              "git",
              "clone",
              "-q",
              "--no-checkout",
              `https://github.com/${spec.repository}.git`,
              WORKSPACE,
            ],
            { timeoutMs: CLONE_TIMEOUT_MS },
          ),
          "git clone",
        );
      }
      const ref = `refs/pull/${pullNumber}/head`;
      must(
        await git(
          ["fetch", "-q", "origin", `+${ref}:refs/remotes/origin/pull/${pullNumber}/head`],
          CLONE_TIMEOUT_MS,
        ),
        "git fetch",
      );
      let checkout = await git(["checkout", "-q", "--detach", sha]);
      if (checkout.exitCode !== 0) {
        // head が動いた（force push など）後でも、固定した SHA をリモートから直接取れることがある
        must(await git(["fetch", "-q", "origin", sha], CLONE_TIMEOUT_MS), "git fetch");
        checkout = await git(["checkout", "-q", "--detach", sha]);
      }
      must(checkout, "git checkout");
      const head = await git(["rev-parse", "HEAD"]);
      if (head.exitCode !== 0 || head.stdout.trim() !== sha) {
        throw new Error(`could not check out the pull request head ${sha}`);
      }
      return;
    }
    // checkout したブランチに base_sha が含まれること（fail-closed）。0: 祖先、1: 祖先ではない、他: 判定できない
    const verifyBase = async () => {
      const r = await git(["merge-base", "--is-ancestor", spec.baseSha, "HEAD"]);
      if (r.exitCode === 1) {
        throw new Error(
          `the task branch ${spec.branch} does not contain the base commit ${spec.baseSha}`,
        );
      }
      must(r, "git merge-base");
    };
    const healthy = await git(["rev-parse", "--verify", "-q", "HEAD"]);
    if (healthy.exitCode !== 0) {
      // 作業ツリーが無い（または clone の途中で壊れた）: 空にしてから、作業ブランチを直接 clone する
      await this.rawExec(["find", WORKSPACE, "-mindepth", "1", "-delete"], { timeoutMs: 60_000 });
      must(
        await this.rawExec(
          [
            "git",
            "clone",
            "-q",
            "--branch",
            spec.branch,
            `https://github.com/${spec.repository}.git`,
            WORKSPACE,
          ],
          { timeoutMs: CLONE_TIMEOUT_MS },
        ),
        "git clone",
      );
      await verifyBase();
      return;
    }
    const current = await git(["rev-parse", "--abbrev-ref", "HEAD"]);
    if (current.stdout.trim() === spec.branch) return;
    const exists = await git(["rev-parse", "--verify", "-q", `refs/heads/${spec.branch}`]);
    if (exists.exitCode === 0) {
      must(await git(["switch", "-q", spec.branch]), "git switch");
      return;
    }
    // 作業ツリーはあるが作業ブランチを持っていない: リモートから取り直して切り替える
    must(
      await git(
        ["fetch", "-q", "origin", `+refs/heads/${spec.branch}:refs/remotes/origin/${spec.branch}`],
        CLONE_TIMEOUT_MS,
      ),
      "git fetch",
    );
    must(
      await git(["switch", "-q", "-c", spec.branch, "--no-track", `origin/${spec.branch}`]),
      "git switch -c",
    );
    await verifyBase();
  }

  // ---- 依存関係のキャッシュを作る（DepsCacheDO から呼ばれる。名前が deps-<鍵> のインスタンスで動く）----

  /**
   * 依存関係のスナップショットを作る。タスクのコンテナは使わず、このインスタンス自身のコンテナ（タスクのコンテナと
   * 同じクラス・同じイメージ。スナップショットはイメージに結び付くため）を使う。
   *
   * 手順: image で起動 → 傍受を登録 → base_sha を --depth 1 で取り出す → 導入 → node_modules を
   * /opt/deps-cache へ移す → /workspace を空にする → snapshotContainer → 破棄。
   * スナップショットにはリポジトリの作業状態が入らない（node_modules とパッケージマネージャのキャッシュだけ）。
   * GitHub の資格はコンテナに入れない（外向きの転送時に OutboundGateway が、依頼したタスクの資格で付ける）。
   * 例外は投げない。失敗は固定コードで返す。同時の依頼は 1 つの処理を共有する。
   */
  buildDepsSnapshot(req: DepsBuildRequest): Promise<DepsBuildResult> {
    this.depsBuilding ??= this.runDepsBuild(req).finally(() => {
      this.depsBuilding = undefined;
    });
    return this.depsBuilding;
  }

  private async runDepsBuild(req: DepsBuildRequest): Promise<DepsBuildResult> {
    const started = Date.now();
    const deps: DepsSpec | null = parseDepsSpec(req?.deps);
    let repo: { owner: string; name: string };
    try {
      repo = parseRepository(req.repository);
    } catch {
      return { ok: false, reason: "invalid_deps" };
    }
    if (
      !deps ||
      typeof req.key !== "string" ||
      !DEPS_KEY.test(req.key) ||
      typeof req.baseSha !== "string" ||
      !/^[0-9a-f]{40}([0-9a-f]{24})?$/.test(req.baseSha) ||
      typeof req.branch !== "string" ||
      !/^[A-Za-z0-9_][A-Za-z0-9_./-]{0,199}$/.test(req.branch) ||
      typeof req.taskId !== "string" ||
      !/^[A-Za-z0-9_-]+$/.test(req.taskId)
    ) {
      return { ok: false, reason: "invalid_deps" };
    }
    const container = this.maybeContainer();
    if (!container || typeof container.snapshotContainer !== "function") {
      // スナップショットに対応しないランタイム（ローカルの wrangler dev など）。起動する前に分かるので、時間を使わない
      return { ok: false, reason: "snapshot_unsupported" };
    }
    const timeoutMs = Math.min(
      DEPS_BUILD_TIMEOUT_MS,
      Math.max(1_000, Number.isFinite(req.timeoutMs) ? req.timeoutMs : DEPS_BUILD_TIMEOUT_MS),
    );
    const until = started + timeoutMs;
    const install = [...DEPS_INSTALLS[deps.lockfilePath as DepsLockfile].argv];
    /** 1 つの段階を、全体の期限の残りの時間で実行する。失敗・時間切れは DepsBuildError */
    const step = async (what: string, argv: string[], cwd = "/") => {
      const remaining = until - Date.now();
      if (remaining <= 0) throw new DepsBuildError("build_timeout", what);
      const r = await this.rawExec(argv, { timeoutMs: remaining, cwd });
      if (r.exitCode !== 0) {
        throw new DepsBuildError(
          Date.now() >= until ? "build_timeout" : "build_failed",
          `${what} exit=${r.exitCode} ${maskSecrets((r.stderr || r.stdout).trim()).slice(-300)}`,
        );
      }
    };
    try {
      if (container.running) await this.destroyContainer(this.bootDestroyMs);
      const { instance } = resolveSandboxInstance(this.env.SANDBOX_INSTANCE);
      container.start({
        image: container.images.workspace,
        enableInternet: false,
        instance,
        env: BASE_ENV,
      });
      // 期限（timeoutMs）より長く待つ。alarm の鎖が無い builder は、この期限が上限になる
      await this.onContainerStarted(container, this.gen, timeoutMs + 60_000);
      // 傍受と許可リストはタスクのコンテナと同じ（github.com は対象リポジトリの git だけ、レジストリは GET だけ）
      const gateway = this.ctx.exports.OutboundGateway({
        props: { repo, task: req.branch, taskId: req.taskId },
      });
      const intercepted = await withDeadline(
        Promise.all([
          container.interceptOutboundHttps("*", gateway),
          container.interceptAllOutboundHttp(gateway),
        ]),
        Math.min(until, Date.now() + this.bootAttemptMs),
      );
      if (intercepted === "timeout") throw new DepsBuildError("build_failed", "intercept");
      // exec が応答するまで待つ
      const readyUntil = Math.min(until, Date.now() + this.bootAttemptMs);
      let ready = false;
      while (!ready && Date.now() < readyUntil) {
        const r = await withDeadline(
          container
            .exec(["true"])
            .then((p) => p.exitCode)
            .catch(() => -1),
          readyUntil,
        );
        if (r === 0) ready = true;
        else await sleep(BOOT_POLL_MS);
      }
      if (!ready) throw new DepsBuildError("build_failed", "container did not become ready");
      await step("fetch", [
        "bash",
        "-c",
        DEPS_FETCH_SCRIPT,
        "rovo-deps-fetch",
        WORKSPACE,
        `https://github.com/${req.repository}.git`,
        req.baseSha,
      ]);
      // 導入の前に、packageManager の本体を npm の経路で用意する（失敗しても導入は続ける）
      await this.preparePackageManager(until);
      await step("install", install, WORKSPACE);
      await step("stash", [
        "bash",
        "-c",
        DEPS_STASH_SCRIPT,
        "rovo-deps-stash",
        WORKSPACE,
        DEPS_CACHE_DIR,
      ]);
      // リポジトリの作業状態をスナップショットに入れない
      await step("wipe", ["find", WORKSPACE, "-mindepth", "1", "-delete"]);
      let snapshot: Awaited<ReturnType<NonNullable<Container["snapshotContainer"]>>> | "timeout";
      try {
        snapshot = await withDeadline(
          container.snapshotContainer({ name: depsSnapshotName(req.key) }),
          until,
        );
      } catch (e) {
        throw new DepsBuildError(
          "snapshot_failed",
          e instanceof Error ? e.message.slice(0, 200) : "",
        );
      }
      if (snapshot === "timeout") throw new DepsBuildError("build_timeout", "snapshot");
      if (typeof snapshot?.id !== "string" || snapshot.id === "") {
        throw new DepsBuildError("snapshot_failed", "no snapshot id");
      }
      return {
        ok: true,
        snapshotId: snapshot.id,
        size: typeof snapshot.size === "number" ? snapshot.size : 0,
        buildMs: Date.now() - started,
      };
    } catch (e) {
      const reason: DepsMissReason = e instanceof DepsBuildError ? e.reason : "build_failed";
      console.warn(
        `[deps-build] failed: ${reason}${e instanceof DepsBuildError && e.detail ? ` (${e.detail})` : ""}`,
      );
      return { ok: false, reason };
    } finally {
      // 成功・失敗にかかわらず、作成用のコンテナは残さない
      await this.destroyContainer(this.bootDestroyMs).catch(() => undefined);
    }
  }

  // ---- 内部の実行 ----

  /** 内部用の短い exec（reaper は呼ばない）。出力は小さい前提。 */
  private async rawExec(
    argv: string[],
    opts: { timeoutMs: number; cwd?: string },
  ): Promise<RawResult> {
    const container = this.container();
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), opts.timeoutMs);
    try {
      const proc = await container.exec(argv, {
        cwd: opts.cwd ?? WORKSPACE,
        env: BASE_ENV,
        signal: ac.signal,
      });
      const out = new TailBuffer(64 * 1024);
      const err = new TailBuffer(64 * 1024);
      const a = drain(proc.stdout, out);
      const b = drain(proc.stderr, err);
      const exitCode = await proc.exitCode.catch(() => -1);
      await Promise.race([Promise.all([a.done, b.done]), sleep(STREAM_GRACE_MS)]);
      a.cancel();
      b.cancel();
      return { exitCode, stdout: out.result().text, stderr: err.result().text };
    } catch (e) {
      return { exitCode: -1, stdout: "", stderr: e instanceof Error ? e.message : String(e) };
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * パスの realpath を取り、/workspace 配下に収まることを確かめた実パスを返す
   * （シンボリックリンク経由の脱出を拒否する）。mustExist=false なら、存在しない末尾は許す。
   */
  private async realPath(abs: string, mustExist: boolean): Promise<string> {
    const r = await this.rawExec(["realpath", mustExist ? "-e" : "-m", "--", abs], {
      timeoutMs: 10_000,
    });
    const real = r.stdout.trim();
    if (r.exitCode !== 0 || !real) {
      throw new Error(`cannot resolve path ${abs}: ${r.stderr.trim() || "not found"}`);
    }
    if (!isInsideWorkspace(WORKSPACE, real)) {
      throw new Error(`path is outside ${WORKSPACE} (symlink): ${abs}`);
    }
    return real;
  }

  /**
   * 基準プロセスと reaper 自身以外をすべて SIGKILL し、残っていないことを確かめる。
   * 独立した期限を持つ。成功したら true。
   */
  private reap(): Promise<boolean> {
    // reaper 同士は互いを「基準外のプロセス」として殺してしまうので、同時に 1 つだけ走らせる
    const p = this.reapQueue.then(() => this.reapOnce());
    this.reapQueue = p.catch(() => {});
    return p;
  }

  private async reapOnce(): Promise<boolean> {
    if (this.failNextReapFlag) {
      this.failNextReapFlag = false;
      return false;
    }
    const baseline = this.baseline();
    if (!baseline || !this.maybeContainer()?.running) return false;
    const r = await this.rawExec(
      ["bash", "-c", PROCESS_SCRIPT, "rovo-reaper", "kill", ...baseline],
      { timeoutMs: REAPER_TIMEOUT_MS },
    );
    const clean = r.exitCode === 0 && r.stdout.includes("clean");
    if (!clean) {
      console.warn(
        `sandbox: reaper failed exit=${r.exitCode} out=${r.stdout.slice(-200)} err=${r.stderr.slice(-200)}`,
      );
    }
    return clean;
  }

  private async reapOrDestroy(): Promise<void> {
    if (!(await this.reap())) await this.destroyAudited("reap_failed");
  }

  /** 破棄は特権操作（作業ツリーの未 push の変更が失われる）なので、監査してから破棄する。 */
  private async destroyAudited(reason: "reap_failed" | "exec_timeout"): Promise<void> {
    this.audit("sandbox_privileged_op", { op: "destroy", reason });
    await this.destroyContainer();
  }

  /**
   * コンテナを破棄し、止まったことを確かめる。これが停止の唯一の保証（コンテナ内のプロセスの走査は偽装できる）。
   * 監視の期限は destroy() の Promise を待つ前から数える（Promise が返らなくても期限が効く）。
   */
  private async destroyContainer(waitMs = this.destroyWaitMs): Promise<void> {
    const container = this.container();
    const until = Date.now() + waitMs;
    this.readyGen = -1;
    this.ctx.storage.kv.delete("baseline");
    if (!container.running) {
      this.settleRuntime();
      return;
    }
    if (this.life) this.life.destroyedByRovo = true;
    const destroyed = Promise.resolve()
      .then(() => container.destroy())
      .catch(() => {});
    await Promise.race([destroyed, sleep(waitMs)]);
    while (container.running && Date.now() < until) await sleep(100);
    if (container.running) throw new Error("container did not stop");
    this.closeRuntime(Date.now());
  }

  private async runExec(
    argv: string[],
    options: ExecOptions & { cwd: string },
  ): Promise<ExecResult> {
    const container = this.container();
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const max = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT;
    // AbortSignal.timeout は exec では使えないので自前で AbortController を使う
    const ac = new AbortController();
    let timedOut = false;
    const out = new TailBuffer(max);
    const err = new TailBuffer(max);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const active = options.origin !== undefined ? { startedAt: Date.now(), out, err } : undefined;
    try {
      const proc = await container.exec(argv, {
        cwd: options.cwd,
        env: { ...BASE_ENV, ...options.env },
        signal: ac.signal,
      });
      this.activeExec = active;
      const a = drain(proc.stdout, out);
      const b = drain(proc.stderr, err);
      const exited = proc.exitCode.catch(() => -1);
      const timeout = new Promise<"timeout">((resolve) => {
        timer = setTimeout(() => resolve("timeout"), timeoutMs);
      });
      const first = await Promise.race([exited, timeout]);
      clearTimeout(timer);
      let exitCode: number;
      if (first === "timeout") {
        timedOut = true;
        // 停止の保証はコンテナの破棄だけ。コンテナ内のプロセスの走査は、root で動く信用できないコードに偽装されうる。
        // 作業ツリーの未 commit の変更は失われ、次の操作で再 clone される。
        try {
          await this.destroyAudited("exec_timeout");
        } finally {
          ac.abort();
        }
        exitCode = 137;
      } else {
        exitCode = first;
        // 正常に終わったコマンドの後の片付け（ベストエフォート）。失敗したらコンテナごと破棄する
        await this.reapOrDestroy();
      }
      // ワーカーが掴んだままのパイプで読み取りが終わらないことがある。少しだけ待って打ち切る。
      await Promise.race([Promise.all([a.done, b.done]), sleep(STREAM_GRACE_MS)]);
      a.cancel();
      b.cancel();
      const o = out.result();
      const e = err.result();
      return {
        exitCode: timedOut ? 137 : exitCode,
        stdout: maskSecrets(o.text),
        stderr: maskSecrets(e.text),
        timedOut,
        truncated: o.truncated || e.truncated,
      };
    } catch (e) {
      await this.reapOrDestroy().catch(() => {});
      throw e;
    } finally {
      if (timer) clearTimeout(timer);
      if (this.activeExec === active) this.activeExec = undefined;
    }
  }
}
