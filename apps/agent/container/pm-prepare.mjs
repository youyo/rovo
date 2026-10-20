#!/usr/bin/env node
// pnpm / yarn の本体を、corepack のキャッシュ（COREPACK_HOME）に用意する。コンテナのイメージに入れて使う。
//
// なぜ要るか: pnpm 11 以降の wrapper は、native バイナリ（約 44MB）を「初回の実行時」に Node の組み込み fetch
// （undici）で取る。外向き通信の中継（応答のあとに接続を閉じる）越しに大きな本体を、書き込みの遅い消費側で
// 受けると、Node 24 の undici が `assert(!this.paused)`（Parser.finish）で落ちる。npm（make-fetch-happen。
// undici を使わない）や git（curl）は影響を受けない。そこで本体は、実行時に fetch させず、npm の経路で取って
// corepack の置き場所に先に置く。
//
// 使い方: node pm-prepare.mjs <pnpm@12.14.0 のような spec | package.json のあるディレクトリ>
//   - ディレクトリのときは、その package.json の `packageManager` を読む（`+sha512...` は無視する）。
//   - pnpm と yarn の、版が完全に決まっているものだけが対象。それ以外（npm・範囲指定・未知）は何もしない。
// 終了コード: 0=用意できた（または対象外）/ 1=失敗（stderr に `pm-prepare: <固定コード>`）/ 2=使い方の誤り。
// 冪等: 用意済みなら corepack も npm も呼ばない。失敗しても壊れた状態は残さない（呼び出し側は失敗を無視してよい）。
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const MANAGERS = new Set(["pnpm", "yarn"]);
/** 完全に決まった版だけ（範囲・タグ・シェルに渡る文字は受け付けない） */
const VERSION = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/;
const ATTEMPTS = 3;
const RETRY_MS = Number(process.env.ROVO_PM_PREPARE_RETRY_MS ?? "1000");

class PrepareError extends Error {
  constructor(code, detail = "") {
    super(`pm-prepare: ${code}${detail ? ` (${detail.slice(-300)})` : ""}`);
  }
}

/** finally で後始末できるよう、exit せずに投げる（最上位で受けて終了コード 1 にする） */
function fail(code, detail = "") {
  throw new PrepareError(code, detail);
}

/** `pnpm@12.14.0+sha512.xxx` などから { name, version } を取り出す。対象外は null。 */
function parseSpec(raw) {
  if (typeof raw !== "string") return null;
  const at = raw.indexOf("@");
  if (at <= 0) return null;
  const name = raw.slice(0, at);
  const version = raw.slice(at + 1).split("+")[0];
  if (!MANAGERS.has(name) || !VERSION.test(version)) return null;
  return { name, version };
}

function specFromArg(arg) {
  if (/^[a-z]+@/.test(arg)) return parseSpec(arg);
  try {
    const pkg = JSON.parse(readFileSync(join(arg, "package.json"), "utf8"));
    return parseSpec(pkg.packageManager);
  } catch {
    return null;
  }
}

function sleep(ms) {
  if (ms > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** コマンドを最大 ATTEMPTS 回まで試す。成功したら true。失敗の出力は最後の分を返す。 */
function attempt(cmd, args) {
  let last = "";
  for (let i = 0; i < ATTEMPTS; i++) {
    if (i > 0) sleep(RETRY_MS);
    const r = spawnSync(cmd, args, { encoding: "utf8", maxBuffer: 8 * 1024 * 1024 });
    if (r.status === 0) return { ok: true, out: r.stdout };
    last = `${cmd} exit=${r.status} ${(r.stderr || r.stdout || String(r.error ?? "")).trim()}`;
  }
  return { ok: false, out: last };
}

const arg = process.argv[2];
if (!arg) {
  process.stderr.write("usage: pm-prepare.mjs <pnpm@x.y.z | yarn@x.y.z | directory>\n");
  process.exit(2);
}

try {
  await prepare(specFromArg(arg));
} catch (e) {
  process.stderr.write(`${e instanceof PrepareError ? e.message : `pm-prepare: failed (${e})`}\n`);
  process.exit(1);
}

async function prepare(spec) {
  if (!spec) return;

  const home = process.env.COREPACK_HOME || join(homedir(), ".cache", "node", "corepack");
  const dir = join(home, "v1", spec.name, spec.version);

  // 1) wrapper（小さい JS）を corepack のキャッシュへ。有効化（lastKnownGood の更新）はしない
  if (!existsSync(join(dir, ".corepack"))) {
    const r = attempt("corepack", [
      "install",
      "-g",
      "--cache-only",
      `${spec.name}@${spec.version}`,
    ]);
    if (!r.ok) fail("corepack_failed", r.out);
  }

  // 2) native バイナリを持つ wrapper（pnpm 11 以降）は、本体を npm の経路で取って pnpm-native に置く
  const target = join(dir, "pnpm-native");
  const nativeBinary = join(dir, "native-binary.mjs");
  if (existsSync(nativeBinary) && !existsSync(target)) {
    const mod = await import(pathToFileURL(nativeBinary).href).catch(() => null);
    const candidates = mod?.getBinCandidates?.() ?? [];
    if (candidates.length === 0) fail("native_unsupported", `${process.platform}-${process.arch}`);
    // wrapper の側が既に解決できるもの（node_modules に入っている）があれば、置かなくてよい
    if (mod.resolveInstalledBinary?.() != null) return;
    const { packageName, binFile } = mod.splitBinSpecifier(candidates[0]);
    const work = mkdtempSync(join(dir, ".pm-prepare-"));
    try {
      const packed = attempt("npm", [
        "pack",
        `${packageName}@${spec.version}`,
        "--pack-destination",
        work,
        "--silent",
        "--ignore-scripts",
        // npm のキャッシュ（取得した tarball が残る）をイメージや /root に残さない
        "--cache",
        join(work, "npm-cache"),
      ]);
      if (!packed.ok) fail("native_failed", packed.out);
      const tgz = readdirSync(work).find((f) => f.endsWith(".tgz"));
      if (!tgz) fail("native_failed", "no tarball");
      const x = spawnSync("tar", ["-xzf", join(work, tgz), "-C", work, `package/${binFile}`], {
        encoding: "utf8",
      });
      if (x.status !== 0) fail("native_failed", `tar exit=${x.status} ${x.stderr}`);
      const staged = join(work, "package", binFile);
      if (!existsSync(staged)) fail("native_failed", "binary not in tarball");
      chmodSync(staged, 0o755);
      // 同じディレクトリの中での rename（途中の状態を pnpm-native として見せない）
      const placed = join(dir, ".pm-prepare-native");
      rmSync(placed, { force: true });
      renameSync(staged, placed);
      renameSync(placed, target);
    } finally {
      rmSync(work, { recursive: true, force: true });
      mkdirSync(dir, { recursive: true });
    }
  }
}
