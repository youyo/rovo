// mise run github-app の本体。GitHub App を manifest フロー（公式）で作り、rovo.config.json と gateway の secret に反映する。
//   https://docs.github.com/en/apps/sharing-github-apps/registering-a-github-app-from-a-manifest
//
//   node scripts/github-app.mjs [--recreate] [--org <名前> | --personal] [--name <App 名>] [--no-deploy]
//     --recreate    githubApp が設定済みでも作り直す（古い App は GitHub の画面で削除する）
//     --org / --personal  作成先。既定は rovo.config.json の allowed.org（無ければ個人）
//     --name        App の名前（GitHub 全体で一意。既定 rovo-<namePrefix>-<乱数>）
//     --no-deploy   secret と設定の更新までで、deploy:config の再生成と gateway の再デプロイをしない
//
// 流れ: 127.0.0.1 のランダムなポートに一時のサーバー → ブラウザで手元のページ（manifest + state のフォーム）→
//   利用者が GitHub で「Create GitHub App」を押す → /callback?code&state に戻る → state を照合 →
//   POST /app-manifests/{code}/conversions（認証不要）→ secret を deploy.sh の標準入力で gateway に入れる →
//   rovo.config.json に id / clientId を書く → deploy:config（--no-terraform）→ gateway を再デプロイ → Install ページを開く。
// client_secret と pem はディスクに書かない（メモリ → deploy.sh の標準入力のパイプだけ）。webhook_secret は捨てる。
// 時間切れ・state の不一致・conversions の失敗は、何も書き込まずに止まる。
//
// 環境変数: ROVO_OPEN_CMD（URL を開くコマンド。既定は open / xdg-open）/ ROVO_CONFIG（既定 rovo.config.json）/ ROVO_DEPLOY_DIR（既定 deploy）/ ROVO_GITHUB_APP_TIMEOUT_MS（待つ時間。既定 15 分）/
//   ROVO_GITHUB_URL・ROVO_GITHUB_API_URL（テスト用の差し替え。https か loopback の http だけ）
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadTemplates, validateConfig } from "./deploy-config-lib.mjs";
import {
  buildManifest,
  defaultAppName,
  newState,
  renderDonePage,
  renderStartPage,
  stateMatches,
  updateConfigText,
} from "./github-app-lib.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const fail = (msg) => {
  console.error(`エラー: ${msg}`);
  process.exit(1);
};

// ---- 引数 ---------------------------------------------------------------------
const argv = process.argv.slice(2);
const opts = { recreate: false, personal: false, org: "", name: "", deploy: true };
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  const val = () => {
    if (i + 1 >= argv.length || argv[i + 1].startsWith("--")) fail(`${a} には値が要る`);
    return argv[++i];
  };
  if (a === "--recreate") opts.recreate = true;
  else if (a === "--personal") opts.personal = true;
  else if (a === "--no-deploy") opts.deploy = false;
  else if (a === "--org") opts.org = val();
  else if (a === "--name") opts.name = val();
  else
    fail(
      `未知のオプション: ${a}（使えるのは --recreate / --org <名前> / --personal / --name <名前> / --no-deploy）`,
    );
}
if (opts.personal && opts.org) fail("--org と --personal は同時に使えない");
if (opts.org && !/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/.test(opts.org))
  fail(`--org の名前が不正: ${opts.org}`);
if (opts.name && !/^[\w .-]{1,34}$/.test(opts.name))
  fail("--name は 34 文字以内の英数字・空白・-_. にする");

// ---- 設定の読み込み -------------------------------------------------------------
const configPath = resolve(process.env.ROVO_CONFIG || "rovo.config.json");
const deployDir = resolve(process.env.ROVO_DEPLOY_DIR || "deploy");
if (!existsSync(configPath)) fail(`設定ファイルが無い: ${configPath}`);
let configText;
let raw;
try {
  configText = readFileSync(configPath, "utf8");
  raw = JSON.parse(configText);
} catch (e) {
  fail(`${configPath} を JSON として読めない: ${e.message}`);
}
const { config, errors, githubAppConfigured } = validateConfig(raw, loadTemplates());
if (errors.length > 0) {
  console.error(`エラー: ${configPath} が不正:`);
  for (const e of errors) console.error(`  - ${e}`);
  process.exit(1);
}

if (githubAppConfigured && !opts.recreate) {
  console.log(
    `GitHub App は設定済み（App ID ${config.githubApp.id}）。何もしない。作り直すなら mise run github-app -- --recreate（古い App は GitHub の画面で削除する）`,
  );
  process.exit(0);
}

// ---- GitHub の URL（テスト用の差し替えは https か loopback の http だけ） -----------
function baseUrl(envName, fallback) {
  const v = process.env[envName];
  if (!v) return fallback;
  let u;
  try {
    u = new URL(v);
  } catch {
    fail(`${envName} が URL ではない`);
  }
  const loop = ["127.0.0.1", "localhost", "[::1]"].includes(u.hostname);
  if (!(u.protocol === "https:" || (u.protocol === "http:" && loop)))
    fail(`${envName} は https か loopback の http にする`);
  return v.replace(/\/+$/, "");
}
const githubWeb = baseUrl("ROVO_GITHUB_URL", "https://github.com");
const githubApi = baseUrl("ROVO_GITHUB_API_URL", "https://api.github.com");

