import { startGatewayServer } from "../../gateway/test/support/gateway-server";
import {
  admin,
  completedResult,
  emit,
  finish,
  INSTALLATION_ID,
  SECRET,
  SHA,
  startTask,
  WIDGETS,
  waitForIndex,
  waitForStatus,
} from "./api";
import { type E2eState, LONG_STEPS, STATE_ENV } from "./state";

/**
 * 悪意のある入力。題名・command・出力のどこに入っても、文字として出るだけで実行されない（D14）。
 * 外部ホスト（evil.example）への画像の要求が出ないことも確かめる。
 */
export const XSS_PAYLOAD =
  '<script>window.__xss=1</script><img src=x onerror="window.__xss=1"><img src="http://evil.example/p.png"> [x](javascript:window.__xss=1)';

/** 同じ wrangler dev・偽 GitHub を使う。dashboard の E2E 用のユーザー・リポジトリ・タスクを用意する。 */
export default async function globalSetup() {
  const server = await startGatewayServer({
    logs: true,
    // 一覧に複数のタスクを同時に走らせる（gateway の E2E の既定は 1）
    vars: { MAX_CONCURRENT_TASKS: "50" },
  });
  try {
    const { baseUrl, githubUrl } = server;
    const github = admin(githubUrl);
    const stamp = Date.now() % 1_000_000;
    const alice = { id: 7_000_000 + stamp, login: `dash-alice-${stamp}` };
    const bob = { id: 8_000_000 + stamp, login: `dash-bob-${stamp}` };
    await github.reset();
    for (const u of [alice, bob]) {
      await github.addUser(u);
      await github.setTeam("acme", "core", u.login, "active");
    }
    // widgets は 2 人に見える。secret は alice にだけ見える
    await github.setInstallation(INSTALLATION_ID, [
      WIDGETS,
      { ...SECRET, visibleTo: [alice.login] },
    ]);

    const secretTitle = `SECRET-REPO-TITLE-${stamp}`;
    const specs: { key: string; user: typeof alice; repo: string; title: string }[] = [
      { key: "done", user: alice, repo: WIDGETS.fullName, title: "完了したタスク" },
      { key: "failed", user: alice, repo: WIDGETS.fullName, title: "失敗したタスク" },
      { key: "running", user: alice, repo: WIDGETS.fullName, title: "実行中のタスク" },
      { key: "grow", user: alice, repo: WIDGETS.fullName, title: "手順が増えるタスク" },
      { key: "paused", user: alice, repo: WIDGETS.fullName, title: "自動更新を切るタスク" },
      { key: "xss", user: alice, repo: WIDGETS.fullName, title: XSS_PAYLOAD },
      { key: "secret", user: alice, repo: SECRET.fullName, title: secretTitle },
      { key: "bob", user: bob, repo: WIDGETS.fullName, title: "bob のタスク" },
      // 完了して PR が Ready（open・Draft でない）になる。レール「待ち」のレビュー待ち
      { key: "review", user: alice, repo: WIDGETS.fullName, title: "レビュー待ちのタスク" },
      // 画面が縦にあふれる長さの手順（自動スクロールの追従 / 停止を確かめる）。最後に作るので、alice の一覧のコンソールに出る
      { key: "long", user: alice, repo: WIDGETS.fullName, title: "手順が長いタスク" },
    ];
    const tasks: Record<string, string> = {};
    for (const s of specs) {
      tasks[s.key] = await startTask(baseUrl, githubUrl, s.user, s.repo, s.title);
    }
    await Promise.all(Object.values(tasks).map((id) => waitForIndex(baseUrl, id)));

    // 構造化イベントの台本
    const id = (k: string) => tasks[k] as string;
    await emit(baseUrl, id("done"), "command", {
      command: "pnpm test",
      cwd: "apps/gateway",
      exitCode: 0,
      durationMs: 1200,
      outputTail: "PASS all\n3 passed",
    });
    await emit(baseUrl, id("done"), "edit", {
      path: "src/a.ts",
      op: "modify",
      added: 3,
      removed: 1,
    });
    await emit(baseUrl, id("done"), "commit", { message: "feat: x", sha: SHA, files: 1 });
    await emit(baseUrl, id("running"), "command", {
      command: "pnpm test",
      exitCode: 0,
      outputTail: "RUNNING-OUTPUT-LINE\nok",
    });
    await emit(baseUrl, id("running"), "edit", {
      path: "src/b.ts",
      op: "modify",
      added: 2,
      removed: 0,
    });
    await emit(baseUrl, id("grow"), "command", { command: "grow-first", exitCode: 0 });
    await emit(baseUrl, id("paused"), "command", { command: "paused-first", exitCode: 0 });
    for (let i = 1; i <= LONG_STEPS; i++) {
      await emit(baseUrl, id("long"), "command", { command: `long-step-${i}`, exitCode: 0 });
    }
    await emit(baseUrl, id("xss"), "command", {
      command: XSS_PAYLOAD,
      exitCode: 0,
      outputTail: `${XSS_PAYLOAD}\nline2`,
    });
    await emit(baseUrl, id("secret"), "command", { command: "SECRET-CMD", exitCode: 0 });
    await emit(baseUrl, id("bob"), "command", { command: "bob-cmd", exitCode: 0 });

    // ワーカーが作業ブランチに commit を積んだ状態で完了させる（変更が無いと rovo が空の Draft PR を閉じる）。
    // 完了すると rovo が PR を自動で Ready にする（クライアントのレビュー待ち）
    await waitForStatus(baseUrl, id("review"), "RUNNING");
    const reviewBranch = `agent/task-${id("review")}`;
    const initial = await github.app<string | null>("branch", WIDGETS.fullName, reviewBranch);
    if (!initial) throw new Error("review の作業ブランチがありません");
    const head = await github.app<string>("addCommit", WIDGETS.fullName, initial, "child commit");
    await github.app("setBranch", WIDGETS.fullName, reviewBranch, head);
    await finish(baseUrl, id("review"), "completed", completedResult(head));

    // 終端
    await finish(baseUrl, id("done"), "completed", completedResult(SHA));
    await finish(baseUrl, id("failed"), "failed");

    const state: E2eState = {
      baseUrl,
      githubUrl,
      users: { alice, bob },
      tasks,
      marks: { secretTitle, xssTitle: XSS_PAYLOAD },
    };
    process.env[STATE_ENV] = JSON.stringify(state);
  } catch (error) {
    await server.cleanup();
    throw error;
  }
  return server.cleanup;
}
