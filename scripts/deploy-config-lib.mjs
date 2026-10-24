// deploy:config の生成器の本体（純粋な関数）。入出力は deploy-config.mjs が行う。
// 入力: rovo.config.json（秘密でない値だけ）+ infra.json（terraform の非秘密の出力 4 つ）+ deploy.example/ の雛形
// 出力: deploy/{gateway,agent,web}.wrangler.jsonc の文字列
// 雛形の <NAME> を値で置き換えるだけ（コメントは残る）。雛形にある値以外は書き出さない。
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
// Sandbox の大きさと単価の表は packages/models が 1 か所で持つ（依存のないファイルを Node の型除去で読む）
import {
  DEFAULT_MAX_SANDBOX_INSTANCE,
  DEFAULT_SANDBOX_INSTANCE,
  isSelectableSandboxInstance,
  SANDBOX_INSTANCES,
  sandboxUsdPerHour,
} from "../packages/models/src/sandbox.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

export const APPS = ["gateway", "agent", "web"];

/** 雛形の既定値（config で省略したとき）。deploy.example/ に以前書いてあった値と同じ。 */
export const DEFAULTS = {
  namePrefix: "rovo",
  workerNames: { gateway: "rovo-gateway", agent: "rovo-agent", web: "rovo-web" },
  budget: { monthlyUsd: 100, taskUsd: 10, consultUsd: 0.5 },
  // 利用者ごとに同時に実行できるタスクの上限（gateway の MAX_CONCURRENT_TASKS）。OSS の既定は 2
  concurrency: { maxTasks: 2 },
  models: {
    default: "anthropic/claude-sonnet-5-5",
    list: [
      "anthropic/claude-haiku-5-5",
      "anthropic/claude-sonnet-5-5",
      "anthropic/claude-opus-5-5",
      "workers-ai/@cf/openai/gpt-oss-120b",
      "workers-ai/@cf/openai/gpt-oss-20b",
    ],
    efforts: "",
  },
  // maxInstance: Clef（Workers AI の決定モデル）が Sandbox を自動で上げる上限。null で無効（Clef を呼ばず、昇格しない）
  sandbox: {
    instance: DEFAULT_SANDBOX_INSTANCE,
    maxInstance: DEFAULT_MAX_SANDBOX_INSTANCE,
  },
  // 依存関係のキャッシュ（D14。Containers のスナップショット）。public beta の機能なので、止められるようにしてある
  depsCache: { enabled: true },
  webBrowseEnabled: false,
  // gateway の workers.dev（と preview / version の URL）を有効にするか。独自ドメインに移ったら false にできる
  workersDev: true,
};

/** terraform の非秘密の出力。`terraform output -raw <名前>` を名前指定で読む（-json は sensitive の値も出すので使わない）。 */
export const INFRA_OUTPUTS = [
  "kv_namespace_id",
  "archive_bucket_name",
  "ai_gateway_id",
  // web 専用の AI Gateway（byok_only なし）。Web Search API をクレジットで払うため、Claude 用の ai_gateway_id と分ける
  "ai_web_gateway_id",
];

const TOP_KEYS = [
  "accountId",
  "namePrefix",
  "workerNames",
  "publicBaseUrl",
  "customDomain",
  "workersDev",
  "githubApp",
  "allowed",
  "budget",
  "concurrency",
  "models",
  "sandbox",
  "depsCache",
  "webBrowseEnabled",
  "vars",
];

export function loadTemplates() {
  return Object.fromEntries(
    APPS.map((n) => [n, readFileSync(join(root, "deploy.example", `${n}.wrangler.jsonc`), "utf8")]),
  );
}

// ---- JSONC ------------------------------------------------------------------

/** 行コメントとブロックコメントを除く。文字列の中は触らない。 */
export function stripJsonc(text) {
  let out = "";
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    const d = text[i + 1];
    if (c === '"') {
      let j = i + 1;
      while (j < text.length && text[j] !== '"') j += text[j] === "\\" ? 2 : 1;
      out += text.slice(i, j + 1);
      i = j + 1;
    } else if (c === "/" && d === "/") {
      while (i < text.length && text[i] !== "\n") i++;
    } else if (c === "/" && d === "*") {
      const end = text.indexOf("*/", i + 2);
      i = end === -1 ? text.length : end + 2;
    } else {
      out += c;
      i++;
    }
  }
  return out;
}

