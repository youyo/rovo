// test:affected の計画: 変更されたファイルの一覧 → 流す mise タスクの順序付きリスト。
// 純粋関数だけ（git も mise も呼ばない）。実行は test-affected.mjs。
//
// 規則は RULES の表（上から最初に当たったものを採用）。どれにも当たらないファイルは安全側で全部流す。
// 根拠はリポジトリの実際の構成:
//  - workspace 依存（package.json）: agent -> audit, models / gateway -> audit, dashboard-contract, models /
//    dashboard -> dashboard-contract / web -> audit。
//  - gateway の E2E の dashboard*.e2e.test.ts は apps/dashboard/dist（build:dashboard の成果物）を配信して検証する。
//  - dashboard の Playwright は apps/gateway/test/support/gateway-server・test/e2e/{fake-admin,oauth-client} で
//    wrangler dev + 偽 GitHub を起動する（gateway の変更が波及する）。
//  - gateway の通しの E2E（vitest.e2e-full）は agent と web の test/support を取り込み、3 つの Worker を同時に起動する。
//  - scripts/*.test.mjs は apps/agent/src の container-scripts.ts / deps-scripts.ts / secret-scan.ts や
//    apps/agent/container/pm-prepare.mjs を読む。
//  - E2E は dev registry・ポート・Docker を取り合うので直列。順序は mise.toml の description と同じ
//    （gateway → nologs → userids → dashboard → docker → full）。

/** 実行順の正準リスト。mise.toml の test と同じ内容（+ lint を先頭、+ test:test-affected）。 */
const ORDER = [
  "lint",
  "test:unit:audit",
  "test:unit:models",
  "test:unit:web-format",
  "test:unit:dashboard",
  "test:dashboard:dist",
  "test:unit:dashboard-contract",
  "test:unit:gateway",
  "test:unit:agent",
  "test:unit:agent-git",
  "test:unit:web",
  "test:deploy",
  "test:deploy:config",
  "test:setup",
  "test:github-app",
  "test:byok",
  "test:deps-scripts",
  "test:promote-state",
  "test:scale-facts",
  "test:pm-prepare",
  "test:commit-author",
  "test:test-affected",
  "test:plugin",
  "test:infra",
  "test:fake-github",
  "test:e2e:gateway",
  "test:e2e:gateway:nologs",
  "test:e2e:gateway:userids",
  "test:e2e:dashboard",
  "test:e2e:docker",
  "test:e2e:full",
];

/** 全部（`mise run test` 相当 + lint）。test:plugin は claude の CLI が要り test に含まれないので除く。 */
export const ALL_TASKS = ORDER.filter((t) => t !== "test:plugin");

const GATEWAY_E2E = ["test:e2e:gateway", "test:e2e:gateway:nologs", "test:e2e:gateway:userids"];
const GATEWAY_ALL = [
  "test:unit:gateway",
  "test:fake-github",
  ...GATEWAY_E2E,
  "test:e2e:dashboard",
  "test:e2e:full",
];
const AGENT_ALL = [
  "test:unit:agent",
  "test:unit:agent-git",
  "test:deps-scripts",
  "test:promote-state",
  "test:scale-facts",
  "test:pm-prepare",
  "test:e2e:docker",
  "test:e2e:full",
];
const DASHBOARD_E2E = "test:e2e:dashboard";
const DASHBOARD_SPEC = /^apps\/dashboard\/e2e\/[^/]+\.spec\.ts$/;

/**
 * [glob, タスク, オプション]。glob は `**`（0 個以上のディレクトリ/任意）と `*`（/ 以外）。上から最初に当たったものを採用。
 * タスクが空 = lint だけで足りる（テストが無い）。
 */
