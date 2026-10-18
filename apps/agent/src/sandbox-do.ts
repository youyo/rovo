import { DurableObject } from "cloudflare:workers";
import { posix } from "node:path";
import { Files } from "@cloudflare/sandbox";
import type { GitCredential } from "./agent/types";
import { PROCESS_SCRIPT } from "./container-scripts";
import { decryptString, encryptString, importEncryptionKey } from "./crypto";
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

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

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
    await this.armAlarm();
  }

  /**
   * 期限を正確な値に設定する（AgentDO が、回答のときに質問で延ばした上限から戻すために submit より前に呼ぶ）。
   * 短くもできる。上限は extendDeadline と同じ。現在時刻より前の値は、alarm がすぐ発火して期限切れとして扱われる。
   */
  async setDeadline(deadlineAt: number): Promise<void> {
    const spec = this.checkedDeadline(deadlineAt);
    this.ctx.storage.kv.put("spec", { ...spec, deadlineAt });
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
    await this.destroyContainer();
    return { stopped: !container.running };
  }

  /**
   * 永続的な終端停止（cancel 用）。コンテナを破棄し、以後の ensureReady / exec / ファイル操作を拒否する。
   * 遅れて届いた指示で再起動しないための tombstone。停止の保証は destroy だけで行う。
   * 進行中の boot は無効化し、収束した後にもう一度停止を確かめる。
   */
  async terminate(): Promise<{ stopped: boolean }> {
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
    if (this.gen !== g) throw new Error("boot was superseded");
    return this.requireSpec(); // terminated / 期限切れならここで投げる
  }

  private async boot(g: number): Promise<boolean> {
    const container = this.container();
    const spec = this.assertBootCurrent(g);
    // 基準プロセスの記録が無いコンテナは信用できないので、作り直す
    if (container.running && !this.baseline()) await this.destroyContainer(this.bootDestroyMs);
    // destroy を待っている間に terminate・期限・世代が変わりうる。start の直前に必ず確かめ直す
    this.assertBootCurrent(g);
    let started = false;
    const trace: string[] = [];
    let ready = false;
    for (let attempt = 1; attempt <= BOOT_MAX_ATTEMPTS && !ready; attempt++) {
      const attemptStart = Date.now();
      // この試行の期限（破棄の時間は含めない）
      const until = attemptStart + this.bootAttemptMs;
      if (!container.running) {
        this.ctx.storage.kv.delete("baseline");
        container.start({
          image: container.images.workspace,
          enableInternet: false,
          env: BASE_ENV,
        });
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
        `#${attempt} ${ready ? "ready" : `stalled-at-${stage}`} ${stageEnds.join(" ")} probes=${probes}${lastError ? ` last="${lastError}"` : ""}`,
      );
      if (ready) break;
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
    await this.armAlarm();
    return started;
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
    if (!(await this.reap())) await this.destroyContainer();
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
    if (!container.running) return;
    const destroyed = Promise.resolve()
      .then(() => container.destroy())
      .catch(() => {});
    await Promise.race([destroyed, sleep(waitMs)]);
    while (container.running && Date.now() < until) await sleep(100);
    if (container.running) throw new Error("container did not stop");
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
          await this.destroyContainer();
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