export function parseJsonc(text) {
  return JSON.parse(stripJsonc(text));
}

// ---- 検証 -------------------------------------------------------------------

const CUSTOM_DOMAIN =
  /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const PLACEHOLDER = /<[A-Za-z_][A-Za-z0-9_]*>/;
const isObj = (v) => typeof v === "object" && v !== null && !Array.isArray(v);
const isStr = (v) => typeof v === "string";

function findPlaceholders(v, path, errors) {
  if (isStr(v)) {
    if (PLACEHOLDER.test(v))
      errors.push(`${path}: <...> のプレースホルダが残っている（実際の値にする）`);
  } else if (Array.isArray(v)) {
    for (const [i, x] of v.entries()) findPlaceholders(x, `${path}[${i}]`, errors);
  } else if (isObj(v)) {
    for (const [k, x] of Object.entries(v)) findPlaceholders(x, `${path}.${k}`, errors);
  }
}

/** 雛形の vars のうち、プレースホルダでない（= 上書きできる）値のキー */
function literalVarKeys(templateText) {
  const keys = new Set();
  for (const m of templateText.matchAll(/^\s*"([A-Z][A-Z0-9_]*)":\s*"([^"]*)"/gm)) {
    if (!PLACEHOLDER.test(m[2])) keys.add(m[1]);
  }
  return keys;
}

/**
 * config を検証して、置き換えに使う値に整える。
 * @returns {{config: object|null, errors: string[], githubAppConfigured: boolean}}
 */
