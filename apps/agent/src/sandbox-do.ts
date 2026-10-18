import { DurableObject } from "cloudflare:workers";
import { posix } from "node:path";
import { Files } from "@cloudflare/sandbox";
import { PROCESS_SCRIPT } from "./container-scripts";
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
const CLONE_TIMEOUT_MS = 5 * 60_000;

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

export class SandboxDO extends DurableObject<Env> implements SandboxPort {
  /** 起動の世代。boot ごとに増える。古い boot の結果が新しい状態を上書きしないようにする。 */
  private gen = 0;
  private readyGen = -1;
  private booting?: { gen: number; promise: Promise<boolean> };
  /** すべての操作（exec / ファイル）を 1 つずつ実行するための鎖 */
  private queue: Promise<unknown> = Promise.resolve();
  private failNextReapFlag = false;
  private reapQueue: Promise<unknown> = Promise.resolve();

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
  private container(): Container {
    const c = this.ctx.container;
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
        stored.branch !== spec.branch
      ) {
        throw new Error("conflict: this sandbox is already bound to a different workspace");
      }
      // 期限は延長しない
    } else {
      if (spec.deadlineAt <= Date.now()) throw new Error("sandbox deadline exceeded");
      this.ctx.storage.kv.put("spec", spec);
    }
    this.requireSpec();
    await this.armAlarm();
    await this.serial(async () => {
      this.requireSpec();
      await this.ensureRunning();
    });
    await this.armAlarm();
  }

  async exec(argv: string[], options: ExecOptions = {}): Promise<ExecResult> {
    if (!Array.isArray(argv) || argv.length === 0 || argv.some((a) => typeof a !== "string")) {
      throw new Error("argv must be a non-empty array of strings");
    }
    const cwd = options.cwd ? resolveWorkspacePath(WORKSPACE, options.cwd) : WORKSPACE;
    this.requireSpec();
    return this.serial(async () => {
      this.requireSpec();
      await this.runningOrThrowRestarted();
      return this.runExec(argv, { ...options, cwd });
    });
  }

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
    const container = this.ctx.container;
    if (!container?.running) return { stopped: true };
    const clean = await this.reap();
    if (clean) return { stopped: true };
    await this.destroyContainer();
    return { stopped: !container.running };
  }

  /**
   * 永続的な終端停止（cancel 用）。コンテナを止め、以後の ensureReady / exec / ファイル操作を拒否する。
   * 遅れて届いた指示で再起動しないための tombstone。
   */
  async terminate(): Promise<{ stopped: boolean }> {
    this.ctx.storage.kv.put("terminated", true);
    await this.ctx.storage.deleteAlarm();
    await this.destroyContainer();
    return { stopped: !this.ctx.container?.running };
  }

  /** コンテナを起こさずに状態を返す（E2E と監視用）。 */
  status(): { running: boolean; terminated: boolean; expired: boolean; hasSpec: boolean } {
    const spec = this.spec();
    return {
      running: this.ctx.container?.running === true,
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
      try {
        await this.destroyContainer();
      } catch {
        await this.ctx.storage.setAlarm(Date.now() + 10_000);
      }
      return;
    }
    if (this.ctx.container?.running) await this.armAlarm();
  }

  // ---- 起動 ----

  /** 起動直後の操作が「再起動した」ことを伝える。以降の操作は新しい作業ツリーで動く。 */
  private async runningOrThrowRestarted(): Promise<void> {
    const started = await this.ensureRunning();
    if (started) {
      throw new Error(
        "the sandbox container was restarted and the workspace was re-cloned from the base commit; " +
          "uncommitted and unpushed changes were lost. Redo your work.",
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
    const promise = this.boot().then((started) => {
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

  private async boot(): Promise<boolean> {
    const container = this.container();
    const spec = this.requireSpec();
    // 基準プロセスの記録が無いコンテナは信用できないので、作り直す
    if (container.running && !this.baseline()) await this.destroyContainer();
    let started = false;
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
    };
    const gateway = this.ctx.exports.OutboundGateway({ props });
    await container.interceptOutboundHttps("*", gateway);
    await container.interceptAllOutboundHttp(gateway);
    // 起動直後は exec が失敗しうるので、応答するまで待つ
    const deadline = Date.now() + 120_000;
    for (;;) {
      try {
        const p = await container.exec(["true"]);
        if ((await p.exitCode) === 0) break;
      } catch {
        // まだ起動中
      }
      if (Date.now() > deadline) throw new Error("container did not become ready");
      await sleep(500);
    }
    if (started) {
      await container.setInactivityTimeout(INACTIVITY_TIMEOUT_MS);
      // 信頼できる状態（ユーザーのコードを動かす前）で、残してよいプロセスを記録する
      const list = await this.rawExec(["bash", "-c", PROCESS_SCRIPT, "rovo-baseline", "list"], {
        timeoutMs: REAPER_TIMEOUT_MS,
      });
      if (list.exitCode !== 0) throw new Error("could not record baseline processes");
      this.ctx.storage.kv.put("baseline", list.stdout.split("\n").filter(Boolean));
    }
    await this.prepareWorkspace(spec);
    await this.armAlarm();
    return started;
  }

  /** /workspace を spec の状態にする。冪等（既にあれば何もしない）。 */
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
    const healthy = await git(["rev-parse", "--verify", "-q", "HEAD"]);
    if (healthy.exitCode !== 0) {
      // 作業ツリーが無い（または clone の途中で壊れた）: 空にしてから clone する
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
    const current = await git(["rev-parse", "--abbrev-ref", "HEAD"]);
    if (current.stdout.trim() === spec.branch) return;
    const exists = await git(["rev-parse", "--verify", "-q", `refs/heads/${spec.branch}`]);
    if (exists.exitCode === 0) {
      must(await git(["switch", "-q", spec.branch]), "git switch");
      return;
    }
    must(await git(["checkout", "-q", "--detach", spec.baseSha], CLONE_TIMEOUT_MS), "git checkout");
    must(await git(["switch", "-q", "-c", spec.branch]), "git switch -c");
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
    if (!baseline || !this.ctx.container?.running) return false;
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

  /** コンテナを止め、止まったことを確かめる。 */
  private async destroyContainer(): Promise<void> {
    const container = this.container();
    this.readyGen = -1;
    this.ctx.storage.kv.delete("baseline");
    if (!container.running) return;
    await container.destroy().catch(() => {});
    const until = Date.now() + 15_000;
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
      timer = setTimeout(() => {
        timedOut = true;
        // 子孫を含め、基準以外のプロセスをすべて止める。その後に abort する（exec 自体の後始末）。
        void this.reapOrDestroy().finally(() => ac.abort());
      }, timeoutMs);
      const exitCode = await proc.exitCode.catch(() => (timedOut ? 137 : -1));
      clearTimeout(timer);
      // 子が掴んだままのパイプで読み取りが終わらないことがある。reaper の後に少しだけ待って打ち切る。
      await this.reapOrDestroy();
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
