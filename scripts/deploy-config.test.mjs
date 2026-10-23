// deploy-config（deploy:config の生成器）のテスト。node --test で走る。実際の Terraform / Cloudflare には触れない。
// 回帰テスト: 本番相当の入力（架空の値）から、手書きの deploy/*.wrangler.jsonc と同じ内容（コメントを除く）が出ることを固定する。
// 基準は scripts/fixtures/deploy-config/expected/（手書き相当。生成器の出力ではない）。
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import {
  DEFAULTS,
  generateAll,
  parseJsonc,
  stripJsonc,
  tfvars,
  validateConfig,
} from "./deploy-config-lib.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const read = (p) => readFileSync(p, "utf8");
const templates = Object.fromEntries(
  ["gateway", "agent", "web"].map((n) => [
    n,
    read(join(root, "deploy.example", `${n}.wrangler.jsonc`)),
  ]),
);
// scan:secrets が 32 桁の 16 進数のリテラルを検出するので、実行時に組み立てる
const ACCOUNT_ID = "0123456789abcdef".repeat(2);

const productionLike = () => ({
  accountId: ACCOUNT_ID,
  namePrefix: "acme",
  workerNames: { gateway: "acme-gateway", agent: "acme-agent", web: "acme-web" },
  publicBaseUrl: "https://rovo.example.com",
  githubApp: { id: "123456", clientId: "Iv1.exampleclientid" },
  allowed: { userIds: ["1001", "1002"] },
  budget: { monthlyUsd: 50, taskUsd: 5, consultUsd: 0.25 },
  models: {
    default: "anthropic/claude-sonnet-5-5",
    list: [
      "anthropic/claude-haiku-5-5",
      "anthropic/claude-sonnet-5-5",
      "workers-ai/@cf/openai/gpt-oss-120b",
    ],
    efforts: { "anthropic/claude-sonnet-5-5": "medium", "anthropic/claude-haiku-5-5": "off" },
  },
  sandbox: { instance: "standard-1" },
  concurrency: { maxTasks: 3 },
  webBrowseEnabled: true,
  vars: { gateway: { WEB_SEARCH_DAILY_LIMIT: "300" } },
});
const infra = {
  kv_namespace_id: "kv-namespace-id-example",
  archive_bucket_name: "acme-archive",
  ai_gateway_id: "acme-gateway",
  ai_web_gateway_id: "acme-web-gateway",
};
const validated = (raw) => {
  const r = validateConfig(raw);
  assert.deepEqual(r.errors, []);
  return r.config;
};
const expected = (n) =>
  parseJsonc(
    read(join(here, "fixtures/deploy-config/expected", `${n}.wrangler.jsonc`)).replaceAll(
      "@ACCOUNT_ID@",
      ACCOUNT_ID,
    ),
  );

describe("stripJsonc / parseJsonc", () => {
  it("行コメントを除く。文字列の中の // は残す", () => {
    const v = parseJsonc('{\n // c\n "u": "https://x.example/a//b", // t\n "n": 1\n}');
    assert.deepEqual(v, { u: "https://x.example/a//b", n: 1 });
  });
  it("ブロックコメントを除く", () => {
    assert.deepEqual(parseJsonc('{ /* a */ "a": 1 }'), { a: 1 });
    assert.equal(stripJsonc("/* x */").trim(), "");
  });
});