export function validateConfig(raw, templates = loadTemplates()) {
  const errors = [];
  if (!isObj(raw))
    return {
      config: null,
      errors: ["config: JSON のオブジェクトにする"],
      githubAppConfigured: false,
    };
  for (const k of Object.keys(raw)) {
    if (!TOP_KEYS.includes(k))
      errors.push(`${k}: 未知のキー（誤記か。使えるのは ${TOP_KEYS.join(" / ")}）`);
  }
  findPlaceholders(raw, "config", errors);

  const accountId = raw.accountId;
  if (!isStr(accountId) || !/^[0-9a-f]{32}$/.test(accountId)) {
    errors.push("accountId: 32 桁の小文字の 16 進数（Cloudflare のアカウント ID）にする");
  }

  const namePrefix = raw.namePrefix ?? DEFAULTS.namePrefix;
  if (!isStr(namePrefix) || !/^[a-z0-9][a-z0-9-]{0,30}[a-z0-9]$/.test(namePrefix)) {
    errors.push("namePrefix: 2〜32 文字の小文字・数字・ハイフンで、両端はハイフン以外にする");
  }

  const wn = { ...DEFAULTS.workerNames, ...(isObj(raw.workerNames) ? raw.workerNames : {}) };
  if (raw.workerNames !== undefined && !isObj(raw.workerNames))
    errors.push("workerNames: オブジェクトにする");
  for (const k of Object.keys(isObj(raw.workerNames) ? raw.workerNames : {})) {
    if (!APPS.includes(k)) errors.push(`workerNames.${k}: 未知のキー（gateway / agent / web）`);
  }
  const names = APPS.map((a) => wn[a]);
  if (names.some((n) => !isStr(n) || !/^[a-z0-9][a-z0-9_-]*$/.test(n))) {
    errors.push("workerNames: 空でない小文字・数字・ハイフン・アンダースコアの名前にする");
  } else if (new Set(names).size !== 3) {
    errors.push("workerNames: 3 つの名前は互いに異なる必要がある");
  }

  // 任意の独自ドメイン（ホスト名だけ。小文字・ドット 1 つ以上・スキーム/パス/ポート/末尾のドットなし）
  let customDomain = "";
  if (raw.customDomain !== undefined) {
    if (!isStr(raw.customDomain) || !CUSTOM_DOMAIN.test(raw.customDomain)) {
      errors.push(
        "customDomain: ホスト名だけにする（小文字。スキーム・パス・ポート・末尾のドットなし。例 rovo.example.com）",
      );
    } else {
      customDomain = raw.customDomain;
    }
  }

  // workers.dev の URL を止めるか（既定は有効）。止めると gateway に届く URL が customDomain だけになる
  const workersDev = raw.workersDev === undefined ? DEFAULTS.workersDev : raw.workersDev;
  if (typeof workersDev !== "boolean") {
    errors.push("workersDev: true / false にする");
  } else if (!workersDev && customDomain === "") {
    errors.push(
      "workersDev: false には customDomain が要る（customDomain が無いと gateway に届く URL が無くなる）",
    );
  }

  let publicBaseUrl = raw.publicBaseUrl;
  if ((!isStr(publicBaseUrl) || publicBaseUrl === "") && customDomain !== "") {
    publicBaseUrl = `https://${customDomain}`;
  }
  if (!isStr(publicBaseUrl) || publicBaseUrl === "") {
    errors.push(
      "publicBaseUrl: 必須（gateway の公開 URL。例 https://rovo.example.com。customDomain があれば省略できる）",
    );
  } else {
    publicBaseUrl = publicBaseUrl.replace(/\/+$/, "");
    let ok = false;
    try {
      const u = new URL(publicBaseUrl);
      ok =
        u.protocol === "https:" &&
        u.search === "" &&
        u.hash === "" &&
        !PLACEHOLDER.test(publicBaseUrl);
      if (ok && customDomain !== "" && u.host !== customDomain) {
        errors.push(
          `customDomain: publicBaseUrl のホスト（${u.host}）と customDomain（${customDomain}）を一致させる`,
        );
      }
    } catch {}
    if (!ok) errors.push("publicBaseUrl: https の URL にする（クエリ・フラグメントは付けない）");
  }

  const ga = raw.githubApp ?? {};
  let githubAppId = "";
  let githubClientId = "";
  if (!isObj(ga)) {
    errors.push("githubApp: オブジェクトにする");
  } else {
    for (const k of Object.keys(ga))
      if (!["id", "clientId"].includes(k)) errors.push(`githubApp.${k}: 未知のキー`);
    githubAppId = ga.id === undefined ? "" : String(ga.id);
    githubClientId = ga.clientId === undefined ? "" : String(ga.clientId);
    if (githubAppId !== "" && !/^\d+$/.test(githubAppId))
      errors.push("githubApp.id: 数字だけの App ID にする");
  }

  const al = raw.allowed;
  let org = "";
  let team = "";
  let userIds = "";
  if (!isObj(al)) {
    errors.push("allowed: org + team か userIds の少なくとも 1 つを設定する");
  } else {
    for (const k of Object.keys(al))
      if (!["org", "team", "userIds"].includes(k)) errors.push(`allowed.${k}: 未知のキー`);
    org = String(al.org ?? "").trim();
    team = String(al.team ?? "").trim();
    const ids =
      al.userIds === undefined || al.userIds === ""
        ? []
        : (Array.isArray(al.userIds) ? al.userIds : String(al.userIds).split(",")).map((x) =>
            String(x).trim(),
          );
    if (ids.some((x) => !/^[1-9][0-9]*$/.test(x)) || new Set(ids).size !== ids.length) {
      errors.push(
        "allowed.userIds: 正の整数の GitHub user ID（重複なし）にする。自分の ID は gh api user --jq .id",
      );
    }
    userIds = ids.join(",");
    if ((org === "") !== (team === ""))
      errors.push("allowed: org と team は対で設定する（片方だけは不正）");
    else if (org === "" && userIds === "")
      errors.push("allowed: org + team か userIds の少なくとも 1 つを設定する");
  }

  const b = { ...DEFAULTS.budget, ...(isObj(raw.budget) ? raw.budget : {}) };
  if (raw.budget !== undefined && !isObj(raw.budget)) errors.push("budget: オブジェクトにする");
  for (const k of Object.keys(isObj(raw.budget) ? raw.budget : {})) {
    if (!(k in DEFAULTS.budget))
      errors.push(`budget.${k}: 未知のキー（monthlyUsd / taskUsd / consultUsd）`);
  }
  for (const k of Object.keys(DEFAULTS.budget)) {
    if (typeof b[k] !== "number" || !Number.isFinite(b[k]) || b[k] <= 0)
      errors.push(`budget.${k}: 正の数にする`);
  }

  const cc = isObj(raw.concurrency) ? raw.concurrency : {};
  if (raw.concurrency !== undefined && !isObj(raw.concurrency))
    errors.push("concurrency: オブジェクトにする");
  for (const k of Object.keys(cc))
    if (k !== "maxTasks") errors.push(`concurrency.${k}: 未知のキー（maxTasks）`);
  const maxTasks = Object.hasOwn(cc, "maxTasks") ? cc.maxTasks : DEFAULTS.concurrency.maxTasks;
  if (!Number.isInteger(maxTasks) || maxTasks < 1)
    errors.push("concurrency.maxTasks: 1 以上の整数にする");

  const m = isObj(raw.models) ? raw.models : {};
  if (raw.models !== undefined && !isObj(raw.models)) errors.push("models: オブジェクトにする");
  for (const k of Object.keys(m))
    if (!["default", "list", "efforts"].includes(k)) errors.push(`models.${k}: 未知のキー`);
  const modelDefault = m.default ?? DEFAULTS.models.default;
  const list =
    m.list === undefined
      ? DEFAULTS.models.list
      : Array.isArray(m.list)
        ? m.list
        : String(m.list).split(",");
  const modelList = list.map((x) => String(x).trim()).filter((x) => x !== "");
  if (!isStr(modelDefault) || modelDefault.trim() === "")
    errors.push("models.default: モデルの id にする");
  let efforts = m.efforts ?? DEFAULTS.models.efforts;
  if (isObj(efforts))
    efforts = Object.entries(efforts)
      .map(([k, v]) => `${k}=${v}`)
      .join(",");
  if (!isStr(efforts) || /[\s]/.test(efforts))
    errors.push(
      "models.efforts: `<モデルの id>=<レベル>` のカンマ区切り（空白なし）か、{モデルの id: レベル} にする",
    );

  const sb = isObj(raw.sandbox) ? raw.sandbox : {};
  if (raw.sandbox !== undefined && !isObj(raw.sandbox)) errors.push("sandbox: オブジェクトにする");
  for (const k of Object.keys(sb)) {
    if (k === "heavyInstance" || k === "agentMaxInstance") {
      // 重いコマンドの規則とワーカーの sandbox_scale_up は無くなった（Clef に一本化）。上限は maxInstance 1 つ
      errors.push(
        `sandbox.${k}: 廃止した（Sandbox の昇格は Clef に一本化した）。上限は sandbox.maxInstance（standard-1〜standard-4 か null。既定 ${DEFAULT_MAX_SANDBOX_INSTANCE}）で設定する`,
      );
    } else if (k !== "instance" && k !== "maxInstance") {
      errors.push(`sandbox.${k}: 未知のキー`);
    }
  }
  const sandboxInstance = sb.instance ?? DEFAULT_SANDBOX_INSTANCE;
  if (!isStr(sandboxInstance) || !Object.hasOwn(SANDBOX_INSTANCES, sandboxInstance)) {
    errors.push(
      `sandbox.instance: ${Object.keys(SANDBOX_INSTANCES).join(" / ")} のどれかにする（既定 ${DEFAULT_SANDBOX_INSTANCE}）`,
    );
  }

  // Clef による昇格の上限: 省略は既定、null は無効。タスクが選べる 4 種類（lite を除く）のどれか
  const sandboxMaxInstance =
    sb.maxInstance === undefined ? DEFAULTS.sandbox.maxInstance : sb.maxInstance;
  if (sandboxMaxInstance !== null && !isSelectableSandboxInstance(sandboxMaxInstance)) {
    errors.push(
      `sandbox.maxInstance: standard-1 / standard-2 / standard-3 / standard-4 のどれか、または null（Clef による昇格をしない）にする（既定 ${DEFAULT_MAX_SANDBOX_INSTANCE}）`,
    );
  }

  const dc = isObj(raw.depsCache) ? raw.depsCache : {};
  if (raw.depsCache !== undefined && !isObj(raw.depsCache))
    errors.push("depsCache: オブジェクトにする");
  for (const k of Object.keys(dc)) if (k !== "enabled") errors.push(`depsCache.${k}: 未知のキー`);
  const depsCacheEnabled = dc.enabled ?? DEFAULTS.depsCache.enabled;
  if (typeof depsCacheEnabled !== "boolean") errors.push("depsCache.enabled: true / false にする");

  const web = raw.webBrowseEnabled ?? DEFAULTS.webBrowseEnabled;
  if (typeof web !== "boolean") errors.push("webBrowseEnabled: true / false にする");

  const varsRaw = raw.vars ?? {};
  const vars = { gateway: {}, agent: {}, web: {} };
  if (!isObj(varsRaw)) {
    errors.push("vars: { gateway: {...}, agent: {...}, web: {...} } にする");
  } else {
    for (const [app, kv] of Object.entries(varsRaw)) {
      if (!APPS.includes(app)) {
        errors.push(`vars.${app}: 未知のキー（gateway / agent / web）`);
        continue;
      }
      if (!isObj(kv)) {
        errors.push(`vars.${app}: オブジェクトにする`);
        continue;
      }
      const allowed = literalVarKeys(templates[app]);
      // 値は instance から計算するが、明示すればそれを優先する（料金改定・割引の反映）
      if (app === "gateway") allowed.add("SANDBOX_USD_PER_HOUR");
      for (const [k, v] of Object.entries(kv)) {
        if (!allowed.has(k)) {
          errors.push(
            `vars.${app}.${k}: 上書きできない（雛形に無い、または専用の項目で設定する値。secret はここに書かない）`,
          );
        } else if (!["string", "number", "boolean"].includes(typeof v)) {
          errors.push(`vars.${app}.${k}: 文字列・数・真偽値にする`);
        } else {
          vars[app][k] = String(v);
        }
      }
    }
  }

  if (errors.length > 0) return { config: null, errors, githubAppConfigured: false };
  return {
    errors,
    githubAppConfigured: githubAppId !== "" && githubClientId !== "",
    config: {
      accountId,
      namePrefix,
      workerNames: wn,
      publicBaseUrl,
      customDomain,
      workersDev,
      githubApp: { id: githubAppId, clientId: githubClientId },
      allowed: { org, team, userIds },
      budget: b,
      concurrency: { maxTasks },
      models: { default: modelDefault.trim(), list: modelList, efforts },
      sandbox: {
        instance: sandboxInstance,
        maxInstance: sandboxMaxInstance,
      },
      depsCache: { enabled: depsCacheEnabled },
      webBrowseEnabled: web,
      vars,
    },
  };
}

