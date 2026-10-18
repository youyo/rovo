import { type ChildProcess, spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TestProject } from "vitest/node";

declare module "vitest" {
  export interface ProvidedContext {
    baseUrl: string;
  }
}

const GATEWAY_DIR = join(import.meta.dirname, "..", "..");

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

async function waitUntilReady(baseUrl: string, child: ChildProcess, logs: string[]) {
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`wrangler dev が終了しました (code=${child.exitCode})\n${logs.join("")}`);
    }
    try {
      const res = await fetch(`${baseUrl}/.well-known/oauth-authorization-server`);
      if (res.ok) return;
    } catch {
      // まだ起動中
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(`wrangler dev の起動がタイムアウトしました\n${logs.join("")}`);
}

export default async function setup(project: TestProject) {
  const port = await freePort();
  const inspectorPort = await freePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const persistDir = mkdtempSync(join(tmpdir(), "rovo-e2e-"));
  const wranglerBin = join(GATEWAY_DIR, "node_modules", "wrangler", "bin", "wrangler.js");

  const logs: string[] = [];
  const child = spawn(
    process.execPath,
    [
      wranglerBin,
      "dev",
      "--ip",
      "127.0.0.1",
      "--port",
      String(port),
      "--inspector-port",
      String(inspectorPort),
      "--var",
      "ENVIRONMENT:test",
      "--var",
      `PUBLIC_BASE_URL:${baseUrl}`,
      "--persist-to",
      persistDir,
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
  const debug = process.env.E2E_DEBUG === "1"; // wrangler dev の出力をそのまま表示する
  const collect = (d: unknown) => {
    logs.push(String(d));
    if (debug) process.stderr.write(String(d));
  };
  child.stdout?.on("data", collect);
  child.stderr?.on("data", collect);

  try {
    await waitUntilReady(baseUrl, child, logs);
  } catch (error) {
    stop(child);
    rmSync(persistDir, { recursive: true, force: true });
    throw error;
  }

  project.provide("baseUrl", baseUrl);

  return async () => {
    stop(child);
    await new Promise((r) => setTimeout(r, 300));
    rmSync(persistDir, { recursive: true, force: true });
  };
}

function stop(child: ChildProcess) {
  if (child.pid === undefined) return;
  try {
    process.kill(-child.pid, "SIGTERM");
  } catch {
    // 既に終了している
  }
}
