import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DEV_VARS_BACKUP_SUFFIX, recoverDevVars, writeDevVars } from "../support/dev-vars";
import { acquireLock } from "../support/docker-lock";
import { createE2eLog } from "../support/e2e-log";

// E2E の起動補助（Docker は使わない）。異常終了の後始末とロックの奪取を確かめる。
const dirs: string[] = [];
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), "rovo-support-"));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe(".dev.vars の退避と復元", () => {
  it("元の .dev.vars を退避して書き、復元関数で戻す", () => {
    const file = join(tmp(), ".dev.vars");
    writeFileSync(file, "SECRET=1\n");
    const restore = writeDevVars(file, { ENVIRONMENT: "test" });
    expect(readFileSync(file, "utf8")).toContain("ENVIRONMENT=test");
    expect(readFileSync(`${file}${DEV_VARS_BACKUP_SUFFIX}`, "utf8")).toBe("SECRET=1\n");
    restore();
    restore(); // 冪等
    expect(readFileSync(file, "utf8")).toBe("SECRET=1\n");
    expect(existsSync(`${file}${DEV_VARS_BACKUP_SUFFIX}`)).toBe(false);
  });

  it("元が無ければ、復元で消える", () => {
    const file = join(tmp(), ".dev.vars");
    const restore = writeDevVars(file, { ENVIRONMENT: "test" });
    restore();
    expect(existsSync(file)).toBe(false);
  });

  it("前回が異常終了して残した書き換えと退避は、次の起動で元に戻してから始まる", () => {
    const file = join(tmp(), ".dev.vars");
    writeFileSync(file, "SECRET=1\n");
    writeDevVars(file, { ENVIRONMENT: "test" }); // 復元せずに「落ちた」
    recoverDevVars(file);
    expect(readFileSync(file, "utf8")).toBe("SECRET=1\n");
    // 二重に書き換えても元の内容を失わない（退避を上書きしない）
    writeDevVars(file, { ENVIRONMENT: "test" });
    const restore = writeDevVars(file, { ENVIRONMENT: "test", A: "1" });
    restore();
    expect(readFileSync(file, "utf8")).toBe("SECRET=1\n");
  });

  it("元が無く、残骸だけ（印つき）なら削除する", () => {
    const file = join(tmp(), ".dev.vars");
    writeDevVars(file, { ENVIRONMENT: "test" });
    recoverDevVars(file);
    expect(existsSync(file)).toBe(false);
  });

  it("ユーザー自身の .dev.vars（印なし・退避なし）は触らない", () => {
    const file = join(tmp(), ".dev.vars");
    writeFileSync(file, "MINE=1\n");
    recoverDevVars(file);
    expect(readFileSync(file, "utf8")).toBe("MINE=1\n");
  });
});

describe("排他ロック", () => {
  it("持ち主が死んだロックは奪える", async () => {
    const lock = join(tmp(), "lock");
    mkdirSync(lock);
    writeFileSync(join(lock, "pid"), "2147483646"); // 存在しない pid
    const release = await acquireLock(lock, 5_000);
    expect(readFileSync(join(lock, "pid"), "utf8")).toBe(String(process.pid));
    release();
    expect(existsSync(lock)).toBe(false);
  });

  it("生きている持ち主のロックは奪わず、期限で諦める", async () => {
    const lock = join(tmp(), "lock");
    const release = await acquireLock(lock, 1_000);
    await expect(acquireLock(lock, 1_500)).rejects.toThrow(/ロックを取得できません/);
    expect(readFileSync(join(lock, "pid"), "utf8")).toBe(String(process.pid));
    release();
  });

  it("死んだ持ち主のロックを複数が同時に奪おうとしても、取れるのは 1 つだけ", async () => {
    const lock = join(tmp(), "lock");
    mkdirSync(lock);
    writeFileSync(join(lock, "pid"), "2147483646");
    const results = await Promise.allSettled(
      Array.from({ length: 4 }, () => acquireLock(lock, 1_500)),
    );
    const won = results.filter((r) => r.status === "fulfilled");
    expect(won).toHaveLength(1);
    for (const r of won) if (r.status === "fulfilled") r.value();
  });
});

describe("E2E の診断ログ", () => {
  it("ログは root 配下のタイムスタンプ付きディレクトリに作られ、timed は成功した段階の所要時間を timing.log に追記する", async () => {
    const root = tmp();
    const log = createE2eLog({ root, debug: false });
    expect(log.dir.startsWith(`${root}/`)).toBe(true);
    expect(await log.timed("exec", async () => 42)).toBe(42);
    const text = readFileSync(join(log.dir, "timing.log"), "utf8");
    expect(text).toMatch(/exec ok \d+ms/);
  });

  it("失敗した段階も所要時間つきで記録し、例外はそのまま伝える", async () => {
    const log = createE2eLog({ root: tmp(), debug: false });
    await expect(
      log.timed("ensureReady", async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(readFileSync(join(log.dir, "timing.log"), "utf8")).toMatch(
      /ensureReady failed \d+ms: boom/,
    );
  });

  it("wrangler の出力は、テストを流した場所の外（log.dir）のファイルに追記される", () => {
    const log = createE2eLog({ root: tmp(), debug: false });
    const w = log.wranglerLog("agent");
    w.write("line 1\n");
    w.write("line 2\n");
    expect(w.path.startsWith(`${log.dir}/`)).toBe(true);
    expect(readFileSync(w.path, "utf8")).toBe("line 1\nline 2\n");
    // 同名でも別ファイルになる（上書きしない）
    expect(log.wranglerLog("agent").path).not.toBe(w.path);
  });

  it("古いログのディレクトリは新しい keep 個だけ残して消す", () => {
    const root = tmp();
    for (const n of ["2020-01-01", "2020-01-02", "2020-01-03"]) mkdirSync(join(root, n));
    const log = createE2eLog({ root, debug: false, keep: 2 });
    expect(existsSync(join(root, "2020-01-01"))).toBe(false);
    expect(existsSync(join(root, "2020-01-02"))).toBe(false);
    expect(existsSync(join(root, "2020-01-03"))).toBe(true);
    expect(existsSync(log.dir)).toBe(true);
  });
});
