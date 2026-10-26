// GitHub App の manifest フロー（github-app.mjs）の純粋な部分。ネットワーク・ファイルには触れない。
import { randomBytes, timingSafeEqual } from "node:crypto";

/** GitHub App の名前の上限（GitHub は 34 文字まで） */
const NAME_MAX = 34;

/**
 * 既定の App 名: rovo-<namePrefix>-<短い乱数>。GitHub 全体で一意なので乱数を付ける。
 * @param {string} namePrefix
 */
export function defaultAppName(namePrefix) {
  const suffix = randomBytes(4).toString("hex").slice(0, 6);
  const room = NAME_MAX - "rovo-".length - 1 - suffix.length;
  const prefix = String(namePrefix || "rovo")
    .slice(0, room)
    .replace(/-+$/, "");
  return `rovo-${prefix}-${suffix}`;
}

/**
 * GitHub App manifest（docs/deploy.md の 6 の設定）。Webhook は使わない（active: false）。
 * @param {{name: string, publicBaseUrl: string, redirectUrl: string, members: boolean}} o
 */
export function buildManifest({ name, publicBaseUrl, redirectUrl, members }) {
  // checks / statuses の read は任意: あると task_pr_merge が PR の head の check（check run と commit status）の結果を確かめる。
  // 無くてもマージは止まらず、応答の warnings に checks_unreadable が入る
  const permissions = {
    contents: "write",
    pull_requests: "write",
    metadata: "read",
    checks: "read",
    statuses: "read",
  };
  // org の Members: read は allowed.org（+ team）で所属を確かめるときだけ。org 単独も team も同じ権限
  if (members) permissions.members = "read";
  return {
    name,
    url: publicBaseUrl,
    redirect_url: redirectUrl,
    callback_urls: [`${publicBaseUrl}/callback`],
    request_oauth_on_install: false,
    public: false,
    hook_attributes: { url: publicBaseUrl, active: false },
    default_permissions: permissions,
    default_events: [],
    setup_on_update: false,
  };
}

/** CSRF 用の state（128 ビット以上の乱数）。 */
export function newState() {
  return randomBytes(24).toString("hex");
}

/** state の照合（一定時間）。空・欠けは常に不一致。 */
export function stateMatches(expected, actual) {
  if (typeof expected !== "string" || typeof actual !== "string" || expected === "") return false;
  const a = Buffer.from(expected);
  const b = Buffer.from(actual);
  return a.length === b.length && timingSafeEqual(a, b);
}

const GITHUB_APP_RE = /("githubApp"\s*:\s*)\{[^{}]*\}/;

/**
 * rovo.config.json の文字列の githubApp だけを書き換える（ほかの整形・順序・コメント代わりの空白を保つ）。
 * 書き換えた結果が「元の JSON の githubApp だけを差し替えたもの」と一致しなければ例外にする（何も書かない側に倒す）。
 * @param {string} text
 * @param {{id: string, clientId: string}} app
 */
export function updateConfigText(text, app) {
  const before = JSON.parse(text);
  const value = { id: String(app.id), clientId: String(app.clientId) };
  let out;
  const m = GITHUB_APP_RE.exec(text);
  if (m) {
    const body = m[0].slice(m[1].length);
    let obj;
    if (body.includes("\n")) {
      const inner = /\n([ \t]+)"/.exec(body)?.[1] ?? "  ";
      const close = /\n([ \t]*)\}$/.exec(body)?.[1] ?? "";
      obj = `{\n${inner}"id": ${JSON.stringify(value.id)},\n${inner}"clientId": ${JSON.stringify(value.clientId)}\n${close}}`;
    } else {
      obj = `{ "id": ${JSON.stringify(value.id)}, "clientId": ${JSON.stringify(value.clientId)} }`;
    }
    out = text.slice(0, m.index) + m[1] + obj + text.slice(m.index + m[0].length);
  } else {
    const last = text.lastIndexOf("}");
    if (last < 0) throw new Error("トップレベルの } が見つからない");
    const indent = /\n([ \t]+)"/.exec(text)?.[1] ?? "  ";
    const head = text.slice(0, last).trimEnd();
    out = `${head},\n${indent}"githubApp": { "id": ${JSON.stringify(value.id)}, "clientId": ${JSON.stringify(value.clientId)} }\n${text.slice(last)}`;
  }
  const after = JSON.parse(out);
  const expected = { ...before, githubApp: value };
  if (JSON.stringify(sortKeys(after)) !== JSON.stringify(sortKeys(expected))) {
    throw new Error("githubApp 以外が変わってしまう（整形を保てない）");
  }
  return out;
}

function sortKeys(v) {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === "object")
    return Object.fromEntries(
      Object.keys(v)
        .sort()
        .map((k) => [k, sortKeys(v[k])]),
    );
  return v;
}

const escapeHtml = (s) =>
  String(s)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");

/** 手元の開始ページ。manifest を入れたフォームを GitHub に POST する（state は action のクエリ）。 */
export function renderStartPage({ action, manifest, owner }) {
  return `<!doctype html>
<html lang="ja"><head><meta charset="utf-8"><title>rovo: GitHub App を作る</title></head>
<body>
<h1>GitHub App を作る</h1>
<p>作成先: ${escapeHtml(owner)}。GitHub の画面で「Create GitHub App」を押してください。</p>
<form id="f" method="post" action="${escapeHtml(action)}">
<input type="hidden" name="manifest" value="${escapeHtml(JSON.stringify(manifest))}">
<button type="submit">GitHub に進む</button>
</form>
<script>document.getElementById("f").submit();</script>
</body></html>
`;
}

/** 戻りのページ（利用者に見せる）。 */
export function renderDonePage(message) {
  return `<!doctype html>
<html lang="ja"><head><meta charset="utf-8"><title>rovo</title></head>
<body><p>${escapeHtml(message)}</p></body></html>
`;
}
