// byok（AI Gateway のプロバイダーキーを CLI で登録する）のテスト。node --test で走る。
// 偽の Cloudflare API をローカルに立てる。本物の api.cloudflare.com には触れない。
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, afterEach, beforeEach, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const ACCOUNT_ID = "0123456789abcdef".repeat(2);
const GATEWAY = "acme-gateway";
const TOKEN = "CFTOKEN-SENTINEL-TERRAFORM";
const KEY = "PROVIDERKEY-SENTINEL-0001";
const LIST_PATH = `/accounts/${ACCOUNT_ID}/ai-gateway/gateways/${GATEWAY}/provider_configs`;

const cleanups = [];
after(() => {
  for (const c of cleanups) c();
});

/** 偽の Cloudflare API。opts.existing: list が返す項目、opts.listStatus / opts.writeStatus / opts.writeBody で失敗を作る */
function startFakeCloudflare(opts = {}) {
  const requests = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => {
      body += c;
    });
    req.on("end", () => {
      requests.push({ method: req.method, url: req.url, headers: req.headers, body });
      const send = (status, obj) => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(obj));
      };
      if (req.method === "GET" && req.url === LIST_PATH) {
        if (opts.listStatus && opts.listStatus !== 200)
          return send(opts.listStatus, {
            success: false,
            errors: [{ code: 10000, message: "Authentication error" }],
            result: null,
          });
        return send(200, { success: true, errors: [], result: opts.existing ?? [] });
      }
      if (
        (req.method === "POST" && req.url === LIST_PATH) ||
        (req.method === "PUT" && req.url.startsWith(`${LIST_PATH}/`))
      ) {
        if (opts.writeStatus && opts.writeStatus !== 200)
          return send(
            opts.writeStatus,
            opts.writeBody ?? {
              success: false,
              errors: [{ code: 10000, message: "Authentication error" }],
              result: null,
            },
          );
        return send(200, {
          success: true,
          errors: [],
          result: { id: "pc-new", provider_slug: "x", alias: "default" },
        });
      }
      send(404, { success: false, errors: [{ code: 7003, message: "no route" }] });
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const url = `http://127.0.0.1:${server.address().port}`;
      resolve({ url, requests, close: () => new Promise((r) => server.close(() => r())) });
    });
  });
}

let work;
let cf;
function setup() {
  work = mkdtempSync(join(tmpdir(), "rovo-byok-"));
  cleanups.push(() => rmSync(work, { recursive: true, force: true }));
  mkdirSync(join(work, "deploy"));
  writeFileSync(
    join(work, "rovo.config.json"),
    `${JSON.stringify({ accountId: ACCOUNT_ID, publicBaseUrl: "https://rovo.example.com", allowed: { userIds: ["1"] } })}\n`,
  );
  writeFileSync(
    join(work, "deploy", "infra.json"),
    `${JSON.stringify({ kv_namespace_id: "kv-id", archive_bucket_name: "acme-archive", ai_gateway_id: GATEWAY })}\n`,
  );
}

