import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { writeDevVars } from "./dev-vars";
import { acquireLock } from "./docker-lock";
import { e2eLog } from "./e2e-log";

export const AGENT_DIR = join(import.meta.dirname, "..", "..");
export const REPO_ROOT = join(AGENT_DIR, "..", "..");

/** E2E の Worker に渡す TOKEN_ENC_KEY（base64 の 32 バイト。テスト専用の値）。 */
export const E2E_TOKEN_ENC_KEY = Buffer.alloc(32, 9).toString("base64");

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}

/** wrangler dev が作った Docker コンテナ（本体とプロキシのサイドカー）。名前は workerd-<worker>-<class>-... */
function listAgentContainers(): Set<string> {
  try {
    const out = execFileSync(
      "docker",
      ["ps", "-a", "--filter", "name=workerd-rovo-agent-", "--format", "{{.ID}}"],
      {
        encoding: "utf8",
      },
    );
    return new Set(out.split("\n").filter(Boolean));
  } catch {
    return new Set();
  }
}

const LOCK_DIR = join(tmpdir(), "rovo-e2e-docker.lock");

/**
 * wrangler dev + Docker の E2E は同時に 1 つだけ走らせる（プロセス間の排他ロック。docker-lock.ts）。
 * 後始末が「この起動中に増えた rovo-agent のコンテナ」を消すため、別の起動と並走すると互いのコンテナを消し合い、
 * コンテナが SIGKILL（exit 137）されて不安定になる。
 * 注意: このロックを取るのは E2E の起動同士だけ。E2E の実行中に別に起動した `mise run dev:all` はロックを取らないので、
 * その開発セッションのコンテナ（名前が workerd-rovo-agent-）が後始末で消えることがある。
 */
const acquireDockerLock = (timeoutMs: number) => acquireLock(LOCK_DIR, timeoutMs);

export interface RunningWrangler {
  baseUrl: string;
  stop(): Promise<void>;
}

function signalGroup(pid: number, signal: NodeJS.Signals | 0): boolean {
  try {
    process.kill(-pid, signal);
    return true;
  } catch {
    return false;
  }
}

async function groupGone(pid: number, withinMs: number): Promise<boolean> {
  const deadline = Date.now() + withinMs;
  while (Date.now() < deadline) {
    if (!signalGroup(pid, 0)) return true;
    await sleep(100);
  }
  return !signalGroup(pid, 0);
}

export interface StartWranglerOptions {
  /** wrangler の設定ファイル（先頭が primary。複数なら `-c a -c b` の形で渡る）。repo ルート基準。 */
  configs: string[];
  /** `--var` で渡す値。複数設定のときは先頭（primary）の Worker にしか効かない。 */
  vars: Record<string, string>;
  /**
   * 設定ファイルごとの追加 vars（キーは configs と同じ repo ルート基準のパス）。設定ファイルの隣の .dev.vars に
   * 起動中だけ書く（複数設定の wrangler dev で primary 以外の Worker に ENVIRONMENT=test を渡すため。
   * 既存の .dev.vars は退避して、停止時に戻す）。
   */
  configVars?: Record<string, Record<string, string>>;
  /** 起動完了とみなす URL（baseUrl からの相対）。応答が返れば ready。 */
  readyPath: string;
  persistDir: string;
  /** ready 待ちの上限。Docker イメージのビルドを含むので長め。 */
  readyDeadlineMs?: number;
  /** 待ち受けポート。事前に決める必要があるとき（PUBLIC_BASE_URL を vars に入れる等）だけ指定する。省略時は空きポート。 */
  port?: number;
}

/**
 * wrangler dev を起動して ready まで待つ。停止は stop()（プロセスグループごと SIGTERM → 期限後 SIGKILL）。
 * SIGTERM で wrangler が起動したコンテナも片付く。
 */
export async function startWrangler(opts: StartWranglerOptions): Promise<RunningWrangler> {
  const releaseLock = await acquireDockerLock(30 * 60_000);
  try {
    return await startLocked(opts, releaseLock);
  } catch (e) {
    releaseLock();
    throw e;
  }
}

