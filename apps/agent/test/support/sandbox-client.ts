import type { ExecResult } from "../../src/sandbox-port";

/** wrangler dev 上の E2E 用ルート（ENVIRONMENT=test のときだけ有効）経由で Sandbox を操作する。 */
export function sandboxClient(baseUrl: string, name: string) {
  const post = async (path: string, body: unknown) => {
    const res = await fetch(`${baseUrl}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(280_000),
    });
    if (!res.ok) throw new Error(`${path}: ${res.status} ${await res.text()}`);
    return res.json();
  };
  return {
    exec: (argv: string[], options: Record<string, unknown> = {}) =>
      post("/test/sandbox/exec", {
        name,
        argv,
        options: { timeoutMs: 60_000, ...options },
      }) as Promise<ExecResult>,
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
    stop: () => post("/test/sandbox/stop", { name }),
  };
}
