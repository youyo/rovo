import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DEV_VARS_BACKUP_SUFFIX, recoverDevVars, writeDevVars } from "../support/dev-vars";
import { acquireLock } from "../support/docker-lock";

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