const RULES = [
  // ---- mod（claude の CLI でしか流せない。test には含まれない） ----
  ["plugins/rovo/**", ["test:plugin"]],
  [".claude-plugin/**", ["test:plugin"]],

  // ---- dashboard ----
  ["apps/dashboard/test/**", ["test:unit:dashboard"]],
  // README 用の撮影・社会用プレビュー画像（docs:screenshots / docs:social-preview）は test に含まれない
  ["apps/dashboard/e2e/docs-*", []],
  ["apps/dashboard/e2e/*.docs.ts", []],
  ["apps/dashboard/playwright.docs.config.ts", []],
  ["apps/dashboard/scripts/**", []],
  // spec 単体は dashboard E2E をその spec だけに絞る（collectSpecs で処理）。fixtures・global-setup 等の共通部品はその下の規則で全 spec
  ["apps/dashboard/e2e/*.spec.ts", [DASHBOARD_E2E], { spec: true }],
  ["apps/dashboard/e2e/**", [DASHBOARD_E2E]],
  ["apps/dashboard/playwright.config.ts", [DASHBOARD_E2E]],
  [
    "apps/dashboard/**",
    ["test:unit:dashboard", "test:dashboard:dist", "test:e2e:gateway", DASHBOARD_E2E],
  ],

  // ---- packages ----
  [
    "packages/dashboard-contract/**",
    [
      "test:unit:dashboard-contract",
      "test:unit:dashboard",
      "test:unit:gateway",
      "test:e2e:gateway",
      DASHBOARD_E2E,
    ],
  ],
  ["packages/models/**", ["test:unit:models", "test:unit:gateway", "test:unit:agent"]],
  // web の結果の整形。ワーカー（agent）と consult（gateway の UserDO）が使う
  ["packages/web-format/**", ["test:unit:web-format", "test:unit:gateway", "test:unit:agent"]],
  [
    "packages/audit/**",
    ["test:unit:audit", "test:unit:gateway", "test:unit:agent", "test:unit:web"],
  ],

  // ---- gateway ----
  ["apps/gateway/test/unit/**", ["test:unit:gateway"]],
  ["apps/gateway/vitest.config.ts", ["test:unit:gateway"]],
  ["apps/gateway/test/fake-github/*.test.ts", ["test:fake-github"]],
  ["apps/gateway/vitest.fake-github.config.ts", ["test:fake-github"]],
  // 偽 GitHub のサーバー本体は E2E 全部が使う
  [
    "apps/gateway/test/fake-github/**",
    ["test:fake-github", ...GATEWAY_E2E, DASHBOARD_E2E, "test:e2e:full"],
  ],
  ["apps/gateway/test/e2e/*.nologs.test.ts", ["test:e2e:gateway:nologs"]],
  ["apps/gateway/test/e2e/global-setup-nologs.ts", ["test:e2e:gateway:nologs"]],
  ["apps/gateway/vitest.e2e-nologs.config.ts", ["test:e2e:gateway:nologs"]],
  ["apps/gateway/test/e2e/*.userids.test.ts", ["test:e2e:gateway:userids"]],
  ["apps/gateway/test/e2e/global-setup-userids.ts", ["test:e2e:gateway:userids"]],
  ["apps/gateway/test/e2e/userids-constants.ts", ["test:e2e:gateway:userids"]],
  ["apps/gateway/vitest.e2e-userids.config.ts", ["test:e2e:gateway:userids"]],
  ["apps/gateway/vitest.e2e.config.ts", ["test:e2e:gateway"]],
  // dashboard の Playwright が取り込む部品
  ["apps/gateway/test/e2e/fake-admin.ts", [...GATEWAY_E2E, DASHBOARD_E2E]],
  ["apps/gateway/test/e2e/oauth-client.ts", [...GATEWAY_E2E, DASHBOARD_E2E]],
  ["apps/gateway/test/e2e/**", GATEWAY_E2E],
  ["apps/gateway/test/full/**", ["test:e2e:full"]],
  ["apps/gateway/vitest.e2e-full.config.ts", ["test:e2e:full"]],
  ["apps/gateway/test/support/**", [...GATEWAY_E2E, DASHBOARD_E2E, "test:e2e:full"]],
  ["apps/gateway/**", GATEWAY_ALL],

  // ---- agent ----
  ["apps/agent/test/unit/**", ["test:unit:agent"]],
  ["apps/agent/test/contract/**", ["test:unit:agent"]],
  ["apps/agent/vitest.config.ts", ["test:unit:agent"]],
  ["apps/agent/test/node/**", ["test:unit:agent-git"]],
  ["apps/agent/vitest.node.config.ts", ["test:unit:agent-git"]],
  // 実ネットワーク版（test:e2e:net）は test に含まれない
  ["apps/agent/test/e2e-net/**", []],
  ["apps/agent/vitest.e2e-net.config.ts", []],
  ["apps/agent/test/e2e/**", ["test:e2e:docker"]],
  ["apps/agent/vitest.e2e.config.ts", ["test:e2e:docker"]],
  // gateway の通しの E2E も取り込む
  ["apps/agent/test/support/**", ["test:e2e:docker", "test:e2e:full"]],
  ["apps/agent/container/**", ["test:pm-prepare", "test:e2e:docker", "test:e2e:full"]],
  ["apps/agent/**", AGENT_ALL],

  // ---- web ----
  ["apps/web/test/unit/**", ["test:unit:web"]],
  ["apps/web/test/contract/**", ["test:unit:web"]],
  ["apps/web/**", ["test:unit:web", "test:e2e:full"]],

  // ---- scripts（node:test の *.test.mjs / bash の自己確認と、対応する mise のタスク） ----
  ["scripts/**/*.md", []],
  ["scripts/byok*.mjs", ["test:byok"]],
  ["scripts/commit-author*.mjs", ["test:commit-author"]],
  ["scripts/dashboard-dist*.mjs", ["test:dashboard:dist"]],
  ["scripts/deploy-config*.mjs", ["test:deploy:config"]],
  ["scripts/fixtures/deploy-config/**", ["test:deploy:config"]],
  ["scripts/deploy.sh", ["test:deploy"]],
  ["scripts/test-deploy.sh", ["test:deploy"]],
  ["scripts/deps-scripts*.mjs", ["test:deps-scripts"]],
  // docs-check は lint（docs:check）の中で流れる
  ["scripts/docs-check*.mjs", []],
  ["scripts/github-app*.mjs", ["test:github-app"]],
  ["scripts/fixtures/github-app/**", ["test:github-app"]],
  ["scripts/pm-prepare*.mjs", ["test:pm-prepare"]],
  ["scripts/promote-state*.mjs", ["test:promote-state"]],
  ["scripts/scale-facts*.mjs", ["test:scale-facts"]],
  ["scripts/setup.sh", ["test:setup"]],
  ["scripts/test-setup.sh", ["test:setup"]],
  ["scripts/test-affected*.mjs", ["test:test-affected"]],
  // 公開前の点検（scan:secrets は test / lint に含まれない。手元で scan:secrets:selftest を流す）
  ["scripts/scan-*", []],
  ["scripts/test-scan-secrets.sh", []],
  // 実験用（実 Clef を呼ぶ。CI にも test にも含まれない）
  ["scripts/clef-model-experiment.mjs", []],

  // ---- デプロイの雛形・設定の生成器 ----
  ["deploy.example/**", ["test:deploy:config"]],
  ["rovo.config.example.json", ["test:deploy:config"]],

  // ---- 文書・infra ----
  ["docs/**", []],
  ["**/*.md", []],
  ["LICENSE", []],
  ["infra/**", ["test:infra"]],
  // ルートの設定（mise.toml・package.json・pnpm-lock.yaml・pnpm-workspace.yaml・tsconfig*・biome.json・.github/**）と
  // どれにも当たらないファイルは、下の fallback で全部。
];