// ---- 生成 -------------------------------------------------------------------

/** infra.json（terraform の非秘密の出力）を検証する。 */
export function checkInfra(infra) {
  const missing = INFRA_OUTPUTS.filter(
    (k) => !isObj(infra) || !isStr(infra[k]) || infra[k].trim() === "",
  );
  if (missing.length > 0) {
    const hint = missing.includes("ai_web_gateway_id")
      ? "。ai_web_gateway_id は web 専用の AI Gateway の出力で、古い infra.json には無い（infra/ を terraform apply してから deploy:config を実行する）"
      : "";
    throw new Error(
      `infra の値が無い: ${missing.join(", ")}（terraform apply のあと deploy:config で読む）${hint}`,
    );
  }
}

const esc = (s) => JSON.stringify(String(s)).slice(1, -1);

function placeholderValues(config, infra) {
  return {
    GATEWAY_WORKER_NAME: config.workerNames.gateway,
    AGENT_WORKER_NAME: config.workerNames.agent,
    WEB_WORKER_NAME: config.workerNames.web,
    // gateway の Cloudflare の概要（Workers のリクエスト数）の対象。3 つの Worker をカンマ区切りで
    WORKER_NAMES: [
      config.workerNames.gateway,
      config.workerNames.agent,
      config.workerNames.web,
    ].join(","),
    KV_NAMESPACE_ID: infra.kv_namespace_id,
    ARCHIVE_BUCKET_NAME: infra.archive_bucket_name,
    AI_GATEWAY_ID: infra.ai_gateway_id,
    AI_WEB_GATEWAY_ID: infra.ai_web_gateway_id,
    ACCOUNT_ID: config.accountId,
    PUBLIC_BASE_URL: config.publicBaseUrl,
    GITHUB_APP_ID: config.githubApp.id,
    GITHUB_APP_CLIENT_ID: config.githubApp.clientId,
    ALLOWED_ORG: config.allowed.org,
    ALLOWED_TEAM: config.allowed.team,
    ALLOWED_USER_IDS: config.allowed.userIds,
    MONTHLY_BUDGET_USD: config.budget.monthlyUsd,
    TASK_BUDGET_USD: config.budget.taskUsd,
    CONSULT_BUDGET_USD: config.budget.consultUsd,
    MAX_CONCURRENT_TASKS: String(config.concurrency.maxTasks),
    AGENT_MODEL: config.models.default,
    AGENT_MODELS: config.models.list.join(","),
    MODEL_EFFORTS: config.models.efforts,
    SANDBOX_INSTANCE: config.sandbox.instance,
    // Clef が Sandbox を自動で上げる上限（agent と gateway の同名の var）。null は空文字 = Clef を呼ばず、昇格しない
    SANDBOX_MAX_INSTANCE: config.sandbox.maxInstance ?? "",
    // 推定費用の単価は instance から決める（vars.gateway.SANDBOX_USD_PER_HOUR を書けば、renderOne の上書きがそれを優先する）
    SANDBOX_USD_PER_HOUR: String(sandboxUsdPerHour(config.sandbox.instance)),
    DEPS_CACHE_ENABLED: String(config.depsCache.enabled),
    WEB_BROWSE_ENABLED: String(config.webBrowseEnabled),
  };
}

