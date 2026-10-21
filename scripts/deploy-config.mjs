// deploy:config のエントリ。下流の設定（rovo.config.json）と terraform の非秘密の出力から、
// deploy/{gateway,agent,web}.wrangler.jsonc を生成する。生成物はコミットする（デプロイの時に terraform を読まない）。
//
//   node scripts/deploy-config.mjs [generate] [--check] [--no-terraform]
//     既定        terraform の非秘密の出力 4 つを `terraform -chdir=infra output -raw <名前>` で読み、infra.json に保存して生成する
//     --no-terraform  terraform を呼ばず、保存済みの infra.json から作り直す
//     --check     terraform を呼ばず、作り直した結果と既存のファイルを比べる。差分があれば 1（下流の CI 用）。ファイルは書かない
//   node scripts/deploy-config.mjs tfvars        Terraform の変数（account_id / name_prefix / worker_names）を JSON で出す
//   node scripts/deploy-config.mjs get <キー>    config の値を 1 つ出す（publicBaseUrl / githubAppConfigured / githubAppId / namePrefix）
//
// 環境変数: ROVO_CONFIG（既定 rovo.config.json）、ROVO_DEPLOY_DIR（出力先。既定 deploy）、ROVO_INFRA_DIR（既定 <repo>/infra）
// 秘密の値は読まない・書かない。terraform の出力は名前を指定して -raw で読む（-json は sensitive の値も出すので使わない）。
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  APPS,
  checkInfra,
  generateAll,
  INFRA_OUTPUTS,
  loadTemplates,
  tfvars,
  validateConfig,
} from "./deploy-config-lib.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const fail = (msg) => {
  console.error(`エラー: ${msg}`);
  process.exit(1);
};

const args = process.argv.slice(2);
const sub = ["generate", "tfvars", "get"].includes(args[0] ?? "") ? args.shift() : "generate";
const flags = new Set(args.filter((a) => a.startsWith("--")));
for (const f of flags)
  if (!["--check", "--no-terraform"].includes(f)) fail(`未知のオプション: ${f}`);
const positional = args.filter((a) => !a.startsWith("--"));

const configPath = resolve(process.env.ROVO_CONFIG || "rovo.config.json");
const deployDir = resolve(process.env.ROVO_DEPLOY_DIR || "deploy");
const infraDir = resolve(process.env.ROVO_INFRA_DIR || join(root, "infra"));

if (!existsSync(configPath)) {
  fail(`設定ファイルが無い: ${configPath}（rovo.config.example.json をコピーして値を入れる）`);
}
let raw;
try {
  raw = JSON.parse(readFileSync(configPath, "utf8"));
} catch (e) {
  fail(`${configPath} を JSON として読めない: ${e.message}`);
}
const templates = loadTemplates();
const { config, errors, githubAppConfigured } = validateConfig(raw, templates);
if (errors.length > 0) {
  console.error(`エラー: ${configPath} が不正:`);
  for (const e of errors) console.error(`  - ${e}`);
  process.exit(1);
}

if (sub === "tfvars") {
  process.stdout.write(`${JSON.stringify(tfvars(config), null, 2)}\n`);
  process.exit(0);
}

if (sub === "get") {
  const key = positional[0];
  const table = {
    publicBaseUrl: config.publicBaseUrl,
    githubAppConfigured: String(githubAppConfigured),
    githubAppId: config.githubApp.id,
    namePrefix: config.namePrefix,
  };
  if (!(key in table)) fail(`未知のキー: ${key}（${Object.keys(table).join(" / ")}）`);
  console.log(table[key]);
  process.exit(0);
}

const infraPath = join(deployDir, "infra.json");
const check = flags.has("--check");
let infra;
if (check || flags.has("--no-terraform")) {
  if (!existsSync(infraPath))
    fail(`${infraPath} が無い（terraform apply のあとに mise run deploy:config で作る）`);
  infra = JSON.parse(readFileSync(infraPath, "utf8"));
} else {
  infra = {};
  for (const name of INFRA_OUTPUTS) {
    const r = spawnSync("terraform", [`-chdir=${infraDir}`, "output", "-raw", name], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    if (r.status !== 0) {
      fail(`terraform output ${name} を読めない（terraform apply が済んでいるか。資格情報は要る）`);
    }
    infra[name] = r.stdout.trim();
  }
}
try {
  checkInfra(infra);
} catch (e) {
  fail(e.message);
}

const out = generateAll(config, infra, templates);
const infraText = `${JSON.stringify(Object.fromEntries(INFRA_OUTPUTS.map((k) => [k, infra[k]])), null, 2)}\n`;
const files = [
  [infraPath, infraText],
  ...APPS.map((a) => [join(deployDir, `${a}.wrangler.jsonc`), out[a]]),
];

if (!githubAppConfigured) {
  console.error(
    "警告: githubApp（id / clientId）が未設定。ログインはできない（fail closed）。GitHub App を作ってから rovo.config.json に入れ、もう一度 deploy:config する",
  );
}

if (check) {
  const diffs = files.filter(([p, text]) => !existsSync(p) || readFileSync(p, "utf8") !== text);
  if (diffs.length > 0) {
    for (const [p] of diffs) console.error(`差分あり: ${p}`);
    console.error("deploy:config で作り直してコミットする（手で直さない）");
    process.exit(1);
  }
  console.log(`deploy:config --check OK（${files.length} ファイル）`);
  process.exit(0);
}

mkdirSync(deployDir, { recursive: true });
for (const [p, text] of files) {
  writeFileSync(p, text);
  console.log(`生成: ${p}`);
}