function run(args, { stdin = "", env = {} } = {}) {
  const child = spawn(process.execPath, [join(here, "byok.mjs"), ...args], {
    cwd: work,
    env: {
      PATH: "/usr/bin:/bin",
      HOME: work,
      ROVO_CONFIG: join(work, "rovo.config.json"),
      ROVO_DEPLOY_DIR: join(work, "deploy"),
      ROVO_CF_API_URL: cf.url,
      CLOUDFLARE_API_TOKEN: TOKEN,
      ...env,
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let out = "";
  child.stdout.on("data", (c) => {
    out += c;
  });
  child.stderr.on("data", (c) => {
    out += c;
  });
  child.stdin.end(stdin);
  const killer = setTimeout(() => child.kill("SIGKILL"), 15000);
  return new Promise((resolve) =>
    child.on("close", (code) => {
      clearTimeout(killer);
      resolve({ code, out });
    }),
  );
}
const writes = () => cf.requests.filter((r) => r.method !== "GET");

describe("byok", () => {
  beforeEach(async () => {
    setup();
    cf = await startFakeCloudflare();
  });
  afterEach(async () => {
    await cf.close();
  });

  it("新規: キーを標準入力から読み、POST provider_configs の body と認証ヘッダが仕様どおり。値は出力に出ない", async () => {
    const r = await run(["anthropic"], { stdin: `${KEY}\n` });
    assert.equal(r.code, 0, r.out);
    const w = writes();
    assert.equal(w.length, 1);
    assert.equal(w[0].method, "POST");
    assert.equal(w[0].url, LIST_PATH);
    assert.equal(w[0].headers.authorization, `Bearer ${TOKEN}`);
    assert.match(w[0].headers["content-type"], /application\/json/);
    assert.deepEqual(JSON.parse(w[0].body), {
      provider_slug: "anthropic",
      alias: "default",
      default_config: true,
      secret: KEY,
    });
    // list でも同じ認証ヘッダ
    assert.equal(cf.requests[0].method, "GET");
    assert.equal(cf.requests[0].headers.authorization, `Bearer ${TOKEN}`);
    assert.ok(!r.out.includes(KEY), "キーが出力に出ている");
    assert.ok(!r.out.includes(TOKEN), "トークンが出力に出ている");
    assert.match(r.out, /anthropic/);
  });

  it("openai も同じ形で登録できる", async () => {
    const r = await run(["openai"], { stdin: `${KEY}\n` });
    assert.equal(r.code, 0, r.out);
    assert.equal(JSON.parse(writes()[0].body).provider_slug, "openai");
  });

  it("キーの前後の空白と改行は除く", async () => {
    const r = await run(["anthropic"], { stdin: `  ${KEY}  \r\n` });
    assert.equal(r.code, 0, r.out);
    assert.equal(JSON.parse(writes()[0].body).secret, KEY);
  });

  describe("既に default のキーがある", () => {
    beforeEach(async () => {
      await cf.close();
      cf = await startFakeCloudflare({
        existing: [
          { id: "pc-other-alias", provider_slug: "anthropic", alias: "work" },
          { id: "pc-other-provider", provider_slug: "openai", alias: "default" },
          { id: "pc-existing", provider_slug: "anthropic", alias: "default", default_config: true },
        ],
      });
    });
    it("確認に n と答えたら何も書かない", async () => {
      const r = await run(["anthropic"], { stdin: `n\n${KEY}\n` });
      assert.equal(writes().length, 0);
      assert.match(r.out, /default/);
      assert.ok(!r.out.includes(KEY));
    });
    it("確認に答えが無ければ（標準入力が空）何も書かない", async () => {
      const r = await run(["anthropic"], { stdin: "" });
      assert.equal(writes().length, 0);
      assert.notEqual(r.code, undefined);
    });
    it("確認に y と答えたら PUT で上書き（Rotate）する", async () => {
      const r = await run(["anthropic"], { stdin: `y\n${KEY}\n` });
      assert.equal(r.code, 0, r.out);
      const w = writes();
      assert.equal(w.length, 1);
      assert.equal(w[0].method, "PUT");
      assert.equal(w[0].url, `${LIST_PATH}/pc-existing`);
      assert.equal(JSON.parse(w[0].body).secret, KEY);
      assert.equal(JSON.parse(w[0].body).alias, "default");
      assert.ok(!r.out.includes(KEY));
    });
    it("--yes は確認を省く（標準入力はキーだけ）", async () => {
      const r = await run(["anthropic", "--yes"], { stdin: `${KEY}\n` });
      assert.equal(r.code, 0, r.out);
      assert.equal(writes()[0].method, "PUT");
    });
    it("別のプロバイダー・別のエイリアスのキーは上書き対象にしない（openai の default は別）", async () => {
      await cf.close();
      cf = await startFakeCloudflare({
        existing: [{ id: "pc-w", provider_slug: "anthropic", alias: "work" }],
      });
      const r = await run(["anthropic"], { stdin: `${KEY}\n` });
      assert.equal(r.code, 0, r.out);
      assert.equal(writes()[0].method, "POST");
    });
  });

  describe("失敗", () => {
    it("403（list）: 必要な権限を案内して止まる。何も書かない", async () => {
      await cf.close();
      cf = await startFakeCloudflare({ listStatus: 403 });
      const r = await run(["anthropic"], { stdin: `${KEY}\n` });
      assert.notEqual(r.code, 0);
      assert.match(r.out, /AI Gateway/);
      assert.match(r.out, /Edit/);
      assert.match(r.out, /Secrets Store/);
      assert.equal(writes().length, 0);
      assert.ok(!r.out.includes(KEY));
    });
    it("403（書き込み）: 必要な権限を案内して止まる", async () => {
      await cf.close();
      cf = await startFakeCloudflare({ writeStatus: 403 });
      const r = await run(["anthropic"], { stdin: `${KEY}\n` });
      assert.notEqual(r.code, 0);
      assert.match(r.out, /AI Gateway/);
      assert.match(r.out, /Secrets Store/);
      assert.ok(!r.out.includes(KEY));
      assert.ok(!r.out.includes(TOKEN));
    });
    it("API のエラーの本文にキーが含まれていても出力しない", async () => {
      await cf.close();
      cf = await startFakeCloudflare({
        writeStatus: 400,
        writeBody: { success: false, errors: [{ code: 1000, message: `invalid secret ${KEY}` }] },
      });
      const r = await run(["anthropic"], { stdin: `${KEY}\n` });
      assert.notEqual(r.code, 0);
      assert.match(r.out, /400/);
      assert.ok(!r.out.includes(KEY));
    });
    it("トークンが無ければ、何も呼ばずに止まる", async () => {
      const r = await run(["anthropic"], { stdin: `${KEY}\n`, env: { CLOUDFLARE_API_TOKEN: "" } });
      assert.notEqual(r.code, 0);
      assert.match(r.out, /CLOUDFLARE_API_TOKEN/);
      assert.equal(cf.requests.length, 0);
    });
    it("未知のプロバイダーは止まる", async () => {
      const r = await run(["gemini"], { stdin: `${KEY}\n` });
      assert.notEqual(r.code, 0);
      assert.equal(cf.requests.length, 0);
    });
    it("プロバイダーが無ければ止まる", async () => {
      const r = await run([], { stdin: `${KEY}\n` });
      assert.notEqual(r.code, 0);
      assert.equal(cf.requests.length, 0);
    });
    it("キーを引数で渡そうとしたら拒否する（引数はプロセス一覧に見える）", async () => {
      const r = await run(["anthropic", KEY]);
      assert.notEqual(r.code, 0);
      assert.equal(cf.requests.length, 0);
      assert.ok(!r.out.includes(KEY));
    });
    it("キーが空なら書かない", async () => {
      const r = await run(["anthropic"], { stdin: "\n" });
      assert.notEqual(r.code, 0);
      assert.equal(writes().length, 0);
    });
    it("空白を含むキーは書かない", async () => {
      const r = await run(["anthropic"], { stdin: "abc def\n" });
      assert.notEqual(r.code, 0);
      assert.equal(writes().length, 0);
      assert.ok(!r.out.includes("abc def"));
    });
    it("deploy/infra.json が無ければ、setup を先にと案内して止まる", async () => {
      rmSync(join(work, "deploy", "infra.json"));
      const r = await run(["anthropic"], { stdin: `${KEY}\n` });
      assert.notEqual(r.code, 0);
      assert.match(r.out, /infra\.json/);
      assert.equal(cf.requests.length, 0);
    });
    it("loopback 以外の http の API URL は拒否する（トークンを平文で送らない）", async () => {
      const r = await run(["anthropic"], {
        stdin: `${KEY}\n`,
        env: { ROVO_CF_API_URL: "http://example.com/client/v4" },
      });
      assert.notEqual(r.code, 0);
      assert.equal(cf.requests.length, 0);
    });
    it("200 でも success:false なら失敗として扱う", async () => {
      await cf.close();
      cf = await startFakeCloudflare();
      // 書き込みだけ success:false を返す偽物
      await cf.close();
      const server = createServer((req, res) => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify(
            req.method === "GET"
              ? { success: true, result: [] }
              : { success: false, errors: [{ code: 1, message: "nope" }] },
          ),
        );
      });
      await new Promise((r) => server.listen(0, "127.0.0.1", r));
      const url = `http://127.0.0.1:${server.address().port}`;
      cf = { url, requests: [], close: () => new Promise((r) => server.close(() => r())) };
      const r = await run(["anthropic"], { stdin: `${KEY}\n` });
      assert.notEqual(r.code, 0);
      assert.ok(!r.out.includes(KEY));
    });
  });
});