describe("回帰: 本番相当の入力から手書き相当の設定が出る", () => {
  const out = generateAll(validated(productionLike()), infra, templates);
  for (const n of ["gateway", "agent", "web"]) {
    it(`${n}: コメントを除いた内容が手書き相当と一致する`, () => {
      assert.deepEqual(parseJsonc(out[n]), expected(n));
    });
  }
  it("gateway だけに assets（dashboard の dist。Worker 優先）が出る。agent / web には出ない", () => {
    const g = parseJsonc(out.gateway);
    assert.deepEqual(g.assets, {
      directory: "../apps/dashboard/dist",
      binding: "ASSETS",
      run_worker_first: true,
    });
    assert.equal(parseJsonc(out.agent).assets, undefined);
    assert.equal(parseJsonc(out.web).assets, undefined);
  });
  it("gateway に ai バインディングと、モデルの自動選択の var が出る（新しい secret は要らない）", () => {
    const g = parseJsonc(out.gateway);
    assert.deepEqual(g.ai, { binding: "AI" });
    assert.equal(
      g.vars.AUTO_MODEL_CANDIDATES,
      "anthropic/claude-haiku-5-5,anthropic/claude-sonnet-5-5,anthropic/claude-opus-5-5",
    );
    assert.equal(g.vars.AUTO_MODEL_CLEF_THRESHOLDS, "");
    // fable は既定の候補に入れない
    assert.doesNotMatch(g.vars.AUTO_MODEL_CANDIDATES, /fable/);
    // gateway の AI Gateway の id は agent と同じ（Clef の呼び出しも同じ Gateway を通る）
    assert.equal(g.vars.AI_GATEWAY_ID, parseJsonc(out.agent).vars.AI_GATEWAY_ID);
  });
  it("vars.gateway.AUTO_MODEL_CANDIDATES で候補を変えられる（fable を足す）。agent / web には無い", () => {
    const cfg = validated({
      ...productionLike(),
      vars: {
        gateway: {
          AUTO_MODEL_CANDIDATES: "anthropic/claude-sonnet-5-5,anthropic/claude-fable-5-1",
        },
      },
    });
    const o = generateAll(cfg, infra, templates);
    assert.match(parseJsonc(o.gateway).vars.AUTO_MODEL_CANDIDATES, /fable/);
    assert.equal(parseJsonc(o.agent).vars.AUTO_MODEL_CANDIDATES, undefined);
  });
  it("生成物に <...> のプレースホルダが残らない（コメント行を除く）", () => {
    for (const n of ["gateway", "agent", "web"]) {
      const bad = out[n]
        .split("\n")
        .filter((l) => !l.trim().startsWith("//") && /<[A-Za-z_][A-Za-z0-9_]*>/.test(l));
      assert.deepEqual(bad, [], n);
    }
  });
  it("生成物の先頭に「生成物」の注記がある", () => {
    for (const n of ["gateway", "agent", "web"]) assert.match(out[n], /^\/\/ .*deploy:config/);
  });
  it("Worker 名・バケット名・AI Gateway の id は 1 か所の入力から全体に反映される", () => {
    const g = parseJsonc(out.gateway);
    const a = parseJsonc(out.agent);
    const w = parseJsonc(out.web);
    assert.equal(g.durable_objects.bindings.find((b) => b.name === "AGENT_DO").script_name, a.name);
    assert.equal(g.services[0].service, w.name);
    assert.equal(a.services[0].service, w.name);
    assert.equal(g.vars.AI_GATEWAY_ID, a.vars.AI_GATEWAY_ID);
    // web だけ Web Search 用の別の Gateway（byok_only なし）を通る。agent / gateway は Claude 用の Gateway
    assert.equal(w.vars.AI_GATEWAY_ID, "acme-web-gateway");
    assert.notEqual(a.vars.AI_GATEWAY_ID, w.vars.AI_GATEWAY_ID);
    assert.equal(g.vars.AGENT_MODELS, a.vars.AGENT_MODELS);
    assert.equal(g.vars.MODEL_EFFORTS, a.vars.MODEL_EFFORTS);
    for (const x of [g, a, w]) assert.equal(x.vars.WEB_BROWSE_ENABLED, "true");
  });
});

