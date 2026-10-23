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

// 容量の上限は 2 つに分ける。書体（woff2）は和文が大きい（IBM Plex Sans JP は 1 太さで約 2.3MB の分割ファイル。400 と 700 の woff2 で約 4.7MB）が、
// ブラウザは unicode-range で使う文字を含む分割だけを読む。JS/CSS/HTML の上限（M1 の実測は数十 KB）を緩めると
// アプリ本体の肥大に気づけなくなるので、書体は別枠の上限にして、書体以外の上限は据え置く。
const MAX_APP_BYTES = 400 * 1024;
const MAX_FONT_BYTES = 6 * 1024 * 1024;
const isFont = (f) => /\.(woff2?|ttf|otf)$/i.test(f);

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

// CSS の @font-face の宣言（unicode-range で分割した和文だけで数百ブロック）も書体の枠に数える
const FONT_FACE_RE = /@font-face\s*\{[^}]*\}/g;
const fontFaceBytes = files
  .filter((f) => f.endsWith(".css"))
  .reduce(
    (n, f) =>
      n +
      (readFileSync(f, "utf8").match(FONT_FACE_RE) ?? []).reduce(
        (m, b) => m + Buffer.byteLength(b),
        0,
      ),
    0,
  );
const fileBytes = (list) => list.reduce((n, f) => n + statSync(f).size, 0);

test("書体以外の容量が上限以内（書体と @font-face は別枠）", () => {
  const total = fileBytes(files.filter((f) => !isFont(f))) - fontFaceBytes;
  assert.ok(total <= MAX_APP_BYTES, `書体以外が ${total} バイト（上限 ${MAX_APP_BYTES}）`);
});

test("書体の容量（woff2 と @font-face）が別枠の上限以内", () => {
  const total = fileBytes(files.filter(isFont)) + fontFaceBytes;
  assert.ok(fileBytes(files.filter(isFont)) > 0, "書体が同梱されていない");
  assert.ok(total <= MAX_FONT_BYTES, `書体が ${total} バイト（上限 ${MAX_FONT_BYTES}）`);
});

const css = files
  .filter((f) => f.endsWith(".css"))
  .map((f) => readFileSync(f, "utf8"))
  .join("\n");

test("書体は IBM Plex Sans JP（本文。400 と 700）と JetBrains Mono（ログ・コマンド・数字。400 と 700）。font-display: swap。旧い書体は外した", () => {
  const faces = [...css.matchAll(/@font-face\s*\{[^}]*\}/g)].map((m) => m[0]);
  for (const family of ["IBM Plex Sans JP", "JetBrains Mono"]) {
    for (const w of [400, 700]) {
      const hit = faces.filter(
        (b) =>
          new RegExp(`font-family:\\s*["']?${family}["']?`).test(b) &&
          new RegExp(`font-weight:\\s*${w}\\b`).test(b),
      );
      assert.ok(hit.length > 0, `${family} ${w} の @font-face が無い`);
      for (const b of hit) assert.match(b, /font-display:\s*swap/, `${family} ${w} が swap でない`);
    }
  }
  for (const old of ["M PLUS 1 Code", "Familjen Grotesk", "Zen Kaku Gothic New"]) {
    assert.ok(!faces.some((b) => b.includes(old)), `${old} の @font-face が残っている`);
  }
});

test("和文は unicode-range で分割されている（使う範囲だけブラウザが読む）", () => {
  const plex = [...css.matchAll(/@font-face\s*\{[^}]*IBM Plex Sans JP[^}]*\}/g)].map((m) => m[0]);
  assert.ok(plex.length >= 100, `IBM Plex Sans JP の分割が少ない: ${plex.length}`);
  for (const b of plex) assert.match(b, /unicode-range:/);
});

test("書体は woff2 だけで、/dashboard/assets/ 配下の同一オリジンから読まれる", () => {
  assert.ok(!files.some((f) => /\.(woff|ttf|otf)$/i.test(f)), "woff2 以外の書体が入っている");
  for (const m of css.matchAll(/url\(\s*["']?([^"')\s]+)/gi)) {
    assert.match(m[1], /^\/dashboard\/assets\/[A-Za-z0-9._-]+\.woff2$/, `font の参照: ${m[1]}`);
  }
});

test("書体は data: に埋め込まない（CSP の font-src 'self'）", () => {
  assert.doesNotMatch(css, /url\(\s*["']?data:/i);
});

test("書体の OFL のライセンスを同梱している", () => {
  for (const name of ["IBM-Plex-Sans-JP", "JetBrains-Mono"]) {
    const path = join(dist, "assets", "licenses", `OFL-${name}.txt`);
    const text = readFileSync(path, "utf8");
    assert.match(text, /SIL OPEN FONT LICENSE Version 1\.1/);
    assert.match(text, /Copyright/);
  }
  // 外した書体のライセンスは残さない
  for (const name of ["M-PLUS-1-Code", "Familjen-Grotesk", "Zen-Kaku-Gothic-New"]) {
    assert.ok(
      !files.some((f) => f.endsWith(`OFL-${name}.txt`)),
      `${name} のライセンスが残っている`,
    );
  }
});
