// Sandbox の昇格の作業ツリーの指紋（apps/agent/src/container-scripts.ts の PROMOTE_STATE_SCRIPT）を、本物の git と bash で確かめる。
// 一時ディレクトリの中だけで動かす（Docker も Cloudflare も使わない）。
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { PROMOTE_STATE_SCRIPT } from "../apps/agent/src/container-scripts.ts";

const roots = [];
after(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

const git = (cwd, ...args) =>
  spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", ...args], {
    cwd,
    encoding: "utf8",
  });

/** commit が 1 つある作業ツリー（追跡ファイル tracked.txt、.gitignore で ignored/ を除外） */
function repo() {
  const ws = mkdtempSync(join(tmpdir(), "rovo-promote-"));
  roots.push(ws);
  assert.equal(git(ws, "init", "-q").status, 0);
  writeFileSync(join(ws, "tracked.txt"), "tracked\n");
  writeFileSync(join(ws, ".gitignore"), "ignored/\n");
  assert.equal(git(ws, "add", ".").status, 0);
  assert.equal(git(ws, "commit", "-q", "-m", "init").status, 0);
  return ws;
}

const state = (ws) =>
  spawnSync("bash", ["-c", PROMOTE_STATE_SCRIPT, "rovo-promote-state", ws], { encoding: "utf8" });

describe("PROMOTE_STATE_SCRIPT", () => {
  it("追跡されていないファイルが 0 個でも成功し、同じ状態なら同じ出力", () => {
    const ws = repo();
    const a = state(ws);
    assert.equal(a.status, 0, a.stderr);
    assert.notEqual(a.stdout.trim(), "");
    assert.equal(state(ws).stdout, a.stdout);
  });

  it("追跡されていないファイルは、名前が同じで中身だけ違っても指紋が変わる", () => {
    const ws = repo();
    writeFileSync(join(ws, "new.txt"), "one\n");
    const a = state(ws);
    assert.equal(a.status, 0, a.stderr);
    writeFileSync(join(ws, "new.txt"), "two\n");
    const b = state(ws);
    assert.equal(b.status, 0, b.stderr);
    assert.notEqual(a.stdout, b.stdout);
  });

  it("ファイル名に空白・非 ASCII・改行があっても壊れず、中身の違いを検出する", () => {
    const ws = repo();
    mkdirSync(join(ws, "dir with space"));
    const names = ["dir with space/a b.txt", "日本語.txt", "line\nbreak.txt"];
    for (const n of names) writeFileSync(join(ws, n), "x\n");
    const a = state(ws);
    assert.equal(a.status, 0, a.stderr);
    writeFileSync(join(ws, "日本語.txt"), "y\n");
    const b = state(ws);
    assert.equal(b.status, 0, b.stderr);
    assert.notEqual(a.stdout, b.stdout);
  });

  it("gitignore 済みのファイルの中身は指紋に入れない", () => {
    const ws = repo();
    mkdirSync(join(ws, "ignored"));
    writeFileSync(join(ws, "ignored/build.js"), "one\n");
    const a = state(ws);
    writeFileSync(join(ws, "ignored/build.js"), "two\n");
    assert.equal(state(ws).stdout, a.stdout);
  });

  it("追跡ファイルの未 commit の変更でも指紋が変わる", () => {
    const ws = repo();
    const a = state(ws);
    writeFileSync(join(ws, "tracked.txt"), "changed\n");
    assert.notEqual(state(ws).stdout, a.stdout);
  });

  it("git が失敗したら（リポジトリでない）失敗する", () => {
    const dir = mkdtempSync(join(tmpdir(), "rovo-promote-none-"));
    roots.push(dir);
    assert.notEqual(state(dir).status, 0);
  });
});
