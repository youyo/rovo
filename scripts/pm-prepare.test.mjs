// コンテナ内の pnpm / yarn の用意スクリプト（apps/agent/container/pm-prepare.mjs）のテスト。
// 偽の corepack と偽の npm を PATH に置き、一時ディレクトリの中だけで動かす（Docker・ネットワークは使わない）。
// 確かめること: pnpm の本体（native バイナリ）を npm の経路で取って corepack のキャッシュに置くこと、
// 二度目は何もしないこと、取れなかったときに壊れた状態を残さないこと。
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const SCRIPT = fileURLToPath(new URL("../apps/agent/container/pm-prepare.mjs", import.meta.url));

const roots = [];
after(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

/**
 * 偽の環境を作る。
 * - corepack: `install -g --cache-only <name>@<ver>` で COREPACK_HOME/v1/<name>/<ver> に wrapper を作る
 *   （pnpm の wrapper は native-binary.mjs を持つ。yarn は持たない）。FAKE_COREPACK_FAIL=n なら最初の n 回は失敗する
 * - npm: `pack <pkg>@<ver> --pack-destination <dir>` で偽の tarball（package/pnpm）を作る。FAKE_NPM_FAIL=1 なら常に失敗
 * 呼び出しは calls.log に 1 行ずつ残る。
 */
function env() {
  const root = mkdtempSync(join(tmpdir(), "rovo-pm-"));
  roots.push(root);
  const bin = join(root, "bin");
  mkdirSync(bin);
  const home = join(root, "corepack");
  const log = join(root, "calls.log");
  writeFileSync(log, "");
  const sh = (name, body) => {
    writeFileSync(join(bin, name), `#!/bin/bash\n${body}\n`);
    chmodSync(join(bin, name), 0o755);
  };
  sh(
    "corepack",
    `
echo "corepack $*" >> "${log}"
n=$(grep -c '^corepack' "${log}")
if [ "\${FAKE_COREPACK_FAIL:-0}" -ge "$n" ]; then echo "boom" >&2; exit 1; fi
spec="\${@: -1}"; name="\${spec%@*}"; ver="\${spec#*@}"
d="$COREPACK_HOME/v1/$name/$ver"
mkdir -p "$d/bin"
echo '{}' > "$d/.corepack"
if [ "$name" = pnpm ]; then
  cat > "$d/native-binary.mjs" <<'EOF'
export const getBinCandidates = () => ["@pnpm/exe.fake-x64/pnpm", "@pnpm/exe.fake-x64-musl/pnpm"];
export const splitBinSpecifier = (s) => {
  const i = s.lastIndexOf("/");
  return { packageName: s.slice(0, i), binFile: s.slice(i + 1) };
};
export const resolveInstalledBinary = () => null;
EOF
fi
`,
  );
  sh(
    "npm",
    `
echo "npm $*" >> "${log}"
if [ -n "\${FAKE_NPM_FAIL:-}" ]; then echo "npm boom" >&2; exit 1; fi
[ "$1" = pack ] || exit 2
dest=""
while [ $# -gt 0 ]; do [ "$1" = "--pack-destination" ] && dest="$2"; shift; done
t=$(mktemp -d)
mkdir -p "$t/package"
printf '#!/bin/sh\\necho fake-pnpm\\n' > "$t/package/pnpm"
chmod 755 "$t/package/pnpm"
tar -czf "$dest/pnpm-exe.fake-x64-1.0.0.tgz" -C "$t" package
echo "pnpm-exe.fake-x64-1.0.0.tgz"
`,
  );
  return {
    root,
    home,
    log,
    run(args, extra = {}) {
      return spawnSync("node", [SCRIPT, ...args], {
        encoding: "utf8",
        env: {
          PATH: `${bin}:${process.env.PATH}`,
          HOME: root,
          COREPACK_HOME: home,
          ROVO_PM_PREPARE_RETRY_MS: "0",
          ...extra,
        },
      });
    },
    calls: () =>
      readFileSync(log, "utf8")
        .split("\n")
        .filter((l) => l !== ""),
    dir: (name, ver) => join(home, "v1", name, ver),
  };
}

const pkgDir = (root, packageManager) => {
  const d = join(root, "repo");
  mkdirSync(d, { recursive: true });
  writeFileSync(join(d, "package.json"), JSON.stringify({ name: "x", packageManager }));
  return d;
};

describe("pnpm（native バイナリを持つ版）", () => {
  it("wrapper を corepack のキャッシュに入れ、native バイナリは npm pack で取って pnpm-native に置く", () => {
    const e = env();
    const r = e.run(["pnpm@12.14.0"]);
    assert.equal(r.status, 0, r.stderr);
    const native = join(e.dir("pnpm", "12.14.0"), "pnpm-native");
    assert.ok(existsSync(native), "pnpm-native がある");
    assert.equal(statSync(native).mode & 0o111, 0o111, "実行できる");
    assert.equal(readFileSync(native, "utf8"), "#!/bin/sh\necho fake-pnpm\n");
    const calls = e.calls();
    assert.equal(calls[0], "corepack install -g --cache-only pnpm@12.14.0");
    assert.match(calls[1], /^npm pack @pnpm\/exe\.fake-x64@12\.14\.0 --pack-destination /);
    assert.match(calls[1], / --cache /, "npm のキャッシュを共有の場所に残さない");
    assert.equal(calls.length, 2);
  });

  it("一時ファイル（tarball・展開先）を残さない", () => {
    const e = env();
    assert.equal(e.run(["pnpm@12.14.0"]).status, 0);
    const left = readdirSync(e.dir("pnpm", "12.14.0")).filter((f) => f.startsWith(".pm-prepare"));
    assert.deepEqual(left, []);
  });

  it("二度目は corepack も npm も呼ばない（冪等）", () => {
    const e = env();
    assert.equal(e.run(["pnpm@12.14.0"]).status, 0);
    const before = e.calls().length;
    assert.equal(e.run(["pnpm@12.14.0"]).status, 0);
    assert.equal(e.calls().length, before);
  });

  it("wrapper だけ入っていて native が無いときは、npm だけを呼ぶ", () => {
    const e = env();
    assert.equal(e.run(["pnpm@12.14.0"]).status, 0);
    rmSync(join(e.dir("pnpm", "12.14.0"), "pnpm-native"));
    const before = e.calls().length;
    assert.equal(e.run(["pnpm@12.14.0"]).status, 0);
    const added = e.calls().slice(before);
    assert.equal(added.length, 1);
    assert.match(added[0], /^npm pack /);
  });
});

describe("入力", () => {
  it("ディレクトリを渡すと package.json の packageManager を読む（+sha512 は無視する）", () => {
    const e = env();
    const dir = pkgDir(e.root, "pnpm@12.14.0+sha512.abcdef");
    const r = e.run([dir]);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(e.calls()[0], "corepack install -g --cache-only pnpm@12.14.0");
  });

  it("yarn は wrapper だけを入れる（native バイナリを持たないので npm は呼ばない）", () => {
    const e = env();
    assert.equal(e.run(["yarn@1.22.22"]).status, 0);
    assert.deepEqual(e.calls(), ["corepack install -g --cache-only yarn@1.22.22"]);
  });

  it("npm・packageManager なし・package.json なし・範囲指定・未知のマネージャは何もしない（終了コード 0）", () => {
    const e = env();
    for (const arg of [
      "npm@10.0.0",
      "pnpm@^9",
      "pnpm@latest",
      "bun@1.0.0",
      "pnpm",
      "pnpm@1.0.0; rm -rf /",
      pkgDir(e.root, undefined),
      join(e.root, "nothing"),
    ]) {
      const r = e.run([arg]);
      assert.equal(r.status, 0, `${arg}: ${r.stderr}`);
    }
    assert.deepEqual(e.calls(), []);
  });

  it("引数なしは使い方を出して終了コード 2", () => {
    const e = env();
    assert.equal(e.run([]).status, 2);
  });
});

describe("失敗", () => {
  it("corepack が 1 回失敗しても、やり直して成功する", () => {
    const e = env();
    const r = e.run(["pnpm@12.14.0"], { FAKE_COREPACK_FAIL: "1" });
    assert.equal(r.status, 0, r.stderr);
    assert.ok(existsSync(join(e.dir("pnpm", "12.14.0"), "pnpm-native")));
  });

  it("npm が取れないときは終了コード 1 で、pnpm-native も一時ファイルも残さない", () => {
    const e = env();
    const r = e.run(["pnpm@12.14.0"], { FAKE_NPM_FAIL: "1" });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /pm-prepare: native_failed/);
    assert.ok(!existsSync(join(e.dir("pnpm", "12.14.0"), "pnpm-native")));
    const left = readdirSync(e.dir("pnpm", "12.14.0")).filter((f) => f.startsWith(".pm-prepare"));
    assert.deepEqual(left, []);
    assert.equal(e.calls().filter((c) => c.startsWith("npm ")).length, 3, "3 回まで試す");
  });

  it("corepack が取れないときは終了コード 1（npm は呼ばない）", () => {
    const e = env();
    const r = e.run(["pnpm@12.14.0"], { FAKE_COREPACK_FAIL: "99" });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /pm-prepare: corepack_failed/);
    assert.equal(e.calls().filter((c) => c.startsWith("npm ")).length, 0);
  });
});
