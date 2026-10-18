import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

function readOwner(lockDir: string): number {
  try {
    return Number.parseInt(readFileSync(join(lockDir, "pid"), "utf8"), 10);
  } catch {
    return Number.NaN; // 作成直後で pid が未記入
  }
}

/**
 * 持ち主が死んだロックを奪う。rmSync→mkdir では、確認と削除の間に別の起動が新しいロックを取りうる（TOCTOU）。
 * そこで rename（原子的）で脇へ動かし、動かしたものが確認した持ち主のものであることを見直す。
 * 別の持ち主のものを動かしてしまっていたら、元に戻す。
 */
function stealStale(lockDir: string, observedOwner: number): void {
  const aside = `${lockDir}.stale-${process.pid}-${Date.now()}`;
  try {
    renameSync(lockDir, aside);
  } catch {
    return; // 他の起動が先に奪った（または解放された）
  }
  const moved = readOwner(aside);
  if (moved !== observedOwner && Number.isFinite(moved) && pidAlive(moved)) {
    try {
      renameSync(aside, lockDir); // 生きている持ち主のロックを動かしてしまった。戻す
      return;
    } catch {
      // 戻せない（別の起動が新しく取った）。生きている持ち主の分は諦めて片付ける
    }
  }
  rmSync(aside, { recursive: true, force: true });
}

/**
 * プロセス間の排他ロック（ディレクトリの mkdir）。持ち主のプロセスが死んでいたら奪う。
 * 戻り値は解放関数（何度呼んでもよい）。
 */
export async function acquireLock(lockDir: string, timeoutMs: number): Promise<() => void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      mkdirSync(lockDir);
      writeFileSync(join(lockDir, "pid"), String(process.pid));
      break;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      const owner = readOwner(lockDir);
      if (Number.isFinite(owner) && !pidAlive(owner)) {
        stealStale(lockDir, owner);
        continue;
      }
      if (Date.now() > deadline) {
        throw new Error(`Docker E2E のロックを取得できません（持ち主 pid=${owner}）: ${lockDir}`);
      }
      await sleep(1_000);
    }
  }
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    process.off("exit", release);
    rmSync(lockDir, { recursive: true, force: true });
  };
  process.on("exit", release);
  return release;
}
