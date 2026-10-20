// 偽のブラウザ（テスト用）。手元のページを開き、フォームの manifest を読み、利用者が「Create GitHub App」を押した代わりに
// redirect_url の /callback?code=…&state=… を叩く。GitHub には POST しない。
//   CLI: node fake-browser.mjs <URL>   環境変数: FAKE_BROWSER_LOG（記録先）/ FAKE_BROWSER_STATE（state を差し替える）/ FAKE_BROWSER_NOCALLBACK=1（戻らない）/ FAKE_BROWSER_CODE
import { appendFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const unescapeHtml = (s) =>
  s
    .replaceAll("&quot;", '"')
    .replaceAll("&#39;", "'")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&amp;", "&");

export async function visit(startUrl, opts = {}) {
  const log = opts.log ?? process.env.FAKE_BROWSER_LOG;
  const page = await (await fetch(startUrl)).text();
  const action = unescapeHtml(/<form[^>]*\saction="([^"]*)"/.exec(page)?.[1] ?? "");
  const method = /<form[^>]*\smethod="([^"]*)"/i.exec(page)?.[1] ?? "";
  const manifestText = unescapeHtml(
    /<input[^>]*name="manifest"[^>]*\svalue="([^"]*)"/.exec(page)?.[1] ?? "",
  );
  const manifest = JSON.parse(manifestText);
  const state = new URL(action).searchParams.get("state");
  if (log) appendFileSync(log, `${JSON.stringify({ action, method, manifest, state })}\n`);
  if (opts.noCallback ?? process.env.FAKE_BROWSER_NOCALLBACK) return { action, manifest, state };
  const useState = opts.state ?? process.env.FAKE_BROWSER_STATE ?? state;
  const code = opts.code ?? process.env.FAKE_BROWSER_CODE ?? "fake-code-123";
  const cb = new URL(manifest.redirect_url);
  if (useState !== null) cb.searchParams.set("state", useState);
  if (code !== "") cb.searchParams.set("code", code);
  const r = await fetch(cb);
  return { action, manifest, state, status: r.status, body: await r.text() };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    await visit(process.argv[2]);
  } catch (e) {
    console.error(`fake-browser: ${e.message}`);
    process.exit(1);
  }
}