// ---- 事前の確認（ブラウザを開く前に。ここで失敗したら何も起きない） --------------------
const gatewayCfg = join(deployDir, "gateway.wrangler.jsonc");
if (!existsSync(gatewayCfg)) {
  fail(
    `${gatewayCfg} が無い。secret を入れる gateway の設定が要る（先に mise run setup、または deploy:config → deploy:all）`,
  );
}
const timeoutMs = Number(process.env.ROVO_GITHUB_APP_TIMEOUT_MS || 15 * 60 * 1000);
const owner = opts.personal ? "" : opts.org || config.allowed.org;
const ownerLabel = owner ? `組織 ${owner}` : "個人アカウント";
const settingsBase = owner
  ? `${githubWeb}/organizations/${owner}/settings/apps`
  : `${githubWeb}/settings/apps`;

// ---- 一時のサーバー -------------------------------------------------------------
const state = newState();
const appName = opts.name || defaultAppName(config.namePrefix);
let manifest;
let port;
let finish;
let abort;
const callback = new Promise((res, rej) => {
  finish = res;
  abort = rej;
});

const server = createServer((req, res) => {
  const u = new URL(req.url ?? "/", "http://127.0.0.1");
  const sendPage = (status, html) => {
    res.writeHead(status, {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "referrer-policy": "no-referrer",
    });
    res.end(html);
  };
  // DNS rebinding 対策: Host は 127.0.0.1:<port> だけ
  if (req.headers.host !== `127.0.0.1:${port}` || req.method !== "GET") {
    sendPage(400, renderDonePage("不正なリクエスト"));
    return;
  }
  if (u.pathname === "/start") {
    const action = `${settingsBase}/new?state=${state}`;
    sendPage(200, renderStartPage({ action, manifest, owner: ownerLabel }));
    return;
  }
  if (u.pathname === "/callback") {
    const code = u.searchParams.get("code");
    if (!stateMatches(state, u.searchParams.get("state"))) {
      sendPage(400, renderDonePage("state が一致しない。ターミナルを確認してください。"));
      abort(
        new Error(
          "callback の state が一致しない（別の経路から叩かれた可能性がある）。何も書き込まずに止めた",
        ),
      );
      return;
    }
    if (!code || !/^[A-Za-z0-9_-]{1,200}$/.test(code)) {
      sendPage(400, renderDonePage("code が無い。ターミナルを確認してください。"));
      abort(new Error("callback に code が無い（または形式が不正）。何も書き込まずに止めた"));
      return;
    }
    sendPage(
      200,
      renderDonePage(
        "GitHub App を作成しています。ターミナルに戻ってください。このタブは閉じてよい。",
      ),
    );
    finish(code);
    return;
  }
  sendPage(404, renderDonePage("not found"));
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
port = server.address().port;
manifest = buildManifest({
  name: appName,
  publicBaseUrl: config.publicBaseUrl,
  redirectUrl: `http://127.0.0.1:${port}/callback`,
  team: config.allowed.team !== "",
});
const closeServer = () => {
  server.closeAllConnections?.();
  server.close();
};

// ---- ブラウザを開く -------------------------------------------------------------
function openUrl(url) {
  const cmd = process.env.ROVO_OPEN_CMD || (process.platform === "darwin" ? "open" : "xdg-open");
  const r = spawnSync(cmd, [url], { stdio: "ignore" });
  return !r.error && r.status === 0;
}
const startUrl = `http://127.0.0.1:${port}/start`;
console.log(`==> GitHub App を作る（作成先: ${ownerLabel}、名前: ${appName}）`);
if (openUrl(startUrl)) {
  console.log(`  ブラウザで開いた: ${startUrl}`);
  console.log("  GitHub の画面で「Create GitHub App」を押す。（開かなければこの URL を開く）");
} else {
  console.log(`  ブラウザを開けなかった。次の URL を自分で開く: ${startUrl}`);
  console.log("  GitHub の画面で「Create GitHub App」を押す。");
}
console.log(
  `  待つ時間: ${Math.round(timeoutMs / 60000)} 分（manifest の code は 1 時間で失効する）`,
);

let timer;
let code;
try {
  code = await Promise.race([
    callback,
    new Promise((_, rej) => {
      timer = setTimeout(
        () =>
          rej(
            new Error(
              `時間切れ: ${Math.round(timeoutMs / 1000)} 秒待ったが GitHub から戻ってこなかった。何も書き込んでいない。もう一度実行する`,
            ),
          ),
        timeoutMs,
      );
    }),
  ]);
} catch (e) {
  clearTimeout(timer);
  closeServer();
  fail(e.message);
}
clearTimeout(timer);
closeServer();

// ---- conversions（認証不要） ------------------------------------------------------
let app;
try {
  const r = await fetch(`${githubApi}/app-manifests/${encodeURIComponent(code)}/conversions`, {
    method: "POST",
    headers: {
      accept: "application/vnd.github+json",
      "x-github-api-version": "2022-11-28",
      "user-agent": "rovo-github-app",
    },
    signal: AbortSignal.timeout(30_000),
  });
  let body = null;
  try {
    body = await r.json();
  } catch {}
  if (r.status !== 201) {
    // 応答の message だけを出す（値は出さない）
    const msg = typeof body?.message === "string" ? `: ${body.message.slice(0, 200)}` : "";
    throw new Error(`GitHub の conversions が失敗した（HTTP ${r.status}${msg}）`);
  }
  const ok =
    body &&
    /^\d+$/.test(String(body.id)) &&
    typeof body.slug === "string" &&
    /^[A-Za-z0-9-]+$/.test(body.slug) &&
    typeof body.client_id === "string" &&
    body.client_id !== "" &&
    typeof body.client_secret === "string" &&
    body.client_secret !== "" &&
    typeof body.pem === "string" &&
    body.pem.includes("PRIVATE KEY");
  if (!ok)
    throw new Error(
      "GitHub の conversions の応答に id / slug / client_id / client_secret / pem のどれかが無い",
    );
  app = {
    id: String(body.id),
    slug: body.slug,
    clientId: body.client_id,
    clientSecret: body.client_secret,
    pem: body.pem,
  };
} catch (e) {
  fail(
    `${e.message}。何も書き込んでいない。もう一度実行する（作られた App があれば GitHub の画面で削除する）`,
  );
}

// ---- secret を gateway に入れる（標準入力のパイプだけ） -----------------------------
const childEnv = { ...process.env, ROVO_DEPLOY_DIR: deployDir };
// env の CLOUDFLARE_API_TOKEN は Terraform 用。wrangler には渡さない（setup.sh と同じ）
delete childEnv.CLOUDFLARE_API_TOKEN;
console.log("==> GitHub App の secret を gateway に入れる（標準入力。ディスクには書かない）");
const put = spawnSync("bash", [join(root, "scripts/deploy.sh"), "secrets", "--github-app-stdin"], {
  input: JSON.stringify({ clientSecret: app.clientSecret, privateKey: app.pem }),
  env: childEnv,
  stdio: ["pipe", "inherit", "inherit"],
});
if (put.status !== 0) {
  fail(
    `secret を入れられなかった。rovo.config.json は変えていない。GitHub App「${app.slug}」は作られている（${settingsBase}/${app.slug} で削除して、もう一度実行する。client secret と秘密鍵は保存していないので、この App は使えない）`,
  );
}

// ---- rovo.config.json を更新 -------------------------------------------------------
try {
  const next = updateConfigText(configText, { id: app.id, clientId: app.clientId });
  const tmp = `${configPath}.tmp-${process.pid}`;
  writeFileSync(tmp, next);
  renameSync(tmp, configPath);
} catch (e) {
  fail(
    `rovo.config.json を更新できなかった（${e.message}）。secret は入っている。githubApp に id "${app.id}" と clientId "${app.clientId}" を手で書く`,
  );
}
console.log(
  `==> rovo.config.json の githubApp を更新した（id: ${app.id}、clientId: ${app.clientId}）`,
);

// ---- 設定の再生成と gateway の再デプロイ ----------------------------------------------
if (opts.deploy) {
  if (!existsSync(join(deployDir, "infra.json"))) {
    console.log(
      "  deploy/infra.json が無いので、再生成と再デプロイは飛ばす。mise run deploy:config → deploy:gateway を実行する",
    );
  } else {
    console.log(
      "==> deploy:config（GITHUB_APP_ID / GITHUB_APP_CLIENT_ID を反映）→ gateway を再デプロイ",
    );
    const gen = spawnSync(
      process.execPath,
      [join(root, "scripts/deploy-config.mjs"), "generate", "--no-terraform"],
      {
        env: { ...childEnv, ROVO_CONFIG: configPath },
        stdio: "inherit",
      },
    );
    const dep =
      gen.status === 0
        ? spawnSync("bash", [join(root, "scripts/deploy.sh"), "gateway"], {
            env: childEnv,
            stdio: "inherit",
          })
        : gen;
    if (dep.status !== 0) {
      fail(
        "再生成か gateway の再デプロイに失敗した。secret と rovo.config.json は更新済み。mise run deploy:config -- --no-terraform と mise run deploy:gateway をやり直す",
      );
    }
  }
}

// ---- 残りの作業の案内 ------------------------------------------------------------------
const installUrl = `${githubWeb}/apps/${app.slug}/installations/new`;
console.log(`
==> GitHub App「${app.slug}」を作った。残りはブラウザの作業
[1] Install: 対象の org / リポジトリに App を入れる（開く: ${installUrl}）
[2] ユーザートークンの期限（確認）: ${settingsBase}/${app.slug} の「Optional features」で
    User-to-server token expiration（Expire user authorization tokens）が有効なことを確かめる。manifest では指定できない。
    無効でも動く（有効だとトークンは 8 時間で切れ、refresh token で更新される）`);
if (!openUrl(installUrl))
  console.log(`  Install のページを開けなかった。自分で開く: ${installUrl}`);
