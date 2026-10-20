import { DurableObject } from "cloudflare:workers";
import { posix } from "node:path";
import { Files } from "@cloudflare/sandbox";
import type { AuditFields, AuditRecord } from "@rovo/audit";
import { resolveSandboxInstance } from "@rovo/models";
import type { GitCredential, SandboxMetrics } from "./agent/types";
import { appendTestAudit, emitAudit, readTestAudit } from "./audit-adapter";
import { PROCESS_SCRIPT } from "./container-scripts";
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
import type { ExecOptions, ExecResult, SandboxPort, WorkspaceSpec } from "./sandbox-port";
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
  GIT_TERMINAL_PROMPT: "0",
  GIT_CONFIG_COUNT: "1",
  GIT_CONFIG_KEY_0: "safe.directory",
  GIT_CONFIG_VALUE_0: WORKSPACE,
};
const DEFAULT_TIMEOUT_MS = 10 * 60_000;
const DEFAULT_MAX_OUTPUT = 64 * 1024;
const MAX_FILE_BYTES = 8 * 1024 * 1024;
const INACTIVITY_TIMEOUT_MS = 2 * 60 * 60_000;
const KEEPALIVE_MS = 60_000;
const REAPER_TIMEOUT_MS = 10_000;
const STREAM_GRACE_MS = 2_000;
const DESTROY_WAIT_MS = 15_000;
const CLONE_TIMEOUT_MS = 5 * 60_000;
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

export class SandboxDO extends DurableObject<Env> implements SandboxPort {
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
  /** キャッシュを作る処理（builder として使われたとき）。同時の依頼は 1 つを共有する。 */
  private depsBuilding?: Promise<DepsBuildResult>;

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
    const since = this.ctx.storage.kv.get<number>("rt_since");
    let open = 0;
    if (since !== undefined) {
      const end = this.maybeContainer()?.running
        ? Date.now()
        : Math.max(since, this.num("rt_seen"));
      open = Math.max(0, end - since);
    }
    const depsCache = this.ctx.storage.kv.get<DepsCacheStatus>("deps_cache");
    const cacheBuildMs = this.num("cache_build_ms");
    return {
      runtimeMs: this.num("rt_total") + open,
      restarts: Math.max(0, this.num("starts") - 1),
      bootRetries: this.num("boot_retries"),
      ...(depsCache !== undefined ? { depsCache } : {}),
      ...(cacheBuildMs > 0 ? { cacheBuildMs } : {}),
    };
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
        stored.initialSha !== spec.initialSha
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
      return this.runExec(argv, { ...options, cwd });
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
   * 永続的な終端停止（cancel 用）。コンテナを破棄し、以後の ensureReady / exec / ファイル操作を拒否する。
   * 遅れて届いた指示で再起動しないための tombstone。停止の保証は destroy だけで行う。
   * 進行中の boot は無効化し、収束した後にもう一度停止を確かめる。
   */
  async terminate(): Promise<{ stopped: boolean }> {
    this.audit("sandbox_privileged_op", { op: "terminate" });
    this.ctx.storage.kv.put("terminated", true);
    this.ctx.storage.kv.delete("git_credential");
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
      try {
        await this.destroyContainer();
      } catch {
        await this.ctx.storage.setAlarm(Date.now() + 10_000);
      }
      return;
    }
    if (this.maybeContainer()?.running) await this.armAlarm();
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
    const promise = this.boot(g).then((started) => {
      if (this.gen === g) this.readyGen = g;
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
        const { instance, ignored } = resolveSandboxInstance(this.env.SANDBOX_INSTANCE);
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
      await container.setInactivityTimeout(INACTIVITY_TIMEOUT_MS);
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
    await this.armAlarm();
    return started;
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
   * 作業ツリーを clone した後に、スナップショットから起動していたら node_modules を戻す。usage に出す結果を返す。
   * 戻すのに失敗してもタスクは続ける（miss。子は自分で導入する）。
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
      await container.setInactivityTimeout(timeoutMs + 60_000);
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
    try {
      const proc = await container.exec(argv, {
        cwd: options.cwd,
        env: { ...BASE_ENV, ...options.env },
        signal: ac.signal,
      });
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
      // 子が掴んだままのパイプで読み取りが終わらないことがある。少しだけ待って打ち切る。
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
    }
  }
}
