import { DurableObject } from "cloudflare:workers";
import { Files } from "@cloudflare/sandbox";
import type { OutboundGatewayProps } from "./outbound-gateway";
import type { ExecOptions, ExecResult, SandboxPort } from "./sandbox-port";

const CA_CERT = "/etc/cloudflare/certs/cloudflare-containers-ca.crt";
/** HTTPS 傍受の CA を各ツールに信用させる。exec は PATH しか引き継がないので毎回渡す。 */
const BASE_ENV: Record<string, string> = {
  NODE_EXTRA_CA_CERTS: CA_CERT,
  GIT_SSL_CAINFO: CA_CERT,
  REQUESTS_CA_BUNDLE: CA_CERT,
  SSL_CERT_FILE: CA_CERT,
  HOME: "/workspace",
};
const DEFAULT_TIMEOUT_MS = 10 * 60_000;
const DEFAULT_MAX_OUTPUT = 64 * 1024;

export class SandboxDO extends DurableObject<Env> implements SandboxPort {
  private ready?: Promise<void>;

  /**
   * コンテナを（止まっていれば）起動し、外向き通信の傍受と CA の設定が終わるまで待つ。
   * すべての操作の前に通す。並行して呼ばれても、設定完了前に先へ進むことはない。
   */
  ensureRunning(props: OutboundGatewayProps = {}): Promise<void> {
    if (!this.ctx.container?.running) this.ready = undefined; // 止まった（落ちた）なら起動からやり直す
    this.ready ??= this.boot(props).catch((e) => {
      this.ready = undefined;
      throw e;
    });
    return this.ready;
  }

  private async boot(props: OutboundGatewayProps): Promise<void> {
    const container = this.ctx.container;
    if (!container) throw new Error("container binding is not configured");
    // DO だけが再起動してコンテナが生きている場合も、傍受は登録し直す（同じ宛先の再登録はハンドラを置き換える）
    if (!container.running) {
      container.start({
        image: container.images.workspace,
        enableInternet: false,
        env: BASE_ENV,
      });
    }
    const gateway = this.ctx.exports.OutboundGateway({ props });
    await container.interceptOutboundHttps("*", gateway);
    await container.interceptAllOutboundHttp(gateway);
    // 起動直後は exec が失敗しうるので、応答するまで待つ
    const deadline = Date.now() + 120_000;
    for (;;) {
      try {
        const p = await container.exec(["true"]);
        if ((await p.exitCode) === 0) return;
      } catch {
        // まだ起動中
      }
      if (Date.now() > deadline) throw new Error("container did not become ready");
      await new Promise((r) => setTimeout(r, 500));
    }
  }

  async exec(argv: string[], options: ExecOptions = {}): Promise<ExecResult> {
    await this.ensureRunning();
    const container = this.ctx.container as Container;
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const max = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT;
    // AbortSignal.timeout は exec では使えないので自前で AbortController を使う
    const ac = new AbortController();
    let timedOut = false;
    // proc.pid はコンテナ外から見た pid でグループ kill には使えない。
    // ラッパーが自分の pid（= setsid 後のプロセスグループ ID）をファイルに書き、timeout 時はそれを読んで kill する。
    const pidFile = `/tmp/rovo-exec-${crypto.randomUUID()}.pid`;
    const timer = setTimeout(() => {
      timedOut = true;
      // abort の SIGKILL は開始したプロセスにしか届かない。子孫まで止めるためグループごと kill する。
      void container
        .exec(["bash", "-c", `kill -KILL -- -"$(cat ${pidFile})"`])
        .then((p) => p.exitCode)
        .catch(() => {})
        .finally(() => ac.abort());
    }, timeoutMs);
    try {
      const proc = await container.exec(
        ["setsid", "-w", "bash", "-c", `echo $$ > ${pidFile}; exec "$@"`, "rovo-exec", ...argv],
        {
          cwd: options.cwd ?? "/workspace",
          env: { ...BASE_ENV, ...options.env },
          signal: ac.signal,
        },
      );
      const [out, err] = await Promise.all([
        readTail(proc.stdout ?? undefined, max),
        readTail(proc.stderr ?? undefined, max),
      ]);
      const exitCode = await proc.exitCode.catch(() => (timedOut ? 137 : -1));
      return {
        exitCode: timedOut ? 137 : exitCode,
        stdout: out.text,
        stderr: err.text,
        timedOut,
        truncated: out.truncated || err.truncated,
      };
    } finally {
      clearTimeout(timer);
    }
  }

  async readFile(path: string): Promise<string> {
    await this.ensureRunning();
    const res = await new Files(this.ctx.container as Container).readFile(path);
    return res.text();
  }

  async writeFile(path: string, content: string): Promise<void> {
    await this.ensureRunning();
    await new Files(this.ctx.container as Container).writeFile(path, content);
  }

  async stop(): Promise<void> {
    this.ready = undefined;
    if (this.ctx.container?.running) await this.ctx.container.destroy();
  }
}

/** stream を読み切り、末尾 max バイトだけ残す（全量をメモリに載せない）。 */
async function readTail(
  stream: ReadableStream<Uint8Array> | undefined,
  max: number,
): Promise<{ text: string; truncated: boolean }> {
  if (!stream) return { text: "", truncated: false };
  const chunks: Uint8Array[] = [];
  let size = 0;
  let truncated = false;
  const reader = stream.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    size += value.byteLength;
    while (size - (chunks[0]?.byteLength ?? 0) >= max && chunks.length > 1) {
      size -= chunks.shift()?.byteLength ?? 0;
      truncated = true;
    }
  }
  const all = new Uint8Array(size);
  let off = 0;
  for (const c of chunks) {
    all.set(c, off);
    off += c.byteLength;
  }
  if (all.byteLength > max) {
    truncated = true;
    return { text: new TextDecoder().decode(all.subarray(all.byteLength - max)), truncated };
  }
  return { text: new TextDecoder().decode(all), truncated };
}
