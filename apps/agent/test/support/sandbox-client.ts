import type { ExecResult, WorkspaceSpec } from "../../src/sandbox-port";
import { e2eLog } from "./e2e-log";
import { TEST_GIT_TOKEN } from "./fake-upstream";

/** wrangler dev 上の E2E 用ルート（ENVIRONMENT=test のときだけ有効）経由で Sandbox を操作する。 */
export function sandboxClient(baseUrl: string, name: string) {
  const post = async (path: string, body: unknown, timeoutMs = 280_000) => {
    const res = await fetch(`${baseUrl}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) throw new Error(`${path}: ${res.status} ${await res.text()}`);
    return res.json();
  };
  // 主要な段階の所要時間を残す（ensure-ready / exec / stop（reaper）/ terminate / destroy など。不安定さの切り分け用）
  const op = (path: string, body: Record<string, unknown> = {}) => {
    const argv = Array.isArray(body.argv) ? ` ${String(body.argv[0])}` : "";
    return e2eLog().timed(`sandbox ${name} ${path}${argv}`, () =>
      post(`/test/sandbox/${path}`, { name, ...body }),
    );
  };
  const setGitCredential = (credential: { token: string; expiresAt: number }) =>
    op("set-git-credential", { credential }) as Promise<{ ok: true }>;
  return {
    name,
    setGitCredential,
    /**
     * 既定では、偽 GitHub が要求するトークンを先に預けてから ensureReady する（clone にもトークンが要るため）。
     * `credential: null` ならトークンを預けない（トークン無しの挙動の検証用）。
     */
    async ensureReady(
      spec: WorkspaceSpec,
      opts: { credential?: { token: string; expiresAt: number } | null } = {},
    ) {
      const credential =
        opts.credential === undefined
          ? { token: TEST_GIT_TOKEN, expiresAt: Date.now() + 3_600_000 }
          : opts.credential;
      if (credential) await setGitCredential(credential);
      return op("ensure-ready", { spec }) as Promise<{ ok: true }>;
    },
    exec: (argv: string[], options: Record<string, unknown> = {}) =>
      op("exec", { argv, options: { timeoutMs: 60_000, ...options } }) as Promise<ExecResult>,
    readFile: (path: string) => op("read-file", { path }) as Promise<{ content: string }>,
    writeFile: (path: string, content: string) => op("write-file", { path, content }),
    stop: () => op("stop") as Promise<{ stopped: boolean }>,
    terminate: () => op("terminate") as Promise<{ stopped: boolean }>,
    /** コンテナだけを強制的に落とす（DO の状態は残す）。再起動の検証用。 */
    destroy: () => op("destroy"),
    /** 作業ブランチだけを持つ空の作業ツリーを仕込む（ensureReady がコンテナを起動した後。実ネットワーク E2E 用）。 */
    seedWorkspace: () => op("seed-workspace"),
    /** 次に走る reaper を失敗させる（fail-closed の検証用）。 */
    failNextReap: () => op("fail-next-reap"),
    /** 実行時間・作り直し・起動のやり直しのカウンタ（SandboxDO.metrics）。 */
    metrics: () =>
      op("metrics") as Promise<{ runtimeMs: number; restarts: number; bootRetries: number }>,
    /** この Sandbox（と、そのタスクの OutboundGateway）が出した監査イベント（ENVIRONMENT=test のときだけ）。 */
    audit: async () => ((await op("audit")) as { records: Record<string, unknown>[] }).records,
    status: () =>
      op("status") as Promise<{
        running: boolean;
        terminated: boolean;
        expired: boolean;
        hasSpec: boolean;
      }>,
    /** destroy してから ensureReady し直す（コンテナの再起動後も傍受が効くかの検証用）。 */
    async restart(spec: WorkspaceSpec) {
      await this.destroy();
      return this.ensureReady(spec);
    },
    /** curl でステータスコードだけ取る。接続が落ちたときは code 000 と curl の exitCode が返る。 */
    async curl(url: string, ...extra: string[]) {
      const r = await this.exec([
        "curl",
        "-sS",
        "-m",
        "10",
        "-o",
        "/dev/null",
        "-w",
        "%{http_code}",
        ...extra,
        url,
      ]);
      return { code: r.stdout.trim(), exitCode: r.exitCode, stderr: r.stderr };
    },
  };
}