describe("customDomain（任意の独自ドメイン）", () => {
  const gen = (patch) =>
    generateAll(validated({ ...productionLike(), ...patch }), infra, templates);
  const errs = (patch) => validateConfig({ ...productionLike(), ...patch }).errors;
  it("未設定: gateway の routes は [] で、agent / web には routes が出ない", () => {
    const o = gen({});
    assert.deepEqual(parseJsonc(o.gateway).routes, []);
    assert.equal(parseJsonc(o.agent).routes, undefined);
    assert.equal(parseJsonc(o.web).routes, undefined);
    assert.equal(parseJsonc(o.gateway).workers_dev, true);
  });
  it("設定: routes が custom_domain になり、PUBLIC_BASE_URL は https://<host>（publicBaseUrl 省略時）", () => {
    const o = gen({ customDomain: "rovo.example.org", publicBaseUrl: undefined });
    const g = parseJsonc(o.gateway);
    assert.deepEqual(g.routes, [{ pattern: "rovo.example.org", custom_domain: true }]);
    assert.equal(g.vars.PUBLIC_BASE_URL, "https://rovo.example.org");
    assert.equal(parseJsonc(o.agent).routes, undefined);
    assert.equal(parseJsonc(o.web).routes, undefined);
    assert.equal(g.workers_dev, true); // routes があると既定が false になるので明示
  });
  it("publicBaseUrl と同じホストなら通る（末尾スラッシュは無視）", () => {
    const o = gen({ customDomain: "rovo.example.com", publicBaseUrl: "https://rovo.example.com/" });
    assert.equal(parseJsonc(o.gateway).vars.PUBLIC_BASE_URL, "https://rovo.example.com");
  });
  it("publicBaseUrl とホストが違うと検証エラー", () => {
    const e = errs({ customDomain: "rovo.example.org" });
    assert.ok(
      e.some((x) => x.includes("customDomain") && x.includes("publicBaseUrl")),
      e.join(),
    );
  });
  it("どちらも無いと publicBaseUrl 必須のエラー", () => {
    assert.ok(errs({ publicBaseUrl: undefined }).some((x) => x.includes("publicBaseUrl: 必須")));
  });
  it("不正なホスト（スキーム付き・大文字・ポート付き・パス・末尾ドット・ドット無し・プレースホルダ）はエラー", () => {
    for (const v of [
      "https://rovo.example.com",
      "Rovo.Example.com",
      "rovo.example.com:8443",
      "rovo.example.com/mcp",
      "rovo.example.com.",
      "localhost",
      "<YOUR_HOST>",
      "",
      42,
    ]) {
      const e = errs({ customDomain: v, publicBaseUrl: undefined });
      assert.ok(
        e.some((x) => x.startsWith("customDomain")),
        `${v}: ${e.join()}`,
      );
    }
  });
  it("生成物が JSONC としてパースできる", () => {
    const o = gen({ customDomain: "rovo.example.com" });
    assert.doesNotThrow(() => parseJsonc(o.gateway));
  });
});

describe("既定値", () => {
  const minimal = {
    accountId: ACCOUNT_ID,
    publicBaseUrl: "https://rovo.example.com",
    allowed: { userIds: "42" },
  };
  const out = generateAll(validated(minimal), infra, templates);
  it("必須の項目だけで、雛形どおりの既定値になる", () => {
    const g = parseJsonc(out.gateway);
    assert.equal(g.name, "rovo-gateway");
    assert.equal(g.vars.MONTHLY_BUDGET_USD, "100");
    assert.equal(g.vars.TASK_BUDGET_USD, "10");
    assert.equal(g.vars.CONSULT_BUDGET_USD, "0.5");
    assert.equal(g.vars.MAX_CONCURRENT_TASKS, "2");
    assert.equal(g.vars.WEB_BROWSE_ENABLED, "false");
    assert.equal(g.vars.ALLOWED_ORG, "");
    assert.equal(g.vars.ALLOWED_USER_IDS, "42");
    assert.equal(g.vars.AGENT_MODEL, "anthropic/claude-sonnet-5-5");
    assert.equal(g.vars.MODEL_EFFORTS, "");
    assert.equal(g.vars.GITHUB_APP_ID, "");
    assert.match(g.vars.AGENT_MODELS, /workers-ai\/@cf\/openai\/gpt-oss-120b/);
  });
  it("Sandbox の大きさの既定は standard-2 で、gateway の単価も standard-2 の値になる（D13）", () => {
    assert.equal(parseJsonc(out.agent).vars.SANDBOX_INSTANCE, "standard-2");
    assert.equal(parseJsonc(out.gateway).vars.SANDBOX_USD_PER_HOUR, "0.1291");
  });
  it("GitHub App が未設定でも生成できる（警告は CLI が出す）", () => {
    const r = validateConfig(minimal);
    assert.deepEqual(r.errors, []);
    assert.equal(r.githubAppConfigured, false);
  });
});

