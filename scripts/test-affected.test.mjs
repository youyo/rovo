// test:affected の計画関数の Unit テスト（node:test。外部 I/O なし）
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ALL_TASKS, formatPlan, parseArgs, planTests } from "./test-affected-lib.mjs";

const tasks = (files, opts) => planTests(files, opts).map((s) => s.task);

const E2E_ORDER = [
  "test:e2e:gateway",
  "test:e2e:gateway:nologs",
  "test:e2e:gateway:userids",
  "test:e2e:dashboard",
  "test:e2e:docker",
  "test:e2e:full",
];

describe("planTests: 先頭と変更なし", () => {
  it("変更が無くても lint だけは入る", () => {
    assert.deepEqual(tasks([]), ["lint"]);
  });
  it("lint は常に先頭", () => {
    assert.equal(tasks(["apps/web/src/index.ts"])[0], "lint");
  });
});

describe("planTests: dashboard", () => {
  it("src の変更は unit・成果物の検査・dist を配信する gateway E2E・dashboard E2E（全 spec）", () => {
    const plan = planTests(["apps/dashboard/src/App.tsx"]);
    assert.deepEqual(
      plan.map((s) => s.task),
      [
        "lint",
        "test:unit:dashboard",
        "test:dashboard:dist",
        "test:e2e:gateway",
        "test:e2e:dashboard",
      ],
    );
    assert.equal(plan.find((s) => s.task === "test:e2e:dashboard").args, undefined);
  });
  it("test/ だけなら unit:dashboard だけ", () => {
    assert.deepEqual(tasks(["apps/dashboard/test/api.test.ts"]), ["lint", "test:unit:dashboard"]);
  });
  it("spec だけの変更は、その spec に絞る（apps/dashboard からの相対パス）", () => {
    const plan = planTests([
      "apps/dashboard/e2e/layout.spec.ts",
      "apps/dashboard/e2e/login.spec.ts",
    ]);
    assert.deepEqual(
      plan.map((s) => s.task),
      ["lint", "test:e2e:dashboard"],
    );
    assert.deepEqual(plan[1].args, ["e2e/layout.spec.ts", "e2e/login.spec.ts"]);
  });
  it("共通部品（fixtures.ts など）の変更は全 spec", () => {
    for (const f of ["fixtures.ts", "global-setup.ts", "state.ts", "api.ts", "tsconfig.json"]) {
      const plan = planTests([`apps/dashboard/e2e/${f}`, "apps/dashboard/e2e/layout.spec.ts"]);
      const e = plan.find((s) => s.task === "test:e2e:dashboard");
      assert.ok(e, f);
      assert.equal(e.args, undefined, f);
    }
    const p = planTests(["apps/dashboard/playwright.config.ts"]);
    assert.equal(p.find((s) => s.task === "test:e2e:dashboard").args, undefined);
  });
  it("spec の変更と src の変更が混ざれば全 spec", () => {
    const plan = planTests(["apps/dashboard/e2e/layout.spec.ts", "apps/dashboard/src/x.ts"]);
    assert.equal(plan.find((s) => s.task === "test:e2e:dashboard").args, undefined);
  });
  it("削除された spec は流す対象にしない", () => {
    const plan = planTests(["apps/dashboard/e2e/gone.spec.ts"], { exists: () => false });
    assert.deepEqual(
      plan.map((s) => s.task),
      ["lint"],
    );
  });
  it("README 用の撮影（docs:screenshots）の部品は test に含まれないので lint だけ", () => {
    assert.deepEqual(
      tasks([
        "apps/dashboard/e2e/docs-screenshots.docs.ts",
        "apps/dashboard/playwright.docs.config.ts",
      ]),
      ["lint"],
    );
  });
});

