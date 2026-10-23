import { execFile, execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { ExecResult } from "../../../src/sandbox-port";
import type { ScanGit } from "../../../src/secret-scan";

/** 一時ディレクトリの本物の git。global / system の設定を読まず、作者は固定する */
export interface RealRepo {
  dir: string;
  /** git を実行して stdout を返す（失敗したら例外） */
  git: (...argv: string[]) => string;
  /** ファイルを書く（親ディレクトリも作る）。content は文字列か Buffer */
  write: (path: string, content: string | Buffer) => void;
  /** 全部 add して commit する。SHA を返す */
  commitAll: (message: string) => string;
  head: () => string;
  /** 本物の bare リポジトリを作り、origin に登録する（ls-remote が本物の答えを返す）。bare のパスを返す */
  addOrigin: () => string;
  /** 検査の関数に渡す git（Sandbox の exec の代わりに child_process で本物の git を呼ぶ）。limit で出力の上限を小さくできる */
  scanGit: (limit?: number) => ScanGit;
  cleanup: () => void;
}

const ENV = {
  ...process.env,
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@example.com",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@example.com",
  GIT_TERMINAL_PROMPT: "0",
};

export function makeRepo(): RealRepo {
  const dir = mkdtempSync(join(tmpdir(), "rovo-real-git-"));
  const git = (...argv: string[]) =>
    execFileSync("git", argv, {
      cwd: dir,
      env: ENV,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  git("init", "-q", "-b", "main");
  git("config", "commit.gpgsign", "false");
  git("config", "core.autocrlf", "false");
  const head = () => git("rev-parse", "HEAD").trim();
  const bares: string[] = [];
  return {
    dir,
    git,
    write: (path, content) => {
      const full = join(dir, path);
      mkdirSync(dirname(full), { recursive: true });
      writeFileSync(full, content);
    },
    commitAll: (message) => {
      git("add", "-A");
      git("commit", "-q", "--no-verify", "--allow-empty", "-m", message);
      return head();
    },
    head,
    addOrigin: () => {
      const bare = mkdtempSync(join(tmpdir(), "rovo-real-origin-"));
      bares.push(bare);
      execFileSync("git", ["init", "-q", "--bare", "-b", "main", bare], { env: ENV });
      git("remote", "add", "origin", bare);
      return bare;
    },
    scanGit: (limit) => (argv, timeoutMs, maxOutputBytes) =>
      new Promise<ExecResult>((resolve) => {
        execFile(
          "git",
          argv,
          {
            cwd: dir,
            env: ENV,
            timeout: timeoutMs,
            maxBuffer: Math.min(maxOutputBytes, limit ?? maxOutputBytes),
            encoding: "utf8",
          },
          (err, stdout, stderr) => {
            const e = err as (Error & { code?: number | string; killed?: boolean }) | null;
            if (!e) {
              resolve({ exitCode: 0, stdout, stderr, timedOut: false, truncated: false });
            } else if (e.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") {
              resolve({ exitCode: 0, stdout, stderr, timedOut: false, truncated: true });
            } else {
              resolve({
                exitCode: typeof e.code === "number" ? e.code : 1,
                stdout,
                stderr,
                timedOut: e.killed === true,
                truncated: false,
              });
            }
          },
        );
      }),
    cleanup: () => {
      rmSync(dir, { recursive: true, force: true });
      for (const b of bares) rmSync(b, { recursive: true, force: true });
    },
  };
}