describe("sandbox.instance（D13）", () => {
  const gen = (patch) =>
    generateAll(validated({ ...productionLike(), ...patch }), infra, templates);
  it("agent の SANDBOX_INSTANCE と gateway の SANDBOX_USD_PER_HOUR（instance から計算）に反映される", () => {
    const o = gen({ sandbox: { instance: "standard-4" } });
    assert.equal(parseJsonc(o.agent).vars.SANDBOX_INSTANCE, "standard-4");
    assert.equal(parseJsonc(o.gateway).vars.SANDBOX_USD_PER_HOUR, "0.4011");
    const l = gen({ sandbox: { instance: "lite" } });
    assert.equal(parseJsonc(l.gateway).vars.SANDBOX_USD_PER_HOUR, "0.0073");
  });
  it("vars.gateway.SANDBOX_USD_PER_HOUR を書けばそれを優先する（上書きできる）", () => {
    const o = gen({
      sandbox: { instance: "standard-4" },
      vars: { gateway: { SANDBOX_USD_PER_HOUR: "0.5" } },
    });
    assert.equal(parseJsonc(o.gateway).vars.SANDBOX_USD_PER_HOUR, "0.5");
  });
  it("名前付きの 5 種類以外・型の誤り・未知のキーはエラー", () => {
    const bad = (sandbox) => validateConfig({ ...productionLike(), sandbox }).errors;
    assert.ok(bad({ instance: "basic" }).some((e) => e.includes("sandbox.instance")));
    assert.ok(bad({ instance: 2 }).some((e) => e.includes("sandbox.instance")));
    assert.ok(bad({ instanse: "lite" }).some((e) => e.includes("sandbox.instanse")));
    assert.ok(bad("lite").some((e) => e.includes("sandbox")));
  });
});

describe("sandbox.maxInstance（Clef が Sandbox を自動で上げる上限）", () => {
  const gen = (patch) =>
    generateAll(validated({ ...productionLike(), ...patch }), infra, templates);
  it("既定は standard-4。agent の SANDBOX_MAX_INSTANCE と gateway の同名の var に反映される（他の sandbox の設定だけ書いても落ちない）", () => {
    assert.equal(DEFAULTS.sandbox.maxInstance, "standard-4");
    for (const patch of [{}, { sandbox: {} }, { sandbox: { instance: "standard-1" } }]) {
      const o = gen(patch);
      assert.equal(parseJsonc(o.agent).vars.SANDBOX_MAX_INSTANCE, "standard-4");
      assert.equal(parseJsonc(o.gateway).vars.SANDBOX_MAX_INSTANCE, "standard-4");
    }
  });
  it("選べる 4 種類のどれかにできる", () => {
    for (const name of ["standard-1", "standard-2", "standard-3", "standard-4"]) {
      const o = gen({ sandbox: { maxInstance: name } });
      assert.equal(parseJsonc(o.agent).vars.SANDBOX_MAX_INSTANCE, name);
      assert.equal(parseJsonc(o.gateway).vars.SANDBOX_MAX_INSTANCE, name);
    }
  });
  it("null で無効（空文字になる = Clef を呼ばず、昇格しない）。agent と gateway の両方", () => {
    const o = gen({ sandbox: { maxInstance: null } });
    assert.equal(parseJsonc(o.agent).vars.SANDBOX_MAX_INSTANCE, "");
    assert.equal(parseJsonc(o.gateway).vars.SANDBOX_MAX_INSTANCE, "");
  });
  it("web には出さない（Sandbox を持たない）", () => {
    assert.equal(parseJsonc(gen({}).web).vars.SANDBOX_MAX_INSTANCE, undefined);
  });
  it("廃止した SANDBOX_HEAVY_INSTANCE・SANDBOX_AGENT_MAX_INSTANCE は、どの生成物にも出ない。未置換の雛形も残らない", () => {
    const o = gen({});
    for (const app of ["agent", "gateway", "web"]) {
      assert.ok(!o[app].includes("SANDBOX_HEAVY_INSTANCE"), app);
      assert.ok(!o[app].includes("SANDBOX_AGENT_MAX_INSTANCE"), app);
      assert.ok(!o[app].includes("<SANDBOX_MAX_INSTANCE>"), app);
    }
  });
  it("lite・名前にない値・型の誤り・空文字・未知のキーはエラー", () => {
    const bad = (sandbox) => validateConfig({ ...productionLike(), sandbox }).errors;
    for (const v of ["lite", "basic", "standard-9", 3, true, "", "off"]) {
      assert.ok(
        bad({ maxInstance: v }).some((e) => e.includes("sandbox.maxInstance")),
        String(v),
      );
    }
    assert.ok(bad({ maxInstanse: "standard-3" }).some((e) => e.includes("sandbox.maxInstanse")));
  });
  it("廃止したキー（heavyInstance・agentMaxInstance）は、maxInstance に移るよう案内するエラーにする", () => {
    const bad = (sandbox) => validateConfig({ ...productionLike(), sandbox }).errors;
    for (const key of ["heavyInstance", "agentMaxInstance"]) {
      const errors = bad({ [key]: "standard-3" });
      assert.ok(
        errors.some((e) => e.includes(`sandbox.${key}`) && e.includes("maxInstance")),
        key,
      );
    }
  });
  it("Clef の判断の閾値（SANDBOX_CLEF_THRESHOLDS）は、vars.agent で任意に上書きできる（既定は空 = 既定の閾値）", () => {
    assert.equal(parseJsonc(gen({}).agent).vars.SANDBOX_CLEF_THRESHOLDS, "");
    const o = gen({ vars: { agent: { SANDBOX_CLEF_THRESHOLDS: "four=0.5" } } });
    assert.equal(parseJsonc(o.agent).vars.SANDBOX_CLEF_THRESHOLDS, "four=0.5");
    assert.equal(parseJsonc(o.gateway).vars.SANDBOX_CLEF_THRESHOLDS, undefined);
  });
});

