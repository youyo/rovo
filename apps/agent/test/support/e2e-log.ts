import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * E2E の診断ログ。不安定さ（時々 120 秒のタイムアウトで落ちる）の原因を、後から追えるようにする。
 * - 主要な段階（ensureReady・exec・reaper・destroy など）の所要時間を timing.log に常に追記する
 *   （E2E_DEBUG=1 なら stderr にも出す）
 * - wrangler の出力は、テストを流した場所の外（$TMPDIR/rovo-e2e-logs/<タイムスタンプ>-xxxxxx/）のファイルに保存する
 * 保存先のルートは ROVO_E2E_LOG_DIR で変えられる。古いディレクトリは新しい keep 個だけ残して消す。
 */
export interface E2eLog {
  /** この起動のログディレクトリ */
  dir: string;
  /** 計測済みの所要時間をそのまま記録する */
  record(label: string, ms: number): void;
  /** fn の所要時間を timing.log に記録する（失敗も記録して再 throw する） */
  timed<T>(label: string, fn: () => Promise<T>): Promise<T>;
  /** wrangler の出力の保存先を作る。write は追記。 */
  wranglerLog(name: string): { path: string; write(chunk: string): void };
}

export interface E2eLogOptions {
  root?: string;
  debug?: boolean;
  keep?: number;
}

export function createE2eLog(opts: E2eLogOptions = {}): E2eLog {
  const root = opts.root ?? process.env.ROVO_E2E_LOG_DIR ?? join(tmpdir(), "rovo-e2e-logs");
  const debug = opts.debug ?? process.env.E2E_DEBUG === "1";
  const keep = opts.keep ?? 30;
  mkdirSync(root, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const dir = mkdtempSync(join(root, `${stamp}-`));
  // 新しい keep 個（今作った分を含む）だけ残す。名前はタイムスタンプ始まりなので、辞書順が時刻順
  try {
    const old = readdirSync(root).sort();
    for (const name of old.slice(0, Math.max(0, old.length - keep))) {
      rmSync(join(root, name), { recursive: true, force: true });
    }
  } catch {
    // 掃除の失敗でテストを止めない
  }
  const timingFile = join(dir, "timing.log");
  writeFileSync(timingFile, "");
  const line = (text: string) => {
    const out = `${new Date().toISOString()} ${text}\n`;
    try {
      appendFileSync(timingFile, out);
    } catch {
      // ログの失敗でテストを止めない
    }
    if (debug) process.stderr.write(`[e2e-timing] ${out}`);
  };
  const counts = new Map<string, number>();
  return {
    dir,
    record: (label, ms) => line(`${label} ok ${ms}ms`),
    async timed<T>(label: string, fn: () => Promise<T>): Promise<T> {
      const start = Date.now();
      try {
        const v = await fn();
        line(`${label} ok ${Date.now() - start}ms`);
        return v;
      } catch (e) {
        const msg = (e instanceof Error ? e.message : String(e)).split("\n")[0]?.slice(0, 200);
        line(`${label} failed ${Date.now() - start}ms: ${msg}`);
        throw e;
      }
    },
    wranglerLog(name: string) {
      const n = (counts.get(name) ?? 0) + 1;
      counts.set(name, n);
      const path = join(dir, `wrangler-${name}${n > 1 ? `-${n}` : ""}.log`);
      writeFileSync(path, "");
      return {
        path,
        write(chunk: string) {
          try {
            appendFileSync(path, chunk);
          } catch {
            // ログの失敗でテストを止めない
          }
        },
      };
    },
  };
}

let shared: E2eLog | undefined;
/** プロセス（= テストファイル）ごとに 1 つ。 */
export function e2eLog(): E2eLog {
  shared ??= createE2eLog();
  return shared;
}
