// github-app（GitHub App の manifest フロー）のテスト。node --test で走る。
// 偽の GitHub（conversions）、偽のブラウザ（callback を叩く）、偽の pnpm / openssl / open を PATH で差し替える。
// 本物の github.com / api.github.com / Cloudflare / wrangler には触れない。
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, afterEach, beforeEach, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { visit } from "./fixtures/github-app/fake-browser.mjs";
import { FAKE_APP, SENTINELS, startFakeGithub } from "./fixtures/github-app/fake-github.mjs";
import {
  buildManifest,
  defaultAppName,
  newState,
  stateMatches,
  updateConfigText,
} from "./github-app-lib.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const ACCOUNT_ID = "0123456789abcdef".repeat(2);
const TF_SENTINEL = "TFTOKEN-SENTINEL-XYZ";

describe("manifest", () => {
  const base = { publicBaseUrl: "https://rovo.example.com", allowed: { org: "", team: "" } };
  it("公開 URL・callback・権限・Webhook 無効が入る", () => {
    const m = buildManifest({
      name: "rovo-acme-ab12",
      publicBaseUrl: base.publicBaseUrl,
      redirectUrl: "http://127.0.0.1:5555/callback",
      members: false,
    });
    assert.deepEqual(m, {
      name: "rovo-acme-ab12",
      url: "https://rovo.example.com",
      redirect_url: "http://127.0.0.1:5555/callback",
      callback_urls: ["https://rovo.example.com/callback"],
      request_oauth_on_install: false,
      public: false,
      hook_attributes: { url: "https://rovo.example.com", active: false },
      default_permissions: {
        contents: "write",
        pull_requests: "write",
        metadata: "read",
        checks: "read",
        statuses: "read",
      },
      default_events: [],
      setup_on_update: false,
    });
  });
  it("org の所属を確かめるとき（allowed.org がある）だけ Members: read を足す", () => {
    const m = buildManifest({
      name: "n",
      publicBaseUrl: base.publicBaseUrl,
      redirectUrl: "http://127.0.0.1:1/callback",
      members: true,
    });
    assert.equal(m.default_permissions.members, "read");
  });
  it("既定の名前は rovo-<namePrefix>-<乱数>。毎回違う", () => {
    const a = defaultAppName("acme");
    const b = defaultAppName("acme");
    assert.match(a, /^rovo-acme-[a-z0-9]{4,}$/);
    assert.notEqual(a, b);
  });
  it("名前は 34 文字以内（GitHub の上限）に収める", () => {
    assert.ok(defaultAppName("a".repeat(30)).length <= 34);
  });
});

describe("state", () => {
  it("十分長い乱数で、毎回違う", () => {
    const a = newState();
    assert.match(a, /^[0-9a-f]{32,}$/);
    assert.notEqual(a, newState());
  });
  it("一致だけを通す", () => {
    const s = newState();
    assert.equal(stateMatches(s, s), true);
    assert.equal(stateMatches(s, `${s}x`), false);
    assert.equal(stateMatches(s, ""), false);
    assert.equal(stateMatches(s, null), false);
    assert.equal(stateMatches(s, undefined), false);
  });
});

