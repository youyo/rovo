// Sandbox の昇格の判断（Clef）に渡す「リポジトリの事実」を集めるスクリプト（apps/agent/src/container-scripts.ts の SCALE_FACTS_SCRIPT）を、
// 本物の node で確かめる。一時ディレクトリの中だけで動かす（Docker も Cloudflare も使わない）。
// このスクリプトは事実を集めるだけで、どのファイルが大事か・重いかの判断はしない（判断は Clef）。
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { SCALE_FACTS_SCRIPT } from "../apps/agent/src/container-scripts.ts";

const roots = [];
after(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

/** git のリポジトリのルート（.git のディレクトリがあるだけでよい）を作る */
function repo() {
  const ws = mkdtempSync(join(tmpdir(), "rovo-facts-"));
  roots.push(ws);
  mkdirSync(join(ws, ".git"));
  return ws;
}
const write = (ws, rel, content) => {
  const p = join(ws, rel);
  mkdirSync(join(p, ".."), { recursive: true });
  writeFileSync(p, content);
};
const facts = (cwd, max) =>
  spawnSync("node", ["-e", SCALE_FACTS_SCRIPT, cwd, ...(max ? [String(max)] : [])], {
    encoding: "utf8",
  });

describe("SCALE_FACTS_SCRIPT", () => {
  it("決まったファイルだけを、生のテキストのまま読む（無いファイルは飛ばす。.env など一覧に無いファイルは読まない）", () => {
    const ws = repo();
    write(ws, "vitest.config.ts", "export default { test: { maxWorkers: 4 } }\n");
    write(ws, "Makefile", "test:\n\tpytest -n auto\n");
    write(ws, ".env", "SECRET=1\n");
    write(ws, "README.md", "readme\n");
    const r = facts(ws);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /vitest\.config\.ts/);
    assert.match(r.stdout, /maxWorkers: 4/);
    assert.match(r.stdout, /pytest -n auto/);
    assert.doesNotMatch(r.stdout, /SECRET/);
    assert.doesNotMatch(r.stdout, /readme/);
  });

  it("package.json は packageManager / workspaces / scripts だけにする（依存の一覧で枠を使わない）", () => {
    const ws = repo();
    write(
      ws,
      "package.json",
      JSON.stringify({
        name: "x",
        packageManager: "pnpm@10.0.0",
        scripts: { test: "vitest run", build: "tsc -b" },
        dependencies: { lodash: "1.0.0" },
        devDependencies: { vitest: "3.0.0" },
      }),
    );
    const r = facts(ws);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /pnpm@10\.0\.0/);
    assert.match(r.stdout, /vitest run/);
    assert.doesNotMatch(r.stdout, /lodash/);
  });

  it("壊れた package.json は先頭を切り詰めて生で渡す", () => {
    const ws = repo();
    write(ws, "package.json", `{ "scripts": { "test": "jest" ${"x".repeat(5000)}`);
    const r = facts(ws);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /"test": "jest"/);
    assert.ok(r.stdout.length < 4000);
  });

  it("ロックファイルなどの有無（パッケージマネージャーの手がかり）を 1 行で出す", () => {
    const ws = repo();
    write(ws, "pnpm-lock.yaml", "lockfileVersion: 9\n");
    write(ws, "uv.lock", "");
    const r = facts(ws);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /files present[^\n]*pnpm-lock\.yaml/);
    assert.match(r.stdout, /files present[^\n]*uv\.lock/);
  });

  it("cwd とリポジトリのルートの両方から集める（モノレポのパッケージの中で走らせても、ルートの設定が見える）。重複しない", () => {
    const ws = repo();
    write(ws, "turbo.json", '{ "concurrency": "2" }\n');
    write(ws, "packages/a/vitest.config.ts", "export default {}\n");
    const r = facts(join(ws, "packages/a"));
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /turbo\.json/);
    assert.match(r.stdout, /vitest\.config\.ts/);
    const r2 = facts(ws);
    assert.equal((r2.stdout.match(/turbo\.json/g) ?? []).length, 1, r2.stdout);
  });

  it("1 ファイルの大きさと全体の大きさを切り詰める", () => {
    const ws = repo();
    write(ws, "Makefile", "a".repeat(20_000));
    write(ws, "Cargo.toml", "b".repeat(20_000));
    write(ws, "pyproject.toml", "c".repeat(20_000));
    write(ws, "turbo.json", "d".repeat(20_000));
    write(ws, "nx.json", "e".repeat(20_000));
    const r = facts(ws);
    assert.equal(r.status, 0, r.stderr);
    assert.ok(r.stdout.length <= 6000, String(r.stdout.length));
    assert.match(r.stdout, /turbo\.json/);
    const small = facts(ws, 2000);
    assert.ok(small.stdout.length <= 2000, String(small.stdout.length));
  });

  it("シンボリックリンクは辿らない（コンテナ内の別のファイルを読まない）", () => {
    const ws = repo();
    symlinkSync("/etc/hostname", join(ws, "Makefile"));
    const r = facts(ws);
    assert.equal(r.status, 0, r.stderr);
    assert.doesNotMatch(r.stdout, /Makefile/);
  });

  it("何も無いリポジトリでも成功し、空に近い出力になる。存在しない cwd でも成功する（事実が無いだけ）", () => {
    const ws = repo();
    const r = facts(ws);
    assert.equal(r.status, 0, r.stderr);
    assert.ok(r.stdout.length < 300);
    const missing = facts(join(ws, "nope"));
    assert.equal(missing.status, 0, missing.stderr);
  });
});
