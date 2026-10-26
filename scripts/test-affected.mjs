// test:affected のエントリ。計画は test-affected-lib.mjs。
// 変更ファイル = `git diff --name-only <base>...HEAD` + 未コミット（staged / unstaged）+ 未追跡。
// 計画を表示してから順に `mise run <task>` を流し、最初の失敗で止まって非 0 で終わる。
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { formatPlan, parseArgs, planTests } from "./test-affected-lib.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

function git(args) {
  const r = spawnSync("git", ["-c", "core.quotepath=off", ...args], {
    cwd: root,
    encoding: "utf8",
  });
  return { ok: r.status === 0, out: r.stdout ?? "", err: r.stderr ?? "" };
}

const lines = (s) => s.split("\n").filter((l) => l !== "");

function fail(message) {
  console.error(`test:affected: ${message}`);
  process.exit(2);
}

let opts;
try {
  opts = parseArgs(process.argv.slice(2));
} catch (e) {
  fail(e.message);
}

let base = opts.base;
if (!base) {
  base = ["origin/main", "main"].find((ref) => git(["rev-parse", "--verify", "--quiet", ref]).ok);
  if (!base)
    fail("base が見つかりません（origin/main も main も無い）。--base <ref> で指定してください");
} else if (!git(["rev-parse", "--verify", "--quiet", base]).ok) {
  fail(`base が見つかりません: ${base}`);
}

const committed = git(["diff", "--name-only", `${base}...HEAD`]);
if (!committed.ok) fail(`git diff に失敗しました: ${committed.err.trim()}`);
const uncommitted = git(["diff", "--name-only", "HEAD"]);
if (!uncommitted.ok) fail(`git diff に失敗しました: ${uncommitted.err.trim()}`);
const untracked = git(["ls-files", "--others", "--exclude-standard"]);
if (!untracked.ok) fail(`git ls-files に失敗しました: ${untracked.err.trim()}`);

const changed = [
  ...new Set([...lines(committed.out), ...lines(uncommitted.out), ...lines(untracked.out)]),
].sort();
const plan = planTests(changed, { exists: (p) => existsSync(join(root, p)) });

console.log(`base: ${base}（変更 ${changed.length} ファイル）`);
for (const f of changed) console.log(`  ${f}`);
console.log("\n計画:");
console.log(formatPlan(plan));

if (opts.dryRun) process.exit(0);

for (const [i, step] of plan.entries()) {
  const cmd = ["mise", "run", step.task, ...(step.args ? ["--", ...step.args] : [])];
  console.log(`\n[${i + 1}/${plan.length}] ${cmd.join(" ")}`);
  const r = spawnSync(cmd[0], cmd.slice(1), { cwd: root, stdio: "inherit" });
  if (r.status !== 0) {
    console.error(
      `\ntest:affected: ${step.task} が失敗しました（終了コード ${r.status ?? r.signal}）。ここで止めます`,
    );
    process.exit(r.status || 1);
  }
}
console.log("\ntest:affected: すべて成功");