describe("planTests: contract・gateway・agent・web・packages", () => {
  it("dashboard-contract は dashboard と gateway の両方に波及する", () => {
    assert.deepEqual(tasks(["packages/dashboard-contract/src/index.ts"]), [
      "lint",
      "test:unit:dashboard",
      "test:unit:dashboard-contract",
      "test:unit:gateway",
      "test:e2e:gateway",
      "test:e2e:dashboard",
    ]);
  });
  it("gateway/src は unit・偽 GitHub・gateway E2E 3 種・dashboard E2E・通し", () => {
    assert.deepEqual(tasks(["apps/gateway/src/index.ts"]), [
      "lint",
      "test:unit:gateway",
      "test:fake-github",
      "test:e2e:gateway",
      "test:e2e:gateway:nologs",
      "test:e2e:gateway:userids",
      "test:e2e:dashboard",
      "test:e2e:full",
    ]);
  });
  it("gateway/test/unit だけなら unit:gateway だけ", () => {
    assert.deepEqual(tasks(["apps/gateway/test/unit/x.test.ts"]), ["lint", "test:unit:gateway"]);
  });
  it("gateway の nologs の E2E だけなら nologs だけ", () => {
    assert.deepEqual(tasks(["apps/gateway/test/e2e/archive-nologs.nologs.test.ts"]), [
      "lint",
      "test:e2e:gateway:nologs",
    ]);
  });
  it("agent/src は unit・agent-git・スクリプト系・docker・通し（gateway の E2E は要らない）", () => {
    const t = tasks(["apps/agent/src/index.ts"]);
    for (const x of [
      "test:unit:agent",
      "test:unit:agent-git",
      "test:deps-scripts",
      "test:promote-state",
      "test:scale-facts",
      "test:e2e:docker",
      "test:e2e:full",
    ]) {
      assert.ok(t.includes(x), x);
    }
    assert.ok(!t.includes("test:e2e:gateway"));
  });
  it("agent の pm-prepare.mjs は pm-prepare と docker・通し", () => {
    assert.deepEqual(tasks(["apps/agent/container/pm-prepare.mjs"]), [
      "lint",
      "test:pm-prepare",
      "test:e2e:docker",
      "test:e2e:full",
    ]);
  });
  it("web は unit:web と通し", () => {
    assert.deepEqual(tasks(["apps/web/src/index.ts"]), ["lint", "test:unit:web", "test:e2e:full"]);
  });
  it("packages/models は使う app の unit に波及する", () => {
    assert.deepEqual(tasks(["packages/models/src/index.ts"]), [
      "lint",
      "test:unit:models",
      "test:unit:gateway",
      "test:unit:agent",
    ]);
  });
  it("packages/audit は gateway・agent・web の unit に波及する", () => {
    assert.deepEqual(tasks(["packages/audit/src/index.ts"]), [
      "lint",
      "test:unit:audit",
      "test:unit:gateway",
      "test:unit:agent",
      "test:unit:web",
    ]);
  });
});

describe("planTests: scripts・plugin・infra・docs", () => {
  it("scripts の node:test は対応する test:* に当たる", () => {
    assert.deepEqual(tasks(["scripts/byok.mjs"]), ["lint", "test:byok"]);
    assert.deepEqual(tasks(["scripts/github-app-lib.mjs"]), ["lint", "test:github-app"]);
    assert.deepEqual(tasks(["scripts/deploy-config-lib.mjs"]), ["lint", "test:deploy:config"]);
    assert.deepEqual(tasks(["scripts/deploy.sh"]), ["lint", "test:deploy"]);
    assert.deepEqual(tasks(["scripts/setup.sh"]), ["lint", "test:setup"]);
    assert.deepEqual(tasks(["scripts/promote-state.test.mjs"]), ["lint", "test:promote-state"]);
    assert.deepEqual(tasks(["scripts/test-affected-lib.mjs"]), ["lint", "test:test-affected"]);
  });
  it("docs-check は lint の中で流れるので lint だけ", () => {
    assert.deepEqual(tasks(["scripts/docs-check-lib.mjs"]), ["lint"]);
  });
  it("plugins/rovo は test:plugin", () => {
    assert.deepEqual(tasks(["plugins/rovo/hooks/x.ts"]), ["lint", "test:plugin"]);
  });
  it("infra は test:infra", () => {
    assert.deepEqual(tasks(["infra/main.tf"]), ["lint", "test:infra"]);
  });
  it("docs・md・画像は lint だけ", () => {
    assert.deepEqual(tasks(["docs/specs/acceptance.md", "README.md", "docs/assets/brand/a.svg"]), [
      "lint",
    ]);
  });
});

