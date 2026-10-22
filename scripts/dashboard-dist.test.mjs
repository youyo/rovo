// dashboard のビルド成果物（apps/dashboard/dist）の検査。build:dashboard のあとに走らせる（mise の test:dashboard:dist）。
// CSP（style-src 'self' など）と、/dashboard/ 配下での配信（Vite の base）が崩れていないことを固定する。
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { test } from "node:test";

const dist = join(import.meta.dirname, "..", "apps", "dashboard", "dist");

function walk(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)],
  );
}

const files = walk(dist);
const html = readFileSync(join(dist, "index.html"), "utf8");

// dist 全体の容量の上限（M1 の実測は数十 KB。フォントの同梱〔M6b〕までは小さく保つ）
const MAX_TOTAL_BYTES = 400 * 1024;

test("index.html が dist 直下にある（assets のパスは dist 直下から。Worker が /dashboard を剥がして渡す）", () => {
  assert.ok(statSync(join(dist, "index.html")).isFile());
  assert.ok(files.some((f) => relative(dist, f).startsWith("assets/")));
  // dist/dashboard/ のディレクトリは掘らない（D11 の (i)）
  assert.ok(!files.some((f) => relative(dist, f).startsWith("dashboard/")));
});

test("HTML が参照するファイルは /dashboard/assets/ 配下の絶対パス（Vite の base）", () => {
  const refs = [...html.matchAll(/(?:src|href)="([^"]+)"/g)].map((m) => m[1]);
  assert.ok(refs.length > 0);
  for (const ref of refs) {
    assert.match(ref, /^\/dashboard\/assets\//, `参照が /dashboard/assets/ 配下ではない: ${ref}`);
  }
});

test("HTML に <style 要素と style 属性が無い（CSP の style-src 'self'）", () => {
  assert.doesNotMatch(html, /<style/i);
  assert.doesNotMatch(html, /\sstyle=/i);
});

test("HTML にインラインのスクリプトが無い（CSP の script-src 'self'）", () => {
  for (const m of html.matchAll(/<script\b([^>]*)>/gi)) {
    assert.match(m[1], /\ssrc="/, `src の無い script: ${m[0]}`);
  }
});

test("dist のどのファイルにも外部ホストへの参照が無い", () => {
  for (const f of files) {
    if (!/\.(html|js|css)$/.test(f)) continue;
    const text = readFileSync(f, "utf8");
    // React DOM の名前空間の識別子（www.w3.org）とエラー案内の URL（react.dev）は文字列として出るだけで、取得はしない
    const urls = [...text.matchAll(/https?:\/\/[^\s"'`)\\]+/g)]
      .map((m) => m[0])
      .filter((u) => !/^https?:\/\/(react\.dev|reactjs\.org|www\.w3\.org)\//.test(u))
      // Cloudflare の枠の「開く」リンク（href のトップだけ。アカウント ID を含まない固定の URL）
      .filter((u) => u !== "https://dash.cloudflare.com/");
    assert.deepEqual(urls, [], `${relative(dist, f)} に外部 URL: ${urls.join(", ")}`);
  }
});

test("CSS に @import と外部の url() が無い（フォントの外部読み込みをしない）", () => {
  for (const f of files.filter((f) => f.endsWith(".css"))) {
    const css = readFileSync(f, "utf8");
    assert.doesNotMatch(css, /@import/i, `${relative(dist, f)} に @import`);
    for (const m of css.matchAll(/url\(\s*["']?([^"')\s]+)/gi)) {
      assert.doesNotMatch(m[1], /^(https?:)?\/\//i, `${relative(dist, f)} に外部の url(): ${m[1]}`);
    }
  }
});

test("HTML に外部の <link>（Google Fonts など）が無い", () => {
  for (const m of html.matchAll(/<link\b[^>]*>/gi)) {
    assert.doesNotMatch(m[0], /href="(https?:)?\/\//i, `外部の link: ${m[0]}`);
  }
});

test("JS に style 属性を文字列で組み立てる箇所が無い（位置は SVG の属性と CSS のクラスで渡す）", () => {
  for (const f of files.filter((f) => f.endsWith(".js"))) {
    const js = readFileSync(f, "utf8");
    assert.doesNotMatch(js, /\sstyle=["']/, `${relative(dist, f)} に style= の文字列`);
  }
});

test("dist の容量が上限以内", () => {
  const total = files.reduce((n, f) => n + statSync(f).size, 0);
  assert.ok(total <= MAX_TOTAL_BYTES, `dist が ${total} バイト（上限 ${MAX_TOTAL_BYTES}）`);
});