function globToRegExp(glob) {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*") {
      if (glob[i + 1] === "*") {
        if (glob[i + 2] === "/") {
          re += "(?:.*/)?";
          i += 2;
        } else {
          re += ".*";
          i += 1;
        }
      } else {
        re += "[^/]*";
      }
    } else {
      re += c.replace(/[.+^${}()|[\]\\?]/g, "\\$&");
    }
  }
  return new RegExp(`^${re}$`);
}

const COMPILED = RULES.map(([glob, tasks, opts]) => ({
  re: globToRegExp(glob),
  tasks,
  spec: opts?.spec === true,
}));

/**
 * 変更ファイル（リポジトリ直下からの相対パス）→ 流す手順の順序付きリスト。
 * 各手順は { task, args? }。args があるのは dashboard の E2E を spec に絞るとき（apps/dashboard からの相対パス）。
 * @param {string[]} changedFiles
 * @param {{ exists?: (path: string) => boolean }} [opts] 削除された spec を除くための存在確認（既定は常に存在）
 */
export function planTests(changedFiles, opts = {}) {
  const exists = opts.exists ?? (() => true);
  const tasks = new Set(["lint"]);
  const specs = new Set();
  let all = false;
  let dashboardFull = false;

  for (const raw of changedFiles) {
    const file = raw.replace(/^\.\//, "");
    const rule = COMPILED.find((r) => r.re.test(file));
    if (!rule) {
      all = true;
      continue;
    }
    if (rule.spec && DASHBOARD_SPEC.test(file)) {
      if (exists(file)) specs.add(file.replace(/^apps\/dashboard\//, ""));
      continue;
    }
    for (const t of rule.tasks) {
      tasks.add(t);
      if (t === DASHBOARD_E2E) dashboardFull = true;
    }
  }

  if (all) return ALL_TASKS.map((task) => ({ task }));
  if (specs.size > 0) tasks.add(DASHBOARD_E2E);

  return ORDER.filter((t) => tasks.has(t)).map((task) => {
    if (task === DASHBOARD_E2E && !dashboardFull && specs.size > 0) {
      return { task, args: [...specs].sort() };
    }
    return { task };
  });
}

/** 計画の表示。 */
export function formatPlan(plan) {
  return plan
    .map((s, i) => `${i + 1}. mise run ${s.task}${s.args ? ` -- ${s.args.join(" ")}` : ""}`)
    .join("\n");
}

/** コマンドライン引数の解析（--base <ref> / --base=<ref> / --dry-run）。 */
export function parseArgs(argv) {
  const out = { base: undefined, dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--dry-run") out.dryRun = true;
    else if (a === "--base") {
      const v = argv[++i];
      if (!v || v.startsWith("--")) throw new Error("--base には ref が要ります");
      out.base = v;
    } else if (a.startsWith("--base=")) {
      out.base = a.slice("--base=".length);
      if (!out.base) throw new Error("--base には ref が要ります");
    } else throw new Error(`未知のオプション: ${a}`);
  }
  return out;
}
