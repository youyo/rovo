// mise run byok -- <anthropic|openai> の本体。AI Gateway にプロバイダーのキー（BYOK、alias は default）を登録する。
//   node scripts/byok.mjs <anthropic|openai> [--yes]
//     --yes  既に default のキーがあるときの上書きの確認を省く
//
// POST /accounts/{accountId}/ai-gateway/gateways/{ai_gateway_id}/provider_configs
//   body { provider_slug, alias: "default", default_config: true, secret }
//   既に default があれば PUT .../provider_configs/{id}（Rotate）。上書きする前に確認する。
// accountId は rovo.config.json、ai_gateway_id は deploy/infra.json（terraform output）、認証は env の CLOUDFLARE_API_TOKEN（Terraform 用）。
// キーは表示されない入力（TTY の echo を切る）か、TTY でなければ標準入力の 1 行で受け取る。
//   引数・env・ログ・ファイルには出さない（fetch の body に直接渡す）。確認の答えは、TTY でなければ標準入力の先頭行（キーはその次の行）。
// 環境変数: ROVO_CONFIG / ROVO_DEPLOY_DIR / ROVO_CF_API_URL（テスト用の差し替え。https か loopback の http だけ）
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { loadTemplates, validateConfig } from "./deploy-config-lib.mjs";

const PROVIDERS = ["anthropic", "openai"];
const fail = (msg) => {
  console.error(`エラー: ${msg}`);
  process.exit(1);
};

// ---- 引数（キーは引数で受け取らない） -----------------------------------------------
const positional = [];
let yes = false;
for (const a of process.argv.slice(2)) {
  if (a === "--yes") yes = true;
  else if (a.startsWith("--")) fail(`未知のオプション: ${a}（使えるのは --yes）`);
  else positional.push(a);
}
if (positional.length === 0)
  fail(`プロバイダーを指定する: mise run byok -- <${PROVIDERS.join("|")}>`);
if (positional.length > 1)
  fail(
    "引数はプロバイダーだけ。キーは引数で渡さない（プロセス一覧に見える）。実行すると隠した入力で聞く",
  );
const provider = positional[0];
if (!PROVIDERS.includes(provider))
  fail(`未知のプロバイダー: ${provider}（${PROVIDERS.join(" / ")}）`);

// ---- 設定 -----------------------------------------------------------------------
const token = process.env.CLOUDFLARE_API_TOKEN || "";
if (!token) {
  fail("env の CLOUDFLARE_API_TOKEN が未設定（Terraform 用のトークン。AI Gateway の Edit が要る）");
}
const configPath = resolve(process.env.ROVO_CONFIG || "rovo.config.json");
const deployDir = resolve(process.env.ROVO_DEPLOY_DIR || "deploy");
if (!existsSync(configPath)) fail(`設定ファイルが無い: ${configPath}`);
let raw;
try {
  raw = JSON.parse(readFileSync(configPath, "utf8"));
} catch (e) {
  fail(`${configPath} を JSON として読めない: ${e.message}`);
}
const { config, errors } = validateConfig(raw, loadTemplates());
if (errors.length > 0) {
  console.error(`エラー: ${configPath} が不正:`);
  for (const e of errors) console.error(`  - ${e}`);
  process.exit(1);
}
const infraPath = join(deployDir, "infra.json");
if (!existsSync(infraPath))
  fail(`${infraPath} が無い（先に mise run setup。AI Gateway の id はここから読む）`);
let gatewayId;
try {
  gatewayId = JSON.parse(readFileSync(infraPath, "utf8")).ai_gateway_id;
} catch (e) {
  fail(`${infraPath} を JSON として読めない: ${e.message}`);
}
if (typeof gatewayId !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(gatewayId))
  fail(`${infraPath} の ai_gateway_id が不正`);

function apiBase() {
  const v = process.env.ROVO_CF_API_URL;
  if (!v) return "https://api.cloudflare.com/client/v4";
  let u;
  try {
    u = new URL(v);
  } catch {
    fail("ROVO_CF_API_URL が URL ではない");
  }
  const loop = ["127.0.0.1", "localhost", "[::1]"].includes(u.hostname);
  if (!(u.protocol === "https:" || (u.protocol === "http:" && loop)))
    fail("ROVO_CF_API_URL は https か loopback の http にする（トークンを平文で送らない）");
  return v.replace(/\/+$/, "");
}
const base = `${apiBase()}/accounts/${config.accountId}/ai-gateway/gateways/${gatewayId}/provider_configs`;