describe("planTests: 安全側と合成", () => {
  it("未知のファイルは全部（ALL_TASKS）", () => {
    assert.deepEqual(tasks(["something/unknown.txt"]), ALL_TASKS);
  });
  it("ルートの設定は全部", () => {
    for (const f of [
      "mise.toml",
      "package.json",
      "pnpm-lock.yaml",
      "biome.json",
      ".github/workflows/ci.yml",
    ]) {
      assert.deepEqual(tasks([f]), ALL_TASKS, f);
    }
  });
  it("全部のときの E2E は直列の順で、lint が先頭", () => {
    assert.deepEqual(
      ALL_TASKS.filter((t) => t.startsWith("test:e2e:")),
      E2E_ORDER,
    );
    assert.equal(ALL_TASKS[0], "lint");
  });
  it("未知のファイルが 1 つでも混ざれば全部。全部のとき dashboard は全 spec", () => {
    const plan = planTests(["docs/a.md", "weird.bin", "apps/dashboard/e2e/layout.spec.ts"]);
    assert.deepEqual(
      plan.map((s) => s.task),
      ALL_TASKS,
    );
    assert.equal(plan.find((s) => s.task === "test:e2e:dashboard").args, undefined);
  });
  it("複数領域は和集合・重複なし・E2E は直列の順", () => {
    const t = tasks([
      "apps/web/src/a.ts",
      "apps/gateway/src/b.ts",
      "apps/agent/src/c.ts",
      "apps/dashboard/src/d.ts",
    ]);
    assert.equal(new Set(t).size, t.length);
    assert.deepEqual(
      t.filter((x) => x.startsWith("test:e2e:")),
      E2E_ORDER,
    );
    assert.ok(t.indexOf("test:unit:web") < t.indexOf("test:e2e:gateway"));
    assert.ok(t.indexOf("test:fake-github") < t.indexOf("test:e2e:gateway"));
  });
  it("入力の順序・重複に依存しない", () => {
    const a = planTests(["apps/web/src/a.ts", "apps/gateway/src/b.ts", "apps/web/src/a.ts"]);
    const b = planTests(["apps/gateway/src/b.ts", "apps/web/src/a.ts"]);
    assert.deepEqual(a, b);
  });
});

describe("parseArgs", () => {
  it("既定", () => {
    assert.deepEqual(parseArgs([]), { base: undefined, dryRun: false });
  });
  it("--base と --dry-run", () => {
    assert.deepEqual(parseArgs(["--base", "origin/dev", "--dry-run"]), {
      base: "origin/dev",
      dryRun: true,
    });
  });
  it("--base=<ref> の形も受ける", () => {
    assert.equal(parseArgs(["--base=main"]).base, "main");
  });
  it("値の無い --base と未知のオプションはエラー", () => {
    assert.throws(() => parseArgs(["--base"]));
    assert.throws(() => parseArgs(["--nope"]));
  });
});

describe("formatPlan", () => {
  it("1 行に 1 手順。spec の絞り込みは引数も出す", () => {
    const out = formatPlan([
      { task: "lint" },
      { task: "test:e2e:dashboard", args: ["e2e/a.spec.ts"] },
    ]);
    assert.match(out, /1\. mise run lint/);
    assert.match(out, /2\. mise run test:e2e:dashboard -- e2e\/a\.spec\.ts/);
  });
});