describe("concurrency.maxTasks（利用者ごとの同時実行数）", () => {
  const gen = (patch) =>
    generateAll(validated({ ...productionLike(), ...patch }), infra, templates);
  it("gateway の MAX_CONCURRENT_TASKS に反映される", () => {
    assert.equal(parseJsonc(gen({}).gateway).vars.MAX_CONCURRENT_TASKS, "3");
    assert.equal(
      parseJsonc(gen({ concurrency: { maxTasks: 10 } }).gateway).vars.MAX_CONCURRENT_TASKS,
      "10",
    );
  });
  it("省略（concurrency 自体・maxTasks）は既定の 2", () => {
    assert.equal(DEFAULTS.concurrency.maxTasks, 2);
    assert.equal(
      parseJsonc(gen({ concurrency: undefined }).gateway).vars.MAX_CONCURRENT_TASKS,
      "2",
    );
    assert.equal(parseJsonc(gen({ concurrency: {} }).gateway).vars.MAX_CONCURRENT_TASKS, "2");
  });
  it("agent と web には出さない（UserDO だけが使う）", () => {
    const o = gen({});
    assert.equal(parseJsonc(o.agent).vars.MAX_CONCURRENT_TASKS, undefined);
    assert.equal(parseJsonc(o.web).vars.MAX_CONCURRENT_TASKS, undefined);
  });
  it("1 以上の整数以外・未知のキー・オブジェクトでない値はエラー", () => {
    const bad = (concurrency) => validateConfig({ ...productionLike(), concurrency }).errors;
    for (const v of [0, -1, 1.5, "3", true, null, Number.NaN]) {
      assert.ok(
        bad({ maxTasks: v }).some((e) => e.includes("concurrency.maxTasks")),
        String(v),
      );
    }
    assert.ok(bad({ maxTask: 3 }).some((e) => e.includes("concurrency.maxTask")));
    assert.ok(bad(3).some((e) => e.includes("concurrency")));
  });
});

