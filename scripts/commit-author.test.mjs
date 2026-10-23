// rovo が作る commit の作者の静的な検査（node:test。外部 I/O なし）。
// `<名前>@users.noreply.github.com` は、GitHub がその名前のアカウントの commit とみなす形式。
// 他人のアカウントに結び付けないよう、id の付いた bot の形（<数字>+<slug>[bot]@users.noreply.github.com）以外は書かない。
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const SKIP_DIRS = new Set(["node_modules", "dist", ".wrangler", ".git", "coverage", "fixtures"]);
const EXT = /\.(ts|tsx|mjs|js|sh|json|toml)$/;

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue;
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) walk(p, out);
    else if (EXT.test(name) && p !== fileURLToPath(import.meta.url)) out.push(p);
  }
  return out;
}

const files = ["apps", "packages", "scripts"].flatMap((d) => walk(join(root, d)));
const BOT_FORM = /^(\d+|\$\{[^}]+\}|<[^>]+>)\+(\$\{[^}]+\}|<[^>]+>|[A-Za-z0-9-]+)\[bot\]$/;
const NOREPLY = /([^\s"'`@]*)@users\.noreply\.github\.com/g;

describe("commit の作者", () => {
  it("ソースを走査できている", () => {
    assert.ok(files.length > 50);
  });

  it("@users.noreply.github.com は <数字>+<slug>[bot] の形だけ（id の無い形は他人のアカウントに結び付く）", () => {
    const bad = [];
    for (const f of files) {
      const text = readFileSync(f, "utf8");
      for (const m of text.matchAll(NOREPLY)) {
        // テンプレート（${id}+${slug}[bot]）か、数字+slug[bot] だけを許す
        if (m[1] !== "" && !BOT_FORM.test(m[1])) {
          bad.push(`${relative(root, f)}: ${m[0]}`);
        }
      }
    }
    assert.deepEqual(bad, []);
  });

  it("代わりの作者は noreply.invalid（RFC 2606 の予約）で、gateway と agent の両方にある", () => {
    for (const f of ["apps/gateway/src/github/app.ts", "apps/agent/src/tools/context.ts"]) {
      assert.match(readFileSync(join(root, f), "utf8"), /rovo@noreply\.invalid/, f);
    }
  });
});