describe("rovo.config.json の更新（整形を保つ）", () => {
  const inline = `{
  "accountId": "${ACCOUNT_ID}",
  "publicBaseUrl": "https://rovo.example.com",
  "githubApp": { "id": "", "clientId": "" },
  "allowed": { "userIds": ["1001"] }
}
`;
  it("1 行の githubApp だけが変わり、ほかはバイト単位で同じ", () => {
    const out = updateConfigText(inline, { id: "42", clientId: "Iv1.abc" });
    assert.equal(
      out,
      inline.replace(
        '"githubApp": { "id": "", "clientId": "" }',
        '"githubApp": { "id": "42", "clientId": "Iv1.abc" }',
      ),
    );
  });
  it("複数行の githubApp は複数行のまま", () => {
    const text = `{\n    "publicBaseUrl": "https://x.example.com",\n    "githubApp": {\n        "id": "",\n        "clientId": ""\n    }\n}\n`;
    const out = updateConfigText(text, { id: "7", clientId: "Iv1.z" });
    assert.deepEqual(JSON.parse(out).githubApp, { id: "7", clientId: "Iv1.z" });
    assert.match(out, /"githubApp": \{\n {8}"id": "7",\n {8}"clientId": "Iv1.z"\n {4}\}/);
  });
  it("githubApp が無ければ最後に足す（ほかは変えない）", () => {
    const text = `{\n  "publicBaseUrl": "https://x.example.com",\n  "allowed": { "userIds": ["1"] }\n}\n`;
    const out = updateConfigText(text, { id: "7", clientId: "Iv1.z" });
    assert.deepEqual(JSON.parse(out), {
      ...JSON.parse(text),
      githubApp: { id: "7", clientId: "Iv1.z" },
    });
    assert.ok(out.startsWith(text.slice(0, text.lastIndexOf("}") - 1)));
  });
  it("既存の id が入っていても置き換える", () => {
    const text = inline.replace('{ "id": "", "clientId": "" }', '{ "id": "1", "clientId": "old" }');
    assert.deepEqual(JSON.parse(updateConfigText(text, { id: "2", clientId: "new" })).githubApp, {
      id: "2",
      clientId: "new",
    });
  });
  it("JSON として読めなければ例外（何も書かない側に倒す）", () => {
    assert.throws(() => updateConfigText("{ not json", { id: "1", clientId: "a" }));
  });
});

// ---- フロー全体（CLI を実際に起動） ---------------------------------------------------

let work;
let github;
const cleanups = [];
after(() => {
  for (const c of cleanups) c();
});

function setupWork() {
  work = mkdtempSync(join(tmpdir(), "rovo-gh-app-"));
  cleanups.push(() => rmSync(work, { recursive: true, force: true }));
  const bin = join(work, "bin");
  mkdirSync(bin);
  symlinkSync(process.execPath, join(bin, "node"));
  const w = (name, body) => {
    writeFileSync(join(bin, name), `#!/usr/bin/env bash\n${body}\n`);
    chmodSync(join(bin, name), 0o755);
  };
  const openBody = `echo "$1" >> "$OPEN_LOG"
case "$1" in http://127.0.0.1:*) ( node "${join(here, "fixtures/github-app/fake-browser.mjs")}" "$1" >> "$BROWSER_OUT" 2>&1 & ) ;; esac
exit 0`;
  w("open", openBody);
  w("xdg-open", openBody);
  w(
    "pnpm",
    `echo "$(basename "$PWD") $*" >> "$PNPM_LOG"
echo "pnpm token=\${CLOUDFLARE_API_TOKEN:-unset}" >> "$ENV_LOG"
case "$*" in
  *"secret put"*)
    [ -n "\${FAKE_PUT_FAIL:-}" ] && exit 1
    nm="$(echo "$*" | sed -E 's/.*secret put ([A-Z_]+).*/\\1/')"
    cat > "$CAPTURE/$(basename "$PWD").$nm" ;;
esac
exit 0`,
  );
  w("openssl", `[ "$1" = pkcs8 ] || exit 9\nsed 's/RSA PRIVATE KEY/PRIVATE KEY/'`);
  mkdirSync(join(work, "capture"));
  mkdirSync(join(work, "deploy"));
  for (const n of ["gateway", "agent", "web"])
    writeFileSync(join(work, "deploy", `${n}.wrangler.jsonc`), "{}\n");
  writeFileSync(
    join(work, "deploy", "infra.json"),
    `${JSON.stringify({ kv_namespace_id: "kv-namespace-id-example", archive_bucket_name: "acme-archive", ai_gateway_id: "acme-gateway", ai_web_gateway_id: "acme-web-gateway" })}\n`,
  );
  return work;
}