/** 値全体を JSON で埋めるプレースホルダ（雛形では "<NAME>" と引用符つきで書く。文字列用の esc() は通さない）。 */
function jsonPlaceholderValues(config) {
  return {
    // 独自ドメインがあれば Custom Domain として当てる。無ければ空配列（workers.dev はそのまま）
    ROUTES: config.customDomain ? [{ pattern: config.customDomain, custom_domain: true }] : [],
    // workers.dev の URL。preview / version の URL も同じ値で明示する（preview_urls は省略すると既存の設定を変えない）
    WORKERS_DEV: config.workersDev,
  };
}

const HEADER =
  "// このファイルは `mise run deploy:config` が生成した（deploy.example/ の雛形 + rovo.config.json + infra.json）。直接編集しない。\n";

function renderOne(app, text, values, overrides, jsonValues = {}) {
  let out = text;
  for (const [name, v] of Object.entries(jsonValues))
    out = out.replaceAll(`"<${name}>"`, () => JSON.stringify(v));
  for (const [name, v] of Object.entries(values)) out = out.replaceAll(`<${name}>`, () => esc(v));
  for (const [k, v] of Object.entries(overrides)) {
    const re = new RegExp(`^(\\s*"${k}":\\s*)"[^"]*"`, "m");
    out = out.replace(re, (_, pre) => `${pre}"${esc(v)}"`);
  }
  const left = out
    .split("\n")
    .map((l, i) => ({ l, n: i + 1 }))
    .filter(({ l }) => !l.trim().startsWith("//") && PLACEHOLDER.test(l));
  if (left.length > 0) {
    throw new Error(
      `${app}: 雛形のプレースホルダが置き換わっていない: ${left.map(({ l, n }) => `${n}行目 ${l.trim()}`).join(" / ")}`,
    );
  }
  return HEADER + out;
}

/** 検証済みの config と infra から 3 つの設定ファイルの文字列を作る。 */
export function generateAll(config, infra, templates) {
  checkInfra(infra);
  const values = placeholderValues(config, infra);
  const jsonValues = jsonPlaceholderValues(config);
  return Object.fromEntries(
    APPS.map((a) => [a, renderOne(a, templates[a], values, config.vars[a], jsonValues)]),
  );
}

/** Terraform の変数（-var-file に渡す JSON）。account id・名前の接頭辞・Worker 名を config から渡す。 */
export function tfvars(config) {
  return {
    account_id: config.accountId,
    name_prefix: config.namePrefix,
    worker_names: { ...config.workerNames },
  };
}
