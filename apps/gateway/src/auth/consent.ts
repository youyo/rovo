import type { ConsentDescription } from "@cloudflare/workers-oauth-provider";

/** HTML に埋め込む値のエスケープ。client 由来の文字列（名前・URI・scope）はすべてここを通す。 */
const ENTITIES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
  "`": "&#96;",
};

export function escapeHtml(value: string): string {
  return value.replace(/[&<>"'`]/g, (c) => ENTITIES[c] ?? c);
}

/**
 * 同意画面の CSP。スクリプトは一切使わない（default-src 'none'）。
 * form-action は付けない: Chrome は form-action を POST 後の redirect 先にも適用するため、
 * 承認後の GitHub への redirect と、拒否時の client の redirect_uri への redirect を壊してしまう。
 * フォームの送信先は相対パスで固定し、base-uri 'none' で <base> による差し替えも封じている。
 */
export const CONSENT_CSP =
  "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'";

const STYLE = `
body{font:16px/1.5 system-ui,sans-serif;max-width:34rem;margin:2rem auto;padding:0 1rem;color:#1a1a1a;background:#fff}
@media (prefers-color-scheme:dark){body{color:#eee;background:#161616}.dest{background:#3a2e00;border-color:#d4a300}code{background:#2a2a2a}}
h1{font-size:1.25rem}
.dest{border:2px solid #b8860b;background:#fff4cc;padding:.75rem 1rem;border-radius:.5rem;margin:1rem 0}
.host{font-size:1.4rem;word-break:break-all}
code{background:#eee;padding:.1rem .3rem;border-radius:.25rem;word-break:break-all}
.warn{font-weight:bold}
button{font:inherit;padding:.6rem 1.4rem;margin-right:.5rem;border-radius:.4rem;border:1px solid #888;cursor:pointer}
button.ok{background:#1a56db;color:#fff;border-color:#1a56db}
`;

/** 同意画面の HTML。handle はライブラリが発行した 1 回限りの値（CSRF トークン相当）。 */
export function renderConsentPage(details: ConsentDescription, handle: string): string {
  const name = escapeHtml(details.clientName);
  const scopes = details.scope.length
    ? `<ul>${details.scope.map((s) => `<li><code>${escapeHtml(s)}</code></li>`).join("")}</ul>`
    : "<p>(追加の scope の指定なし)</p>";
  const origin = details.clientDomain
    ? `<p>公開元: <strong>${escapeHtml(details.clientDomain)}</strong></p>`
    : "<p>このアプリは自分で登録したもので、名前は検証されていません。</p>";
  const loopback = details.redirectIsLoopback
    ? '<p class="warn">この許可は、あなたのコンピューター上で動いているアプリに渡されます。いま自分でそのアプリからログインを始めた場合だけ続けてください。</p>'
    : "";
  return `<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex">
<title>rovo へのアクセス許可</title>
<style>${STYLE}</style>
</head>
<body>
<h1>「${name}」に、あなたの rovo タスクの作成・操作を許可しますか</h1>
<p>このアプリは、あなたの rovo のタスクを作成・確認・待機・キャンセルできるようになります。</p>
${origin}
<div class="dest">
<p>許可の結果（認可コード）は次のホストへ送られます:</p>
<p class="host"><strong>${escapeHtml(details.redirectHost)}</strong></p>
<p>リダイレクト先: <code>${escapeHtml(details.redirectUri)}</code></p>
</div>
${loopback}
<p>要求されている scope:</p>
${scopes}
<p>心当たりがない場合、または送り先のホストに見覚えがない場合は「拒否」を押してください。</p>
<form method="post" action="/authorize">
<input type="hidden" name="handle" value="${escapeHtml(handle)}">
<button class="ok" type="submit" name="decision" value="approve">承認する</button>
<button type="submit" name="decision" value="deny">拒否する</button>
</form>
</body>
</html>
`;
}