const CONFIG_TEXT = `{
  "accountId": "${ACCOUNT_ID}",
  "namePrefix": "acme",
  "workerNames": { "gateway": "acme-gateway", "agent": "acme-agent", "web": "acme-web" },
  "publicBaseUrl": "https://rovo.example.com",
  "githubApp": { "id": "", "clientId": "" },
  "allowed": { "userIds": ["1001"] }
}
`;
const CONFIG_ORG_ONLY_TEXT = CONFIG_TEXT.replace(
  '"allowed": { "userIds": ["1001"] }',
  '"allowed": { "org": "acme-org" }',
);
const CONFIG_ORG_TEXT = CONFIG_TEXT.replace(
  '"allowed": { "userIds": ["1001"] }',
  '"allowed": { "org": "acme-org", "team": "devs" }',
);

function run(args = [], { env = {}, timeoutMs = 20000, onStdout } = {}) {
  const p = join;
  const child = spawn(process.execPath, [join(here, "github-app.mjs"), ...args], {
    cwd: work,
    env: {
      PATH: `${p(work, "bin")}:/usr/bin:/bin`,
      HOME: work,
      ROVO_CONFIG: p(work, "rovo.config.json"),
      ROVO_DEPLOY_DIR: p(work, "deploy"),
      ROVO_GITHUB_URL: github.url,
      ROVO_GITHUB_API_URL: github.url,
      OPEN_LOG: p(work, "open.log"),
      BROWSER_OUT: p(work, "browser.out"),
      PNPM_LOG: p(work, "pnpm.log"),
      ENV_LOG: p(work, "env.log"),
      CAPTURE: p(work, "capture"),
      FAKE_BROWSER_LOG: p(work, "browser.log"),
      CLOUDFLARE_API_TOKEN: TF_SENTINEL,
      ...env,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let out = "";
  const sink = (c) => {
    out += c;
    onStdout?.(out);
  };
  child.stdout.on("data", sink);
  child.stderr.on("data", sink);
  const killer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
  return new Promise((resolve) => {
    child.on("close", (code) => {
      clearTimeout(killer);
      resolve({ code, out });
    });
  });
}

const read = (f) => (existsSync(join(work, f)) ? readFileSync(join(work, f), "utf8") : "");
const lines = (f) => read(f).split("\n").filter(Boolean);
const allFilesText = () => {
  const acc = [];
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const f = join(d, e.name);
      if (e.isDirectory()) {
        if (e.name === "capture" || e.name === "bin") continue;
        walk(f);
      } else acc.push(readFileSync(f, "utf8"));
    }
  };
  walk(work);
  return acc.join("\n");
};

describe("フロー", () => {
  beforeEach(async () => {
    setupWork();
    github = await startFakeGithub();
    writeFileSync(join(work, "rovo.config.json"), CONFIG_TEXT);
  });
  afterEach(async () => {
    await github.close();
  });

  it("成功: 手元のページ → フォーム → callback → conversions → secret を標準入力で → 設定 → 再デプロイ → Install を開く", async () => {
    const r = await run();
    assert.equal(r.code, 0, r.out);
    // フォームは個人アカウントの新規作成（allowed.org が無い）。state は CSRF 用で POST 先のクエリに載る
    const b = JSON.parse(lines("browser.log")[0]);
    assert.equal(b.method.toLowerCase(), "post");
    assert.equal(b.action.split("?")[0], `${github.url}/settings/apps/new`);
    assert.match(b.state, /^[0-9a-f]{32,}$/);
    assert.equal(b.manifest.url, "https://rovo.example.com");
    assert.deepEqual(b.manifest.callback_urls, ["https://rovo.example.com/callback"]);
    assert.match(b.manifest.name, /^rovo-acme-[a-z0-9]+$/);
    assert.match(b.manifest.redirect_url, /^http:\/\/127\.0\.0\.1:\d+\/callback$/);
    // conversions は認証なしで 1 回
    const conv = github.requests.filter((q) => q.url.includes("/conversions"));
    assert.equal(conv.length, 1);
    assert.equal(conv[0].url, "/app-manifests/fake-code-123/conversions");
    assert.equal(conv[0].method, "POST");
    assert.equal(conv[0].headers.authorization, undefined);
    // rovo.config.json: githubApp だけが変わる
    assert.equal(
      read("rovo.config.json"),
      CONFIG_TEXT.replace(
        '{ "id": "", "clientId": "" }',
        `{ "id": "${FAKE_APP.id}", "clientId": "${FAKE_APP.client_id}" }`,
      ),
    );
    // secret は標準入力で gateway に入る。秘密鍵は PKCS#8 に変換されたもの
    assert.equal(read(`capture/gateway.GITHUB_APP_CLIENT_SECRET`), SENTINELS.clientSecret);
    const pk = read(`capture/gateway.GITHUB_APP_PRIVATE_KEY`);
    // 見出しは組み立てる（秘密の検出がダミーに反応しないように）
    assert.ok(pk.startsWith(["-----BEGIN", "PRIVATE KEY-----"].join(" ")), pk);
    assert.ok(pk.includes(SENTINELS.pemBody));
    // 値は引数・env・出力・ファイルのどこにも出ない。webhook_secret は捨てる
    const sentinels = [SENTINELS.clientSecret, SENTINELS.webhookSecret, SENTINELS.pemBody];
    const visible = [
      r.out,
      read("pnpm.log"),
      read("env.log"),
      read("open.log"),
      allFilesText(),
    ].join("\n");
    for (const s of sentinels) assert.ok(!visible.includes(s), `${s} が出ている`);
    assert.ok(
      !Object.keys(Object.fromEntries(readdirSync(join(work, "capture")).map((f) => [f, 1]))).some(
        (f) => /WEBHOOK/.test(f),
      ),
    );
    // wrangler には Terraform 用のトークンを渡さない
    assert.ok(!read("env.log").includes(TF_SENTINEL));
    // 再デプロイ: GITHUB_APP_ID が入った gateway の設定を生成し、gateway だけをデプロイする
    assert.match(
      read("deploy/gateway.wrangler.jsonc"),
      new RegExp(`"GITHUB_APP_ID": "${FAKE_APP.id}"`),
    );
    const calls = lines("pnpm.log");
    assert.deepEqual(
      calls.map((c) => c.replace(/ -c .*/, "")),
      [
        "gateway exec wrangler secret put GITHUB_APP_CLIENT_SECRET",
        "gateway exec wrangler secret put GITHUB_APP_PRIVATE_KEY",
        // gateway のデプロイの前に、ダッシュボード（assets）をビルドする
        "dashboard exec vite build",
        "gateway exec wrangler deploy",
      ],
    );
    // Install ページを開き、expire user tokens の確認を案内する
    assert.ok(lines("open.log").includes(`${github.url}/apps/${FAKE_APP.slug}/installations/new`));
    assert.match(r.out, /installations\/new/);
    assert.match(r.out, /User-to-server token expiration|Expire user authorization tokens/);
    assert.match(r.out, new RegExp(`/settings/apps/${FAKE_APP.slug}`));
  });

  it("allowed.org だけ（team なし）でも Members: read を宣言する", async () => {
    writeFileSync(join(work, "rovo.config.json"), CONFIG_ORG_ONLY_TEXT);
    const r = await run(["--no-deploy"]);
    assert.equal(r.code, 0, r.out);
    const b = JSON.parse(lines("browser.log").at(-1));
    assert.equal(b.manifest.default_permissions.members, "read");
  });

  it("allowed.org があれば、組織の画面に作る。--personal で個人に、--org で上書きできる", async () => {
    writeFileSync(join(work, "rovo.config.json"), CONFIG_ORG_TEXT);
    let r = await run(["--no-deploy"]);
    assert.equal(r.code, 0, r.out);
    let b = JSON.parse(lines("browser.log").at(-1));
    assert.equal(b.action.split("?")[0], `${github.url}/organizations/acme-org/settings/apps/new`);
    assert.equal(b.manifest.default_permissions.members, "read"); // team がある
    assert.match(r.out, /organizations\/acme-org\/settings\/apps\/acme-rovo-xyz/);
    // 2 回目: config は設定済みなので --recreate が要る
    r = await run(["--recreate", "--personal", "--no-deploy"]);
    assert.equal(r.code, 0, r.out);
    b = JSON.parse(lines("browser.log").at(-1));
    assert.equal(b.action.split("?")[0], `${github.url}/settings/apps/new`);
    r = await run(["--recreate", "--org", "other-org", "--no-deploy"]);
    b = JSON.parse(lines("browser.log").at(-1));
    assert.equal(b.action.split("?")[0], `${github.url}/organizations/other-org/settings/apps/new`);
  });

  it("--name で名前を決められる", async () => {
    const r = await run(["--name", "my-rovo-app", "--no-deploy"]);
    assert.equal(r.code, 0, r.out);
    assert.equal(JSON.parse(lines("browser.log")[0]).manifest.name, "my-rovo-app");
  });

  it("githubApp が設定済みなら何もしない。--recreate で作り直せる", async () => {
    const configured = CONFIG_TEXT.replace(
      '{ "id": "", "clientId": "" }',
      '{ "id": "9", "clientId": "Iv1.old" }',
    );
    writeFileSync(join(work, "rovo.config.json"), configured);
    const r = await run();
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /設定済み/);
    assert.equal(read("open.log"), "");
    assert.equal(read("pnpm.log"), "");
    assert.equal(github.requests.length, 0);
    assert.equal(read("rovo.config.json"), configured);
    const r2 = await run(["--recreate", "--no-deploy"]);
    assert.equal(r2.code, 0, r2.out);
    assert.deepEqual(JSON.parse(read("rovo.config.json")).githubApp, {
      id: String(FAKE_APP.id),
      clientId: FAKE_APP.client_id,
    });
  });

  it("--no-deploy は secret までで、設定の再生成とデプロイをしない", async () => {
    const r = await run(["--no-deploy"]);
    assert.equal(r.code, 0, r.out);
    assert.ok(!read("pnpm.log").includes("wrangler deploy"));
    assert.equal(read("deploy/gateway.wrangler.jsonc"), "{}\n");
  });

  it("state が違えば、conversions を呼ばず、何も書かずに止まる", async () => {
    const r = await run([], { env: { FAKE_BROWSER_STATE: "0".repeat(32) } });
    assert.notEqual(r.code, 0);
    assert.match(r.out, /state/);
    assert.equal(github.requests.length, 0);
    assert.equal(read("rovo.config.json"), CONFIG_TEXT);
    assert.equal(read("pnpm.log"), "");
    assert.equal(readdirSync(join(work, "capture")).length, 0);
  });

  it("state が無い callback も止まる", async () => {
    const r = await run([], { env: { FAKE_BROWSER_CODE: "x", FAKE_BROWSER_STATE: "" } });
    assert.notEqual(r.code, 0);
    assert.equal(github.requests.length, 0);
    assert.equal(read("rovo.config.json"), CONFIG_TEXT);
  });

  it("code が無い callback も止まる", async () => {
    const r = await run([], { env: { FAKE_BROWSER_CODE: "" } });
    assert.notEqual(r.code, 0);
    assert.equal(github.requests.length, 0);
    assert.equal(read("rovo.config.json"), CONFIG_TEXT);
  });

  it("時間切れ: 戻ってこなければ、何も書かずに止まる（サーバーも閉じる）", async () => {
    const r = await run([], {
      env: { FAKE_BROWSER_NOCALLBACK: "1", ROVO_GITHUB_APP_TIMEOUT_MS: "1200" },
    });
    assert.notEqual(r.code, 0);
    assert.match(r.out, /時間切れ|戻ってこなかった/);
    assert.equal(github.requests.length, 0);
    assert.equal(read("rovo.config.json"), CONFIG_TEXT);
    assert.equal(read("pnpm.log"), "");
  });

  it("conversions が失敗したら、何も書かずに止まる。メッセージに秘密を含めない", async () => {
    await github.close();
    github = await startFakeGithub({ mode: "fail" });
    const r = await run();
    assert.notEqual(r.code, 0);
    assert.match(r.out, /422/);
    assert.equal(read("rovo.config.json"), CONFIG_TEXT);
    assert.equal(read("pnpm.log"), "");
    assert.equal(readdirSync(join(work, "capture")).length, 0);
  });

  it("conversions の応答に必須の項目が欠けていたら、何も書かずに止まる", async () => {
    await github.close();
    github = await startFakeGithub({ mode: "incomplete" });
    const r = await run();
    assert.notEqual(r.code, 0);
    assert.equal(read("rovo.config.json"), CONFIG_TEXT);
    assert.equal(read("pnpm.log"), "");
    assert.ok(!r.out.includes(SENTINELS.clientSecret));
  });

  it("secret の put に失敗したら、設定を書かず、作られた App の始末を案内する", async () => {
    const r = await run([], { env: { FAKE_PUT_FAIL: "1" } });
    assert.notEqual(r.code, 0);
    assert.equal(read("rovo.config.json"), CONFIG_TEXT);
    assert.ok(r.out.includes(FAKE_APP.slug));
    assert.match(r.out, /削除/);
    assert.ok(!r.out.includes(SENTINELS.clientSecret));
    assert.ok(!r.out.includes(SENTINELS.pemBody));
    assert.ok(!read("pnpm.log").includes("wrangler deploy"));
  });

  it("gateway の設定が無ければ、ブラウザを開く前に止まる", async () => {
    rmSync(join(work, "deploy", "gateway.wrangler.jsonc"));
    const r = await run();
    assert.notEqual(r.code, 0);
    assert.equal(read("open.log"), "");
    assert.equal(github.requests.length, 0);
  });

  it("config が不正なら、ブラウザを開く前に止まる", async () => {
    writeFileSync(join(work, "rovo.config.json"), '{"accountId":"x"}');
    const r = await run();
    assert.notEqual(r.code, 0);
    assert.equal(read("open.log"), "");
  });

  it("https でない（loopback 以外の）GitHub の URL は拒否する", async () => {
    const r = await run([], { env: { ROVO_GITHUB_URL: "http://example.com" } });
    assert.notEqual(r.code, 0);
    assert.equal(read("open.log"), "");
  });

  it("未知のオプションは拒否する", async () => {
    const r = await run(["--bogus"]);
    assert.notEqual(r.code, 0);
    assert.equal(read("open.log"), "");
  });

  it("ブラウザを開けなければ URL を表示する。その URL を開けば先へ進める", async () => {
    let started = false;
    let visiting = null;
    // open / xdg-open が無い PATH（node・pnpm・openssl だけ）
    mkdirSync(join(work, "bin2"));
    symlinkSync(process.execPath, join(work, "bin2", "node"));
    for (const t of ["pnpm", "openssl"]) symlinkSync(join(work, "bin", t), join(work, "bin2", t));
    const r = await run(["--no-deploy"], {
      env: { PATH: `${join(work, "bin2")}:/usr/bin:/bin`, ROVO_OPEN_CMD: "false" },
      onStdout: (out) => {
        const m = /(http:\/\/127\.0\.0\.1:\d+\/start)/.exec(out);
        if (m && !started) {
          started = true;
          visiting = visit(m[1], { log: join(work, "browser.log") });
        }
      },
    });
    assert.equal(r.code, 0, r.out);
    await visiting;
    assert.match(r.out, /開けなかった|開けない/);
  });
});
