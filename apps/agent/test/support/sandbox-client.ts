import type { ExecResult, WorkspaceSpec } from "../../src/sandbox-port";

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
  const op = (path: string, body: Record<string, unknown> = {}) =>
    post(`/test/sandbox/${path}`, { name, ...body });
  return {
    name,
    ensureReady: (spec: WorkspaceSpec) => op("ensure-ready", { spec }) as Promise<{ ok: true }>,
    exec: (argv: string[], options: Record<string, unknown> = {}) =>
      op("exec", { argv, options: { timeoutMs: 60_000, ...options } }) as Promise<ExecResult>,
    readFile: (path: string) => op("read-file", { path }) as Promise<{ content: string }>,
    writeFile: (path: string, content: string) => op("write-file", { path, content }),
    stop: () => op("stop") as Promise<{ stopped: boolean }>,
    terminate: () => op("terminate") as Promise<{ stopped: boolean }>,
    /** コンテナだけを強制的に落とす（DO の状態は残す）。再起動の検証用。 */
    destroy: () => op("destroy"),
    /** 次に走る reaper を失敗させる（fail-closed の検証用）。 */
    failNextReap: () => op("fail-next-reap"),
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