async function startLocked(
  opts: StartWranglerOptions,
  releaseLock: () => void,
): Promise<RunningWrangler> {
  const port = opts.port ?? (await freePort());
  const inspectorPort = await freePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const bin = join(AGENT_DIR, "node_modules", "wrangler", "bin", "wrangler.js");
  const args = [
    bin,
    "dev",
    ...opts.configs.flatMap((c) => ["-c", c]),
    "--ip",
    "127.0.0.1",
    "--port",
    String(port),
    "--inspector-port",
    String(inspectorPort),
    ...Object.entries(opts.vars).flatMap(([k, v]) => ["--var", `${k}:${v}`]),
    "--persist-to",
    opts.persistDir,
    "--log-level",
    "info",
  ];
  // 設定ファイルの隣の .dev.vars に起動中だけ書く。前回の異常終了の残骸は、書く前に戻す（dev-vars.ts）
  const restores = Object.entries(opts.configVars ?? {}).map(([config, vars]) =>
    writeDevVars(join(REPO_ROOT, dirname(config), ".dev.vars"), vars),
  );
  const restoreDevVars = () => {
    process.off("exit", restoreDevVars);
    for (const r of restores) r();
  };
  process.on("exit", restoreDevVars);
  const containersBefore = listAgentContainers();
  // wrangler の出力は、テストを流した場所の外（$TMPDIR/rovo-e2e-logs/…）に保存する。失敗の調査はこのファイルを読む
  const wranglerLog = e2eLog().wranglerLog(
    opts.configs.map((c) => c.split("/").slice(-2, -1)[0] ?? "wrangler").join("+"),
  );
  const logs: string[] = [];
  const child: ChildProcess = spawn(process.execPath, args, {
    cwd: REPO_ROOT,
    env: { ...process.env, WRANGLER_SEND_METRICS: "false", CI: "1" },
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
  });
  const debug = process.env.E2E_DEBUG === "1";
  const collect = (d: unknown) => {
    logs.push(String(d));
    wranglerLog.write(String(d));
    if (debug) process.stderr.write(String(d));
  };
  child.stdout?.on("data", collect);
  child.stderr?.on("data", collect);

  const stop = async () => {
    const pid = child.pid;
    if (pid === undefined) return;
    if (!signalGroup(pid, "SIGTERM")) return;
    if (await groupGone(pid, 15_000)) return;
    signalGroup(pid, "SIGKILL");
    await groupGone(pid, 3_000);
  };
  const stopAndClean = async () => {
    await e2eLog().timed("wrangler stop", stop);
    restoreDevVars();
    // wrangler はプロキシのサイドカーを残すことがある。この起動中に増えた分だけ片付ける（既存の開発セッションは触らない）
    const leftovers = [...listAgentContainers()].filter((id) => !containersBefore.has(id));
    if (leftovers.length > 0) {
      try {
        execFileSync("docker", ["rm", "-f", ...leftovers], { stdio: "ignore" });
      } catch {
        // 片付けの失敗でテスト結果を変えない
      }
    }
    releaseLock();
    process.stderr.write(`[rovo-e2e] wrangler のログ: ${wranglerLog.path}\n`);
  };

  const startedAt = Date.now();
  const deadline = Date.now() + (opts.readyDeadlineMs ?? 300_000);
  for (;;) {
    if (child.exitCode !== null) {
      restoreDevVars();
      throw new Error(
        `wrangler dev が終了しました (code=${child.exitCode})。ログ: ${wranglerLog.path}\n${logs.join("")}`,
      );
    }
    if (Date.now() > deadline) {
      await stopAndClean();
      throw new Error(
        `wrangler dev の起動がタイムアウトしました。ログ: ${wranglerLog.path}\n${logs.slice(-40).join("")}`,
      );
    }
    try {
      const res = await fetch(`${baseUrl}${opts.readyPath}`, {
        signal: AbortSignal.timeout(2_000),
      });
      await res.body?.cancel();
      break;
    } catch {
      await sleep(500);
    }
  }
  e2eLog().record("wrangler ready", Date.now() - startedAt);
  return { baseUrl, stop: stopAndClean };
}
