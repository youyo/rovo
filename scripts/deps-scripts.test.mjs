// 依存関係のキャッシュ（D14）のコンテナ内スクリプト（apps/agent/src/deps-scripts.ts）を、本物の bash で確かめる。
// 一時ディレクトリの中だけで動かす（Docker も Cloudflare も使わない）。
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import {
  DEPS_FETCH_SCRIPT,
  DEPS_RESTORE_SCRIPT,
  DEPS_STASH_SCRIPT,
} from "../apps/agent/src/deps-scripts.ts";

const roots = [];
function tmp() {
  const d = mkdtempSync(join(tmpdir(), "rovo-deps-"));
  roots.push(d);
  return d;
}
after(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

function run(script, name, ...args) {
  return spawnSync("bash", ["-c", script, name, ...args], { encoding: "utf8" });
}
const write = (p, c = "x") => {
  mkdirSync(join(p, ".."), { recursive: true });
  writeFileSync(p, c);
};

/** pnpm のモノレポに近い構成の作業ツリーを作る */
function monorepo() {
  const ws = tmp();
  write(join(ws, "package.json"), "{}");
  write(join(ws, "node_modules/.pnpm/a@1/node_modules/a/index.js"), "a");
  symlinkSync(".pnpm/a@1/node_modules/a", join(ws, "node_modules/a"));
  write(join(ws, "apps/web/package.json"), "{}");
  mkdirSync(join(ws, "apps/web/node_modules"), { recursive: true });
  symlinkSync(
    "../../../node_modules/.pnpm/a@1/node_modules/a",
    join(ws, "apps/web/node_modules/a"),
  );
  write(join(ws, "packages/x/node_modules/y/index.js"), "y");
  write(join(ws, ".git/node_modules/keep"), "git");
  return ws;
}

describe("DEPS_STASH_SCRIPT", () => {
  it("ルートと各パッケージの node_modules を作業ツリーの外へ移し、manifest に相対パスを書く", () => {
    const ws = monorepo();
    const cache = join(tmp(), "cache");
    const r = run(DEPS_STASH_SCRIPT, "rovo-deps-stash", ws, cache);
    assert.equal(r.status, 0, r.stderr);
    const manifest = readFileSync(join(cache, "manifest"), "utf8").trim().split("\n").sort();
    assert.deepEqual(manifest, [
      "apps/web/node_modules",
      "node_modules",
      "packages/x/node_modules",
    ]);
    assert.ok(!existsSync(join(ws, "node_modules")));
    assert.ok(!existsSync(join(ws, "apps/web/node_modules")));
    assert.ok(existsSync(join(cache, "nm/node_modules/.pnpm/a@1/node_modules/a/index.js")));
    assert.ok(existsSync(join(cache, "nm/packages/x/node_modules/y/index.js")));
    // .git の中は触らない。node_modules 以外のファイルも残る
    assert.ok(existsSync(join(ws, ".git/node_modules/keep")));
    assert.ok(existsSync(join(ws, "package.json")));
  });

  it("node_modules が 1 つも無くても成功し、manifest は空", () => {
    const ws = tmp();
    write(join(ws, "package.json"));
    const cache = join(tmp(), "cache");
    const r = run(DEPS_STASH_SCRIPT, "rovo-deps-stash", ws, cache);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(readFileSync(join(cache, "manifest"), "utf8"), "");
  });

  it("名前に改行を含むパスは拒否して失敗する", () => {
    const ws = tmp();
    write(join(ws, "a\nb/node_modules/x"));
    const cache = join(tmp(), "cache");
    const r = run(DEPS_STASH_SCRIPT, "rovo-deps-stash", ws, cache);
    assert.notEqual(r.status, 0);
  });
});

describe("DEPS_RESTORE_SCRIPT", () => {
  it("退避した node_modules を、clone 済みの作業ツリーの同じ相対位置へ戻す（シンボリックリンクも相対のまま有効）", () => {
    const src = monorepo();
    const cache = join(tmp(), "cache");
    assert.equal(run(DEPS_STASH_SCRIPT, "s", src, cache).status, 0);
    // clone し直した作業ツリー（node_modules は無い）
    const ws = tmp();
    write(join(ws, "package.json"), "{}");
    write(join(ws, "apps/web/package.json"), "{}");
    const r = run(DEPS_RESTORE_SCRIPT, "rovo-deps-restore", ws, cache);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(
      readFileSync(join(ws, "node_modules/.pnpm/a@1/node_modules/a/index.js"), "utf8"),
      "a",
    );
    assert.equal(readFileSync(join(ws, "packages/x/node_modules/y/index.js"), "utf8"), "y");
    const link = join(ws, "apps/web/node_modules/a");
    assert.ok(lstatSync(link).isSymbolicLink());
    assert.equal(readlinkSync(link), "../../../node_modules/.pnpm/a@1/node_modules/a");
    // リンク先が実在する（相対パスが同じ位置関係で解決できる）
    assert.ok(existsSync(join(link, "index.js")));
  });

  it("作業ツリーに同じ名前が既にあれば、その分は上書きせず戻さない", () => {
    const src = tmp();
    write(join(src, "node_modules/a/index.js"), "cached");
    const cache = join(tmp(), "cache");
    assert.equal(run(DEPS_STASH_SCRIPT, "s", src, cache).status, 0);
    const ws = tmp();
    write(join(ws, "node_modules/own.js"), "repo");
    const r = run(DEPS_RESTORE_SCRIPT, "rovo-deps-restore", ws, cache);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(readFileSync(join(ws, "node_modules/own.js"), "utf8"), "repo");
    assert.ok(!existsSync(join(ws, "node_modules/a/index.js")));
  });

  it("戻した node_modules を .git/info/exclude に足し、git status にも git add -A にも出ない（.gitignore が無くても）", () => {
    const src = tmp();
    write(join(src, "node_modules/a/index.js"), "a");
    write(join(src, "packages/x/node_modules/y/index.js"), "y");
    const cache = join(tmp(), "cache");
    assert.equal(run(DEPS_STASH_SCRIPT, "s", src, cache).status, 0);
    const ws = tmp();
    spawnSync("git", ["init", "-q"], { cwd: ws });
    write(join(ws, "package.json"), "{}");
    write(join(ws, "packages/x/package.json"), "{}");
    assert.equal(run(DEPS_RESTORE_SCRIPT, "rovo-deps-restore", ws, cache).status, 0);
    const exclude = readFileSync(join(ws, ".git/info/exclude"), "utf8");
    assert.match(exclude, /^\/node_modules\/$/m);
    assert.match(exclude, /^\/packages\/x\/node_modules\/$/m);
    const status = spawnSync("git", ["status", "--porcelain"], { cwd: ws, encoding: "utf8" });
    assert.ok(!status.stdout.includes("node_modules"), status.stdout);
    spawnSync("git", ["add", "-A"], { cwd: ws });
    const staged = spawnSync("git", ["diff", "--cached", "--name-only"], {
      cwd: ws,
      encoding: "utf8",
    });
    assert.ok(!staged.stdout.includes("node_modules"), staged.stdout);
    assert.ok(staged.stdout.includes("package.json"));
  });

  it(".git が無い作業ツリーでも復元は成功する（除外の追記はベストエフォート）", () => {
    const src = tmp();
    write(join(src, "node_modules/a/index.js"), "a");
    const cache = join(tmp(), "cache");
    assert.equal(run(DEPS_STASH_SCRIPT, "s", src, cache).status, 0);
    const ws = tmp();
    assert.equal(run(DEPS_RESTORE_SCRIPT, "rovo-deps-restore", ws, cache).status, 0);
    assert.ok(existsSync(join(ws, "node_modules/a/index.js")));
  });

  it("manifest が無ければ失敗する", () => {
    const r = run(DEPS_RESTORE_SCRIPT, "rovo-deps-restore", tmp(), join(tmp(), "none"));
    assert.equal(r.status, 1);
  });

  it("manifest に絶対パスや .. があれば、何も動かさず失敗する", () => {
    for (const bad of ["/etc", "../outside/node_modules", "a/../../x", ".."]) {
      const cache = tmp();
      mkdirSync(join(cache, "nm"), { recursive: true });
      writeFileSync(join(cache, "manifest"), `${bad}\n`);
      const outside = tmp();
      const ws = join(outside, "ws");
      mkdirSync(ws);
      const r = run(DEPS_RESTORE_SCRIPT, "rovo-deps-restore", ws, cache);
      assert.equal(r.status, 1, `bad=${bad}`);
    }
  });

  it("途中の mv が失敗したら、戻した分を消して失敗する", () => {
    const src = tmp();
    write(join(src, "a/node_modules/x/index.js"));
    write(join(src, "b/node_modules/y/index.js"));
    const cache = join(tmp(), "cache");
    assert.equal(run(DEPS_STASH_SCRIPT, "s", src, cache).status, 0);
    // 2 つ目（b）の退避先を消して、mv を失敗させる
    const order = readFileSync(join(cache, "manifest"), "utf8").trim().split("\n");
    rmSync(join(cache, "nm", order[1]), { recursive: true, force: true });
    const ws = tmp();
    const r = run(DEPS_RESTORE_SCRIPT, "rovo-deps-restore", ws, cache);
    assert.equal(r.status, 1);
    assert.ok(!existsSync(join(ws, order[0])), "戻した分は消す");
  });
});

describe("DEPS_FETCH_SCRIPT", () => {
  it("ローカルのリポジトリから、指定した SHA を --depth 1 で取り出す", () => {
    const origin = tmp();
    const git = (cwd, ...a) =>
      spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@e", ...a], {
        cwd,
        encoding: "utf8",
      });
    git(origin, "init", "-q", "-b", "main");
    write(join(origin, "package-lock.json"), "{}");
    git(origin, "add", "-A");
    git(origin, "commit", "-q", "-m", "one");
    const sha = git(origin, "rev-parse", "HEAD").stdout.trim();
    write(join(origin, "later.txt"), "later");
    git(origin, "add", "-A");
    git(origin, "commit", "-q", "-m", "two");
    const ws = join(tmp(), "workspace");
    mkdirSync(ws);
    write(join(ws, "stale.txt"), "stale");
    const r = run(DEPS_FETCH_SCRIPT, "rovo-deps-fetch", ws, `file://${origin}`, sha);
    assert.equal(r.status, 0, r.stderr);
    assert.ok(existsSync(join(ws, "package-lock.json")));
    assert.ok(!existsSync(join(ws, "later.txt")), "指定した SHA の内容だけ");
    assert.ok(!existsSync(join(ws, "stale.txt")), "既存のファイルは消す");
    const head = spawnSync("git", ["-C", ws, "rev-parse", "HEAD"], {
      encoding: "utf8",
    }).stdout.trim();
    assert.equal(head, sha);
  });

  it("取得に失敗したら失敗する", () => {
    const ws = tmp();
    const r = run(DEPS_FETCH_SCRIPT, "rovo-deps-fetch", ws, `file://${tmp()}`, "a".repeat(40));
    assert.notEqual(r.status, 0);
  });
});
