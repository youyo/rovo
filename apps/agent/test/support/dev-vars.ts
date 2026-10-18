import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";

/** 自分が書いた .dev.vars の印。残骸（前回が異常終了した）かどうかの判定に使う。 */
export const DEV_VARS_MARKER = "# rovo-e2e-generated (安全に削除できる一時ファイル)";
export const DEV_VARS_BACKUP_SUFFIX = ".rovo-e2e-backup";

/**
 * 前回の起動が異常終了して残した状態を直す。
 * - 退避ファイルがあれば、元の .dev.vars として戻す（途中の書き換えは捨てる）
 * - 退避ファイルが無く、.dev.vars が自分の印つきなら（元は無かった）削除する
 */
export function recoverDevVars(file: string): void {
  const backup = `${file}${DEV_VARS_BACKUP_SUFFIX}`;
  if (existsSync(backup)) {
    renameSync(backup, file);
    return;
  }
  if (existsSync(file) && readFileSync(file, "utf8").startsWith(DEV_VARS_MARKER)) {
    rmSync(file, { force: true });
  }
}

/**
 * file に vars を書く。元の .dev.vars があれば退避ファイルへ rename する（rename は原子的）。
 * 戻り値は復元関数（何度呼んでもよい）。起動時に recoverDevVars を先に呼ぶ。
 */
export function writeDevVars(file: string, vars: Record<string, string>): () => void {
  recoverDevVars(file);
  const backup = `${file}${DEV_VARS_BACKUP_SUFFIX}`;
  if (existsSync(file)) renameSync(file, backup);
  writeFileSync(
    file,
    `${DEV_VARS_MARKER}\n${Object.entries(vars)
      .map(([k, v]) => `${k}=${v}`)
      .join("\n")}\n`,
  );
  let restored = false;
  return () => {
    if (restored) return;
    restored = true;
    rmSync(file, { force: true });
    if (existsSync(backup)) renameSync(backup, file);
  };
}