describe("depsCache.enabled（D14）", () => {
  const gen = (patch) =>
    generateAll(validated({ ...productionLike(), ...patch }), infra, templates);
  it("既定は有効。agent の DEPS_CACHE_ENABLED に反映される", () => {
    assert.equal(parseJsonc(gen({}).agent).vars.DEPS_CACHE_ENABLED, "true");
    assert.equal(parseJsonc(gen({ depsCache: {} }).agent).vars.DEPS_CACHE_ENABLED, "true");
  });
  it("false で無効にできる", () => {
    const o = gen({ depsCache: { enabled: false } });
    assert.equal(parseJsonc(o.agent).vars.DEPS_CACHE_ENABLED, "false");
  });
  it("agent の設定は DepsCacheDO（コンテナを持たない）を DO のバインディングと exports に持つ", () => {
    const a = parseJsonc(gen({}).agent);
    assert.ok(
      a.durable_objects.bindings.some(
        (b) => b.name === "DEPS_CACHE_DO" && b.class_name === "DepsCacheDO",
      ),
    );
    assert.deepEqual(a.exports.DepsCacheDO, { type: "durable-object", storage: "sqlite" });
    // コンテナは SandboxDO のものだけ（スナップショットは作ったイメージに結び付くので、同じクラスで作る）
    assert.deepEqual(
      a.containers.map((c) => c.class_name),
      ["SandboxDO"],
    );
  });
  it("型の誤り・未知のキーはエラー", () => {
    const bad = (depsCache) => validateConfig({ ...productionLike(), depsCache }).errors;
    assert.ok(bad({ enabled: "yes" }).some((e) => e.includes("depsCache.enabled")));
    assert.ok(bad({ enable: true }).some((e) => e.includes("depsCache.enable")));
    assert.ok(bad(true).some((e) => e.includes("depsCache")));
  });
});

describe("入力の検証", () => {
  const bad = (patch) => validateConfig({ ...productionLike(), ...patch }).errors;
  it("accountId が 32 桁の 16 進数でない", () => {
    assert.ok(bad({ accountId: "abc" }).some((e) => e.includes("accountId")));
  });
  it("publicBaseUrl が無い・https でない・<...> を含む", () => {
    assert.ok(bad({ publicBaseUrl: undefined }).some((e) => e.includes("publicBaseUrl")));
    assert.ok(
      bad({ publicBaseUrl: "http://x.example.com" }).some((e) => e.includes("publicBaseUrl")),
    );
    assert.ok(
      bad({ publicBaseUrl: "https://<YOUR_GATEWAY_HOST>" }).some((e) =>
        e.includes("publicBaseUrl"),
      ),
    );
  });
  it("末尾の / は取り除く", () => {
    const c = validated({ ...productionLike(), publicBaseUrl: "https://rovo.example.com/" });
    assert.equal(c.publicBaseUrl, "https://rovo.example.com");
  });
  it("認可のルールが 1 つも無い", () => {
    assert.ok(bad({ allowed: {} }).some((e) => e.includes("allowed")));
  });
  it("org と team は対（片方だけは不正）", () => {
    assert.ok(bad({ allowed: { org: "o", userIds: "1" } }).some((e) => e.includes("allowed")));
    assert.deepEqual(bad({ allowed: { org: "o", team: "t" } }), []);
  });
  it("userIds は正の整数だけ", () => {
    assert.ok(bad({ allowed: { userIds: ["1", "x"] } }).some((e) => e.includes("userIds")));
    assert.ok(bad({ allowed: { userIds: ["0"] } }).some((e) => e.includes("userIds")));
  });
  it("未知のキーは誤記として拒否する", () => {
    assert.ok(bad({ publicBaseURL: "x" }).some((e) => e.includes("publicBaseURL")));
  });
  it("<...> のプレースホルダが残った値を拒否する", () => {
    assert.ok(
      bad({ githubApp: { id: "<YOUR_GITHUB_APP_ID>", clientId: "x" } }).some((e) =>
        e.includes("githubApp"),
      ),
    );
  });
  it("workerNames が重複・空", () => {
    assert.ok(
      bad({ workerNames: { gateway: "a", agent: "a", web: "b" } }).some((e) =>
        e.includes("workerNames"),
      ),
    );
    assert.ok(
      bad({ workerNames: { gateway: "", agent: "a", web: "b" } }).some((e) =>
        e.includes("workerNames"),
      ),
    );
  });
  it("雛形に無い vars のキーは拒否する（誤記で黙って無視しない）", () => {
    assert.ok(
      bad({ vars: { gateway: { NO_SUCH_VAR: "1" } } }).some((e) => e.includes("NO_SUCH_VAR")),
    );
  });
  it("vars で上書きできるのは雛形にある値だけ。secret の名前は拒否する", () => {
    assert.ok(
      bad({ vars: { gateway: { TOKEN_ENC_KEY: "x" } } }).some((e) => e.includes("TOKEN_ENC_KEY")),
    );
  });
  it("infra に ai_web_gateway_id が無い（古い infra.json）なら生成せず、terraform apply を促す", () => {
    const { ai_web_gateway_id: _omit, ...old } = infra;
    assert.throws(
      () => generateAll(validated(productionLike()), old, templates),
      /ai_web_gateway_id.*terraform apply/,
    );
  });
  it("infra の値が欠けていたら生成しない", () => {
    assert.throws(
      () => generateAll(validated(productionLike()), { ...infra, kv_namespace_id: "" }, templates),
      /kv_namespace_id/,
    );
  });
});

