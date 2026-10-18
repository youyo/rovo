import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { dirname, join } from "node:path";

export const AGENT_DIR = join(import.meta.dirname, "..", "..");
export const REPO_ROOT = join(AGENT_DIR, "..", "..");

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
}

/**
 * wrangler dev を起動して ready まで待つ。停止は stop()（プロセスグループごと SIGTERM → 期限後 SIGKILL）。
 * SIGTERM で wrangler が起動したコンテナも片付く。
 */
export async function startWrangler(opts: StartWranglerOptions): Promise<RunningWrangler> {
  const port = await freePort();
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
  const devVarsFiles = Object.entries(opts.configVars ?? {}).map(([config, vars]) => {
    const file = join(REPO_ROOT, dirname(config), ".dev.vars");
    const previous = existsSync(file) ? readFileSync(file) : undefined;
    writeFileSync(
      file,
      `${Object.entries(vars)
        .map(([k, v]) => `${k}=${v}`)
        .join("\n")}\n`,
    );
    return { file, previous };
  });
  const restoreDevVars = () => {
    for (const { file, previous } of devVarsFiles) {
      if (previous === undefined) rmSync(file, { force: true });
      else writeFileSync(file, previous);
    }
  };
  const containersBefore = listAgentContainers();
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
    await stop();
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
  };

  const deadline = Date.now() + (opts.readyDeadlineMs ?? 300_000);
  for (;;) {
    if (child.exitCode !== null) {
      restoreDevVars();
      throw new Error(`wrangler dev が終了しました (code=${child.exitCode})\n${logs.join("")}`);
    }
    if (Date.now() > deadline) {
      await stopAndClean();
      throw new Error(`wrangler dev の起動がタイムアウトしました\n${logs.slice(-40).join("")}`);
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
  return { baseUrl, stop: stopAndClean };
}
