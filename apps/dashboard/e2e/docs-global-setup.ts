import { startGatewayServer } from "../../gateway/test/support/gateway-server";
import {
  admin,
  completedResult,
  emit,
  finish,
  INSTALLATION_ID,
  SHA,
  startTask,
  WIDGETS,
  waitForIndex,
} from "./api";
import { type E2eState, STATE_ENV } from "./state";

/**
 * README 用のスクリーンショットのための、撮影専用の架空のデータ（acme/widgets）。
 * 通常の E2E の globalSetup（global-setup.ts）と同じ仕組みで立てるが、題名・コマンドは英語の自然な内容にする。
 * 安全性のテスト用のデータ（<script> など）は入れない。
 */
export default async function docsGlobalSetup() {
  const server = await startGatewayServer({
    logs: true,
    vars: { MAX_CONCURRENT_TASKS: "50" },
  });
  try {
    const { baseUrl, githubUrl } = server;
    const github = admin(githubUrl);
    const alice = { id: 7_100_001, login: "alice" };
    const bob = { id: 7_100_002, login: "bob" };
    await github.reset();
    for (const u of [alice, bob]) {
      await github.addUser(u);
      await github.setTeam("acme", "core", u.login, "active");
    }
    await github.setInstallation(INSTALLATION_ID, [WIDGETS]);

    const specs: { key: string; user: typeof alice; title: string }[] = [
      { key: "done", user: alice, title: "Add retry with backoff to webhook delivery" },
      { key: "bob", user: bob, title: "Upgrade date-fns to v4" },
      { key: "failed", user: alice, title: "Migrate the config loader to ESM" },
      // 最後に作る = 一覧のコンソールに出る走行中のタスク
      { key: "running", user: alice, title: "Fix flaky pagination test in the widgets API" },
    ];
    const tasks: Record<string, string> = {};
    for (const s of specs) {
      tasks[s.key] = await startTask(baseUrl, githubUrl, s.user, WIDGETS.fullName, s.title);
    }
    await Promise.all(Object.values(tasks).map((id) => waitForIndex(baseUrl, id)));
    const id = (k: string) => tasks[k] as string;

    await emit(baseUrl, id("done"), "command", {
      command: "pnpm install --frozen-lockfile",
      exitCode: 0,
      durationMs: 5200,
      outputTail: "Done in 5.2s",
    });
    await emit(baseUrl, id("done"), "edit", {
      path: "src/webhooks/deliver.ts",
      op: "modify",
      added: 28,
      removed: 4,
    });
    await emit(baseUrl, id("done"), "command", {
      command: "pnpm test",
      exitCode: 0,
      durationMs: 7400,
      outputTail: "Test Files  12 passed (12)\n     Tests  86 passed (86)",
    });
    await emit(baseUrl, id("done"), "commit", {
      message: "feat: retry webhook delivery with exponential backoff",
      sha: SHA,
      files: 2,
    });

    await emit(baseUrl, id("bob"), "command", {
      command: "pnpm up date-fns@4",
      exitCode: 0,
      outputTail: "date-fns 3.6.0 -> 4.1.0",
    });

    await emit(baseUrl, id("failed"), "command", {
      command: "pnpm typecheck",
      exitCode: 2,
      durationMs: 9100,
      outputTail: "src/config/load.ts(14,3): error TS1259: Module can only be default-imported.",
    });

    await emit(baseUrl, id("running"), "command", {
      command: "pnpm install --frozen-lockfile",
      exitCode: 0,
      durationMs: 4800,
      outputTail: "Done in 4.8s",
    });
    await emit(baseUrl, id("running"), "command", {
      command: "pnpm test -- pagination",
      cwd: "apps/api",
      exitCode: 1,
      durationMs: 3100,
      outputTail:
        " FAIL  test/pagination.test.ts > returns the second page\n AssertionError: expected 4 to be 5\n   at test/pagination.test.ts:41:22",
    });
    await emit(baseUrl, id("running"), "edit", {
      path: "apps/api/src/pagination.ts",
      op: "modify",
      added: 6,
      removed: 2,
    });
    await emit(baseUrl, id("running"), "command", {
      command: "pnpm test -- pagination",
      cwd: "apps/api",
      exitCode: 0,
      durationMs: 3300,
      outputTail:
        " RUN  v4.1 /workspace/apps/api\n ✓ test/pagination.test.ts (6 tests) 412ms\n\n Test Files  1 passed (1)\n      Tests  6 passed (6)",
    });
    await emit(baseUrl, id("running"), "command", {
      command: "pnpm lint",
      exitCode: 0,
      outputTail: "Checked 148 files in 96ms. No fixes applied.",
    });

    await finish(baseUrl, id("done"), "completed", completedResult(SHA));
    await finish(baseUrl, id("failed"), "failed");

    const state: E2eState = {
      baseUrl,
      githubUrl,
      users: { alice, bob, carol: bob },
      tasks,
      marks: { secretTitle: "", xssTitle: "" },
    };
    process.env[STATE_ENV] = JSON.stringify(state);
  } catch (error) {
    await server.cleanup();
    throw error;
  }
  return server.cleanup;
}
