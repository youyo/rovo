import { type ChildProcess, spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TestProject } from "vitest/node";
import { type FakeGitHub, startFakeGitHub } from "../fake-github/server";

declare module "vitest" {
  export interface ProvidedContext {
    baseUrl: string;
    githubUrl: string;
  }
}

const GATEWAY_DIR = join(import.meta.dirname, "..", "..");
// AGENT_DO（script_name: rovo-agent）の相手になる偽の agent Worker。
const FAKE_AGENT_CONFIG = join("test", "support", "fake-agent-worker", "wrangler.jsonc");

/** テスト用の固定値（実在の secret ではない）。 */
const ALLOWED_ORG = "acme";
const ALLOWED_TEAM = "core";
const TOKEN_ENC_KEY = Buffer.alloc(32, 7).toString("base64");

const READY_DEADLINE_MS = 90_000;
const READY_FETCH_TIMEOUT_MS = 2_000;
const CLOSE_GRACE_MS = 5_000;
const KILL_CONFIRM_MS = 3_000;

function freePort(): Promise<number> {
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

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitUntilReady(baseUrl: string, child: ChildProcess, logs: string[]) {
  const deadline = Date.now() + READY_DEADLINE_MS;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`wrangler dev が終了しました (code=${child.exitCode})\n${logs.join("")}`);
    }
    const remaining = deadline - Date.now();
    try {
      // 応答しない接続で待ち続けない（残り時間と 2 秒の短い方）
      const res = await fetch(`${baseUrl}/.well-known/oauth-authorization-server`, {
        signal: AbortSignal.timeout(Math.max(1, Math.min(remaining, READY_FETCH_TIMEOUT_MS))),
      });
      if (res.ok) {
        await res.body?.cancel();
        return;
      }
      await res.body?.cancel(); // 非成功でも body を解放する
    } catch {
      // まだ起動中（接続拒否・タイムアウト）
    }
    await sleep(300);
  }
  throw new Error(`wrangler dev の起動がタイムアウトしました\n${logs.join("")}`);
}

function signalGroup(pid: number, signal: NodeJS.Signals | 0): boolean {
  try {
    process.kill(-pid, signal);
    return true;
  } catch {
    return false; // 既に存在しない
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

/**
 * wrangler dev（とその子プロセス）を止める。SIGTERM で終了を待ち、期限を超えたらプロセスグループへ
 * SIGKILL して、いなくなるまで確認する。
 */
async function stopProcessGroup(child: ChildProcess): Promise<void> {
  const pid = child.pid;
  if (pid === undefined) return;
  if (!signalGroup(pid, "SIGTERM")) return;
  if (await groupGone(pid, CLOSE_GRACE_MS)) return;
  signalGroup(pid, "SIGKILL");
  await groupGone(pid, KILL_CONFIRM_MS);
}

export default async function setup(project: TestProject) {
  const resources: {
    github?: FakeGitHub;
    child?: ChildProcess;
    persistDir?: string;
  } = {};

  // 起動失敗と通常終了で同じ後始末を使う。個別の失敗が他の後始末を止めないようにする。
  let cleaned = false;
  async function cleanup() {
    if (cleaned) return;
    cleaned = true;
    if (resources.child) await stopProcessGroup(resources.child).catch(() => {});
    if (resources.github) await resources.github.stop().catch(() => {});
    // プロセスの終了を確認した後に消す
    if (resources.persistDir) {
      rmSync(resources.persistDir, { recursive: true, force: true });
    }
  }

  try {
    const github = await startFakeGitHub();
    resources.github = github;

    const port = await freePort();
    const inspectorPort = await freePort();
    const baseUrl = `http://127.0.0.1:${port}`;
    resources.persistDir = mkdtempSync(join(tmpdir(), "rovo-e2e-"));
    const wranglerBin = join(GATEWAY_DIR, "node_modules", "wrangler", "bin", "wrangler.js");

    // .dev.vars があっても結果が変わらないよう、必要な値はすべて --var で明示する
    const vars: Record<string, string> = {
      ENVIRONMENT: "test",
      PUBLIC_BASE_URL: baseUrl,
      GITHUB_OAUTH_BASE: github.url,
      GITHUB_API_BASE: github.url,
      GITHUB_APP_CLIENT_ID: github.clientId,
      GITHUB_APP_CLIENT_SECRET: github.clientSecret,
      ALLOWED_ORG,
      ALLOWED_TEAM,
      TOKEN_ENC_KEY,
    };
    const varArgs = Object.entries(vars).flatMap(([k, v]) => ["--var", `${k}:${v}`]);

    const logs: string[] = [];
    const child = spawn(
      process.execPath,
      [
        wranglerBin,
        "dev",
        // gateway と、AGENT_DO の相手になる偽の agent Worker（script_name 付きのバインディングを解決するため）
        "-c",
        "wrangler.jsonc",
        "-c",
        FAKE_AGENT_CONFIG,
        "--ip",
        "127.0.0.1",
        "--port",
        String(port),
        "--inspector-port",
        String(inspectorPort),
        ...varArgs,
        "--persist-to",
        resources.persistDir,
        "--log-level",
        "warn",
      ],
      {
        cwd: GATEWAY_DIR,
        env: { ...process.env, WRANGLER_SEND_METRICS: "false", CI: "1" },
        stdio: ["ignore", "pipe", "pipe"],
        detached: true,
      },
    );
    resources.child = child;
    const debug = process.env.E2E_DEBUG === "1"; // wrangler dev の出力をそのまま表示する
    const collect = (d: unknown) => {
      logs.push(String(d));
      if (debug) process.stderr.write(String(d));
    };
    child.stdout?.on("data", collect);
    child.stderr?.on("data", collect);

    await waitUntilReady(baseUrl, child, logs);

    project.provide("baseUrl", baseUrl);
    project.provide("githubUrl", github.url);
  } catch (error) {
    await cleanup();
    throw error;
  }

  return cleanup;
}