const PERMISSION_HELP = `必要な権限を確かめる: env の CLOUDFLARE_API_TOKEN（Terraform 用）に Account / AI Gateway / Edit が要る。
  BYOK のキーは Secrets Store に保存されるので、Account / Secrets Store の編集権限が別に要るかもしれない（未確認）。
  足りなければ、トークンの権限に足してもう一度実行するか、Cloudflare ダッシュボードの AI > AI Gateway > ${gatewayId} > Provider keys で登録する`;

// ---- Cloudflare API（値は fetch の body に直接。エラーは code / message だけ出し、キーとトークンは伏せる） ------
let secretForRedact = "";
const redact = (s) => {
  let t = String(s);
  for (const v of [secretForRedact, token]) if (v) t = t.split(v).join("***");
  return t;
};
async function api(method, url, body) {
  let r;
  try {
    r = await fetch(url, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        "user-agent": "rovo-byok",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    });
  } catch (e) {
    fail(redact(`Cloudflare API に接続できない: ${e.message}`));
  }
  let json = null;
  try {
    json = await r.json();
  } catch {}
  const ok = r.ok && json?.success !== false;
  if (!ok) {
    const detail = Array.isArray(json?.errors)
      ? json.errors
          .slice(0, 3)
          .map((e) => `${e?.code ?? ""} ${e?.message ?? ""}`.trim())
          .join(" / ")
      : "";
    const perm = r.status === 401 || r.status === 403;
    fail(
      redact(
        `Cloudflare API が失敗した（${method} HTTP ${r.status}${detail ? `: ${detail}` : ""}）${perm ? `\n${PERMISSION_HELP}` : ""}`,
      ),
    );
  }
  return json;
}

// ---- 入力 -----------------------------------------------------------------------
let stdinLines = null;
async function nextStdinLine() {
  if (stdinLines === null) {
    let text = "";
    for await (const c of process.stdin) text += c;
    stdinLines = text.split("\n");
  }
  return stdinLines.length > 0 ? stdinLines.shift() : "";
}

async function confirmOverwrite() {
  const q = `${provider} の default のキーが既にある。上書きする（Rotate）? [y/N] `;
  let ans;
  if (process.stdin.isTTY) {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    ans = await new Promise((res) => rl.question(q, res));
    rl.close();
  } else {
    process.stdout.write(q);
    ans = await nextStdinLine();
    process.stdout.write("\n");
  }
  return /^y(es)?$/i.test(String(ans).trim());
}

function readHidden(prompt) {
  return new Promise((resolveKey) => {
    const stdin = process.stdin;
    process.stdout.write(prompt);
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding("utf8");
    let buf = "";
    const done = (v) => {
      stdin.setRawMode(false);
      stdin.pause();
      stdin.removeListener("data", onData);
      process.stdout.write("\n");
      resolveKey(v);
    };
    const onData = (chunk) => {
      for (const ch of chunk) {
        if (ch === "\r" || ch === "\n") return done(buf);
        if (ch === "\u0003") {
          stdin.setRawMode(false);
          process.stdout.write("\n");
          process.exit(130);
        }
        if (ch === "\u007f" || ch === "\b") buf = buf.slice(0, -1);
        else if (ch >= " ") buf += ch;
      }
    };
    stdin.on("data", onData);
  });
}

async function readKey() {
  const prompt = `${provider} の API キー（入力は表示されない）: `;
  const v = process.stdin.isTTY ? await readHidden(prompt) : await nextStdinLine();
  return String(v).trim();
}

// ---- 本体 -----------------------------------------------------------------------
console.log(`==> AI Gateway「${gatewayId}」に ${provider} のキー（alias: default）を登録する`);
const listed = await api("GET", base);
const existing = (Array.isArray(listed?.result) ? listed.result : []).find(
  (x) => x?.provider_slug === provider && x?.alias === "default",
);
if (existing && !yes) {
  if (!(await confirmOverwrite())) {
    console.log("上書きしない。何も変えていない（確認なしで上書きするなら --yes）");
    process.exit(1);
  }
}
const key = await readKey();
if (!key) fail("キーが空");
if (/\s/.test(key)) fail("キーに空白が含まれている（貼り付けの誤りか）");
secretForRedact = key;

const body = { provider_slug: provider, alias: "default", default_config: true, secret: key };
if (existing) {
  if (typeof existing.id !== "string" || !/^[A-Za-z0-9_-]{1,100}$/.test(existing.id))
    fail("既存のキーの id を読めない");
  await api("PUT", `${base}/${existing.id}`, body);
  console.log(`==> ${provider} の default のキーを上書きした（Rotate）`);
} else {
  await api("POST", base, body);
  console.log(`==> ${provider} の default のキーを登録した`);
}
console.log(
  "  反映の確認: gateway の models_list が最大 5 分で available: true になる（docs/deploy.md の 7）",
);
process.exit(0);