describe("tfvars", () => {
  it("Terraform の変数（account_id / name_prefix / worker_names）を config から作る", () => {
    assert.deepEqual(tfvars(validated(productionLike())), {
      account_id: ACCOUNT_ID,
      name_prefix: "acme",
      worker_names: { gateway: "acme-gateway", agent: "acme-agent", web: "acme-web" },
    });
  });
});

describe("CLI（偽の terraform。実際の Terraform には触れない）", () => {
  const work = mkdtempSync(join(tmpdir(), "rovo-dc-"));
  after(() => rmSync(work, { recursive: true, force: true }));
  const bin = join(work, "bin");
  mkdirSync(bin);
  const log = join(work, "terraform.log");
  // 偽の terraform: 呼ばれた引数を記録する。sensitive の出力（gateway_cloudflare_api_token）は秘密のダミーを返す
  writeFileSync(
    join(bin, "terraform"),
    `#!/usr/bin/env bash
echo "$*" >> "${log}"
case "$*" in
  *"output -raw kv_namespace_id") printf 'kv-namespace-id-example' ;;
  *"output -raw archive_bucket_name") printf 'acme-archive' ;;
  *"output -raw ai_gateway_id") printf 'acme-gateway' ;;
  *"output -raw ai_web_gateway_id") printf 'acme-web-gateway' ;;
  *) echo "SECRET-SENTINEL-VALUE"; exit 0 ;;
esac
`,
  );
  chmodSync(join(bin, "terraform"), 0o755);
  const cfgPath = join(work, "rovo.config.json");
  writeFileSync(cfgPath, JSON.stringify(productionLike()));
  const deployDir = join(work, "deploy");
  const run = (...args) => {
    writeFileSync(log, "");
    const r = spawnSync("node", [join(here, "deploy-config.mjs"), ...args], {
      cwd: work,
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH}`,
        ROVO_CONFIG: cfgPath,
        ROVO_DEPLOY_DIR: deployDir,
      },
      encoding: "utf8",
    });
    return { ...r, calls: read(log).trim() };
  };

  it("既定: terraform の非秘密の出力を名前指定の -raw で 4 つだけ読み、infra.json と 3 つの設定を書く", () => {
    const r = run();
    assert.equal(r.status, 0, r.stderr);
    const calls = r.calls.split("\n");
    assert.equal(calls.length, 4, r.calls);
    for (const name of [
      "kv_namespace_id",
      "archive_bucket_name",
      "ai_gateway_id",
      "ai_web_gateway_id",
    ]) {
      assert.ok(
        calls.some((c) => c.endsWith(`output -raw ${name}`)),
        name,
      );
    }
    assert.ok(!r.calls.includes("-json"), "-json は sensitive の値も出すので使わない");
    assert.ok(!r.calls.includes("gateway_cloudflare_api_token"));
    assert.deepEqual(JSON.parse(read(join(deployDir, "infra.json"))), infra);
    for (const n of ["gateway", "agent", "web"]) {
      assert.deepEqual(parseJsonc(read(join(deployDir, `${n}.wrangler.jsonc`))), expected(n));
    }
    // どこにも秘密のダミーが出ない
    for (const f of [
      "infra.json",
      "gateway.wrangler.jsonc",
      "agent.wrangler.jsonc",
      "web.wrangler.jsonc",
    ]) {
      assert.ok(!read(join(deployDir, f)).includes("SECRET-SENTINEL"));
    }
    assert.ok(!r.stdout.includes("SECRET-SENTINEL") && !r.stderr.includes("SECRET-SENTINEL"));
  });

  it("--check: 差分が無ければ 0 で、terraform を呼ばない", () => {
    const r = run("--check");
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.calls, "");
  });

  it("--check: 手で書き換えられていたら 1 で、ファイルを直さない", () => {
    const f = join(deployDir, "web.wrangler.jsonc");
    const before = read(f);
    writeFileSync(
      f,
      before.replace('"WEB_SEARCH_PROVIDER": "linkup"', '"WEB_SEARCH_PROVIDER": "exa"'),
    );
    const tampered = read(f);
    const r = run("--check");
    assert.equal(r.status, 1);
    assert.match(r.stderr, /web\.wrangler\.jsonc/);
    assert.equal(read(f), tampered);
    writeFileSync(f, before);
  });

  it("--check: config を変えたのに作り直していなければ 1", () => {
    const changed = {
      ...productionLike(),
      budget: { monthlyUsd: 77, taskUsd: 5, consultUsd: 0.25 },
    };
    writeFileSync(cfgPath, JSON.stringify(changed));
    const r = run("--check");
    assert.equal(r.status, 1);
    assert.match(r.stderr, /gateway\.wrangler\.jsonc/);
    writeFileSync(cfgPath, JSON.stringify(productionLike()));
  });

  it("--check: 生成済みのファイルが無ければ 1", () => {
    const r = spawnSync("node", [join(here, "deploy-config.mjs"), "--check"], {
      cwd: work,
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH}`,
        ROVO_CONFIG: cfgPath,
        ROVO_DEPLOY_DIR: join(work, "nodir"),
      },
      encoding: "utf8",
    });
    assert.equal(r.status, 1);
  });

  it("--no-terraform: 保存済みの infra.json から作り直し、terraform を呼ばない", () => {
    const r = run("--no-terraform");
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.calls, "");
  });

  it("config が不正なら 1 で、terraform を呼ばない", () => {
    writeFileSync(cfgPath, JSON.stringify({ ...productionLike(), publicBaseUrl: "" }));
    const r = run();
    assert.equal(r.status, 1);
    assert.match(r.stderr, /publicBaseUrl/);
    assert.equal(r.calls, "");
    writeFileSync(cfgPath, JSON.stringify(productionLike()));
  });

  it("tfvars: JSON を標準出力に出す。terraform は呼ばない", () => {
    const r = run("tfvars");
    assert.equal(r.status, 0, r.stderr);
    assert.equal(JSON.parse(r.stdout).account_id, ACCOUNT_ID);
    assert.equal(r.calls, "");
  });

  it("get: config の値を 1 つ読む（setup.sh が使う）", () => {
    const r = run("get", "publicBaseUrl");
    assert.equal(r.stdout.trim(), "https://rovo.example.com");
    assert.equal(run("get", "githubAppConfigured").stdout.trim(), "true");
  });

  it("GitHub App が未設定なら警告を出す", () => {
    writeFileSync(cfgPath, JSON.stringify({ ...productionLike(), githubApp: undefined }));
    const r = run("--no-terraform");
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stderr, /GitHub App/);
    assert.equal(run("get", "githubAppConfigured").stdout.trim(), "false");
    writeFileSync(cfgPath, JSON.stringify(productionLike()));
  });
});
