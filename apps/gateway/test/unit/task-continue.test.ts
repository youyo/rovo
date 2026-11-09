import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it } from "vitest";
import { createTaskService, type Principal } from "../../src/tasks/service";
import type { ContinueAuthzResult } from "../../src/tasks/user-do";
import { FakeGitHubFetch, installFakeGitHub } from "./fake-github-fetch";
import { FP, fakeAgent, newTaskId, newUserId, sampleInput, taskStub, userStub } from "./helpers";
import {
  app,
  clearTaskAlarms,
  completedResult,
  createTask,
  pushChildCommit,
  REPO,
  runToCompleted,
  type TaskStub,
} from "./pr-helpers";

// 同じ PR への積み足し（docs/specs/continue-task.md）のタスク B1: 予約と認可。
// UserDO.authorizeContinue の受け付ける条件 1〜8（9 は reserve。user-budget.test.ts）と、TaskDO.continuationSource。

afterEach(clearTaskAlarms);

/** 追加で作った TaskDO（alarm を消す対象） */
const extraStubs: TaskStub[] = [];
afterEach(async () => {
  const stubs = extraStubs.splice(0);
  await Promise.all(
    stubs.map((s) => runInDurableObject(s, (_i, state) => state.storage.deleteAlarm())),
  );
});

type UserStub = ReturnType<typeof userStub>;

/** 偽の GitHub（利用者のトークンで PR を読める）を差し込んだ利用者 */
async function newOwner() {
  const id = newUserId();
  const gh = new FakeGitHubFetch();
  gh.user = { id, login: "alice" };
  gh.app = app();
  const user = await installFakeGitHub(id, gh);
  // 積み足しのテストでは、根と積み足しを同じ利用者が続けて使う（Unit の既定の上限は 1）
  await runInDurableObject(user, (i) => {
    const inst = i as unknown as { env: Record<string, unknown> };
    inst.env = { ...inst.env, MAX_CONCURRENT_TASKS: "4" };
  });
  return { id, gh, user };
}

const glOf = (stub: TaskStub) =>
  runInDurableObject(
    stub,
    (_i, s) =>
      s.storage.sql.exec("SELECT * FROM github_link").toArray()[0] as Record<string, unknown>,
  );

const exec = (stub: TaskStub, q: string, ...b: unknown[]) =>
  runInDurableObject(stub, (_i, s) => {
    s.storage.sql.exec(q, ...b);
  });

/** COMPLETED まで進めた根のタスク（PR あり、終了処理まで済み） */
async function completedRoot(ownerId: number) {
  const t = await runToCompleted({}, ownerId);
  const gl = await glOf(t.stub);
  expect(gl.finalize_done).toBe(1);
  return {
    ...t,
    pr: gl.pr_number as number,
    prUrl: gl.pr_url as string,
    initial: gl.initial_sha as string,
  };
}

type Root = Awaited<ReturnType<typeof completedRoot>>;

const authorize = (
  user: UserStub,
  ownerId: number,
  input: { continue_task_id: string; base_sha: string; repository?: string; base_ref?: string },
): Promise<ContinueAuthzResult> => user.authorizeContinue(ownerId, input);

/**
 * 根 R の PR に積み足した C1 を COMPLETED まで進める。UserDO の予約（鍵とチェーン）を通して id を取り、
 * B2 の ensureCreated が書く記録（continuation_of・continuation_root・github_link の写し）は SQL で再現する。
 */
async function continuedOn(
  o: Awaited<ReturnType<typeof newOwner>>,
  root: Root,
  warnings: string[] = [],
) {
  const r = await o.user.reserve("c1", FP, { branch: root.branch, continueOf: root.id });
  if (!r.ok) throw new Error(`reserve failed: ${r.code}`);
  const id = r.task_id;
  const stub = taskStub(id);
  extraStubs.push(stub);
  const created = await stub.ensureCreated(sampleInput(id, o.id, { base_sha: root.head }));
  if (!created.ok) throw new Error(`ensureCreated failed: ${created.code}`);
  await stub.advance();
  await exec(stub, "UPDATE task SET continuation_of = ?, continuation_root = ?", root.id, root.id);
  await exec(
    stub,
    "UPDATE github_link SET branch = ?, pr_number = ?, pr_url = ?, initial_sha = ?",
    root.branch,
    root.pr,
    root.prUrl,
    root.head,
  );
  const head = await pushChildCommit(root.branch);
  await fakeAgent(id).setProgram({ result: completedResult(head, { warnings }) });
  await fakeAgent(id).setPhase("completed");
  for (let i = 0; i < 5; i++) {
    await stub.advance();
    if ((await stub.result(o.id)).ok) break;
  }
  expect((await stub.result(o.id)).ok).toBe(true);
  return { id, stub, head };
}

function expectFailure(r: ContinueAuthzResult, code: string, prefix?: string) {
  expect(r.ok).toBe(false);
  if (r.ok) return;
  expect(r.code).toBe(code);
  if (prefix !== undefined) expect(r.message.startsWith(`${prefix}:`)).toBe(true);
}

describe("UserDO.authorizeContinue: 受け付ける", () => {
  it("終端・終了処理済み・最新・PR が open で head == base_sha なら、固定した事実を返す", async () => {
    const o = await newOwner();
    const root = await completedRoot(o.id);
    const r = await authorize(o.user, o.id, { continue_task_id: root.id, base_sha: root.head });
    expect(r).toEqual({
      ok: true,
      repositoryId: 4242,
      installationId: 77,
      continuation: {
        of: root.id,
        root: root.id,
        branch: `agent/task-${root.id}`,
        repository: REPO,
        base_ref: "main",
        pr_number: root.pr,
        pr_url: root.prUrl,
        inherited_warnings: [],
      },
    });
  });

  it("repository・base_ref を渡すなら元と同じであること（repository の大文字小文字は区別しない）。base_sha も大文字を受け付ける", async () => {
    const o = await newOwner();
    const root = await completedRoot(o.id);
    const r = await authorize(o.user, o.id, {
      continue_task_id: root.id,
      base_sha: root.head.toUpperCase(),
      repository: "ACME/Widgets",
      base_ref: "main",
    });
    expect(r.ok).toBe(true);
  });

  it("読むだけで、元のタスクの状態を変えない", async () => {
    const o = await newOwner();
    const root = await completedRoot(o.id);
    const before = await glOf(root.stub);
    const status = await root.stub.getStatus(o.id);
    await authorize(o.user, o.id, { continue_task_id: root.id, base_sha: root.head });
    expect(await glOf(root.stub)).toEqual(before);
    expect(await root.stub.getStatus(o.id)).toEqual(status);
  });
});

describe("UserDO.authorizeContinue: 断る（条件 1〜8）", () => {
  it("1: 他人のタスク・存在しない id・形式の違う id は、どれも同じ not_found", async () => {
    const o = await newOwner();
    const root = await completedRoot(o.id);
    const other = await newOwner();
    const a = await authorize(other.user, other.id, {
      continue_task_id: root.id,
      base_sha: root.head,
    });
    const b = await authorize(o.user, o.id, { continue_task_id: newTaskId(), base_sha: root.head });
    const c = await authorize(o.user, o.id, { continue_task_id: "nope", base_sha: root.head });
    for (const r of [a, b, c]) expectFailure(r, "not_found");
    if (!a.ok && !b.ok) expect(a.message).toBe(b.message);
  });

  it("2: task_review のタスクは元にできない（invalid_input・continue_review_task）", async () => {
    const o = await newOwner();
    const root = await completedRoot(o.id);
    await exec(root.stub, "UPDATE task SET kind = 'review'");
    expectFailure(
      await authorize(o.user, o.id, { continue_task_id: root.id, base_sha: root.head }),
      "invalid_input",
      "continue_review_task",
    );
  });

  it("3: 終端でない（RUNNING）は conflict・continue_not_finished（task_wait を案内する）", async () => {
    const o = await newOwner();
    const running = await createTask({}, o.id);
    await running.stub.advance();
    const r = await authorize(o.user, o.id, {
      continue_task_id: running.id,
      base_sha: "0123456789abcdef0123456789abcdef01234567",
    });
    expectFailure(r, "conflict", "continue_not_finished");
    expect(!r.ok && r.message).toContain("task_wait");
  });

  it("3: 停止を確認していない（cancel_state が stopped でない）は continue_not_finished", async () => {
    const o = await newOwner();
    const root = await completedRoot(o.id);
    await exec(root.stub, "UPDATE agent_link SET cancel_state = 'pending'");
    expectFailure(
      await authorize(o.user, o.id, { continue_task_id: root.id, base_sha: root.head }),
      "conflict",
      "continue_not_finished",
    );
  });

  it("4 / M2: チェーンの最新でない（branch_chain の latest と違う）は conflict・continue_superseded で、最新の id が載る", async () => {
    const o = await newOwner();
    const root = await completedRoot(o.id);
    const later = newTaskId();
    await runInDurableObject(o.user, (_i, s) => {
      s.storage.sql.exec(
        "INSERT INTO branch_chain (branch, latest_task_id, prev_task_id) VALUES (?, ?, ?)",
        root.branch,
        later,
        root.id,
      );
    });
    const r = await authorize(o.user, o.id, { continue_task_id: root.id, base_sha: root.head });
    expectFailure(r, "conflict", "continue_superseded");
    expect(!r.ok && r.message).toContain(later);
  });

  it("5: PR が無い（準備で失敗した）は conflict・continue_no_pr", async () => {
    const o = await newOwner();
    const root = await completedRoot(o.id);
    await exec(root.stub, "UPDATE github_link SET pr_number = NULL, pr_url = NULL");
    expectFailure(
      await authorize(o.user, o.id, { continue_task_id: root.id, base_sha: root.head }),
      "conflict",
      "continue_no_pr",
    );
  });

  it("5: rovo が空の PR を閉じた（closed_empty）は conflict・continue_pr_closed", async () => {
    const o = await newOwner();
    const root = await completedRoot(o.id);
    await exec(root.stub, "UPDATE github_link SET closed_empty = 1");
    expectFailure(
      await authorize(o.user, o.id, { continue_task_id: root.id, base_sha: root.head }),
      "conflict",
      "continue_pr_closed",
    );
  });

  it("6: repository・base_ref が元と違えば invalid_input（continue_repository_mismatch / continue_base_ref_mismatch）", async () => {
    const o = await newOwner();
    const root = await completedRoot(o.id);
    expectFailure(
      await authorize(o.user, o.id, {
        continue_task_id: root.id,
        base_sha: root.head,
        repository: "acme/other",
      }),
      "invalid_input",
      "continue_repository_mismatch",
    );
    expectFailure(
      await authorize(o.user, o.id, {
        continue_task_id: root.id,
        base_sha: root.head,
        base_ref: "develop",
      }),
      "invalid_input",
      "continue_base_ref_mismatch",
    );
  });

  it("7: 本人のトークンで PR が見えなければ not_found", async () => {
    const o = await newOwner();
    const root = await completedRoot(o.id);
    app().setFault({ pattern: `^GET /repos/${REPO}/pulls/${root.pr}$`, status: 404 });
    expectFailure(
      await authorize(o.user, o.id, { continue_task_id: root.id, base_sha: root.head }),
      "not_found",
    );
  });

  it("7: PR が閉じていれば continue_pr_closed、マージ済みなら continue_pr_merged（どちらも conflict）", async () => {
    const o = await newOwner();
    const closed = await completedRoot(o.id);
    app().closePull(REPO, closed.pr);
    expectFailure(
      await authorize(o.user, o.id, { continue_task_id: closed.id, base_sha: closed.head }),
      "conflict",
      "continue_pr_closed",
    );
    const merged = await completedRoot(o.id);
    app().markMerged(REPO, merged.pr);
    expectFailure(
      await authorize(o.user, o.id, { continue_task_id: merged.id, base_sha: merged.head }),
      "conflict",
      "continue_pr_merged",
    );
  });

  it("7: PR の head が fork（head のリポジトリが base と違う）なら conflict で断る", async () => {
    const o = await newOwner();
    const root = await completedRoot(o.id);
    const inner = app() as unknown as {
      mustRepo(n: string): { pulls: { number: number; headRepo?: string }[] };
    };
    const p = inner.mustRepo(REPO).pulls.find((x) => x.number === root.pr);
    if (p) p.headRepo = "mallory/widgets";
    const r = await authorize(o.user, o.id, { continue_task_id: root.id, base_sha: root.head });
    expectFailure(r, "conflict");
  });

  it("8: base_sha が PR の今の head と違えば branch_moved（今の head が載る）", async () => {
    const o = await newOwner();
    const root = await completedRoot(o.id);
    const moved = await pushChildCommit(root.branch);
    const r = await authorize(o.user, o.id, { continue_task_id: root.id, base_sha: root.head });
    expectFailure(r, "branch_moved");
    expect(!r.ok && r.message).toContain(moved);
  });
});

describe("M1: 終了処理（finalize_done / body_done）が済むまで断る", () => {
  it("停止済みでも finalize_done = 0 なら continue_not_finished。再試行待ち（finalize_retry_at が先）も同じ。PR があって body_done = 0 も同じ。済めば通る", async () => {
    const o = await newOwner();
    const root = await completedRoot(o.id);
    const input = { continue_task_id: root.id, base_sha: root.head };
    await exec(root.stub, "UPDATE github_link SET finalize_done = 0");
    expectFailure(await authorize(o.user, o.id, input), "conflict", "continue_not_finished");
    await exec(
      root.stub,
      "UPDATE github_link SET finalize_done = 0, finalize_retry_at = ?",
      Date.now() + 60 * 60 * 1000,
    );
    expectFailure(await authorize(o.user, o.id, input), "conflict", "continue_not_finished");
    await exec(
      root.stub,
      "UPDATE github_link SET finalize_done = 1, finalize_retry_at = 0, body_done = 0",
    );
    expectFailure(await authorize(o.user, o.id, input), "conflict", "continue_not_finished");
    await exec(root.stub, "UPDATE github_link SET body_done = 1");
    expect((await authorize(o.user, o.id, input)).ok).toBe(true);
  });
});

describe("M2: 古い id と、先行タスクの警告の引き継ぎ", () => {
  it("根 R → C1（警告あり）の後、R からは continue_superseded（C1 の id が載る）。C1 からは通り、C1 の警告を引き継ぐ", async () => {
    const o = await newOwner();
    const root = await completedRoot(o.id);
    const c1 = await continuedOn(o, root, ["tests_modified: a test file was changed"]);
    const old = await authorize(o.user, o.id, { continue_task_id: root.id, base_sha: c1.head });
    expectFailure(old, "conflict", "continue_superseded");
    expect(!old.ok && old.message).toContain(c1.id);
    const ok = await authorize(o.user, o.id, { continue_task_id: c1.id, base_sha: c1.head });
    expect(ok.ok).toBe(true);
    if (!ok.ok) return;
    expect(ok.continuation).toMatchObject({
      of: c1.id,
      root: root.id,
      branch: root.branch,
      pr_number: root.pr,
      pr_url: root.prUrl,
    });
    expect(ok.continuation.inherited_warnings).toContainEqual({
      from: c1.id,
      warning: "tests_modified: a test file was changed",
    });
    // C1 の記録済みの head から積むので、base_not_from_rovo は付かない
    expect(
      ok.continuation.inherited_warnings.some((w) => w.warning.startsWith("base_not_from_rovo")),
    ).toBe(false);
  });

  it("C1 の引き継ぎ分（inherited_warnings）も、さらに次へ引き継ぐ", async () => {
    const o = await newOwner();
    const root = await completedRoot(o.id);
    const c1 = await continuedOn(o, root);
    const earlier = { from: root.id, warning: "push_failed: an earlier warning" };
    await exec(c1.stub, "UPDATE github_link SET inherited_warnings = ?", JSON.stringify([earlier]));
    const ok = await authorize(o.user, o.id, { continue_task_id: c1.id, base_sha: c1.head });
    expect(ok.ok && ok.continuation.inherited_warnings).toContainEqual(earlier);
  });

  it("人の commit: base_sha が PR の今の head と一致していても、元の記録済みの head_sha と違えば base_not_from_rovo を引き継ぐ警告に足す", async () => {
    const o = await newOwner();
    const root = await completedRoot(o.id);
    const human = await pushChildCommit(root.branch);
    const r = await authorize(o.user, o.id, { continue_task_id: root.id, base_sha: human });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const w = r.continuation.inherited_warnings.filter((x) =>
      x.warning.startsWith("base_not_from_rovo:"),
    );
    expect(w).toHaveLength(1);
    expect(w[0]?.from).toBe(root.id);
    expect(w[0]?.warning).toContain(human);
  });

  it("元の head_sha が null なら initial_sha と比べる（一致なら警告なし、違えば base_not_from_rovo）", async () => {
    const o = await newOwner();
    const root = await completedRoot(o.id);
    await exec(root.stub, "UPDATE github_link SET head_sha = NULL, head_matches = NULL");
    const notFromRovo = (r: ContinueAuthzResult) =>
      r.ok
        ? r.continuation.inherited_warnings.filter((x) =>
            x.warning.startsWith("base_not_from_rovo:"),
          ).length
        : -1;
    // ブランチの先頭が initial_sha（準備で確かめた積み足し前の head）のまま
    app().setBranch(REPO, root.branch, root.initial);
    expect(
      notFromRovo(
        await authorize(o.user, o.id, { continue_task_id: root.id, base_sha: root.initial }),
      ),
    ).toBe(0);
    // チェックポイントの push が通っていた（rovo は確かめられない）
    app().setBranch(REPO, root.branch, root.head);
    expect(
      notFromRovo(
        await authorize(o.user, o.id, { continue_task_id: root.id, base_sha: root.head }),
      ),
    ).toBe(1);
  });
});

describe("TaskDO.continuationSource", () => {
  it("所有者でなければ not_found。所有者には根・ブランチ・PR・終了処理の状態を返す", async () => {
    const o = await newOwner();
    const root = await completedRoot(o.id);
    expect(await root.stub.continuationSource(o.id + 1)).toEqual({
      ok: false,
      code: "not_found",
    });
    const r = await root.stub.continuationSource(o.id);
    expect(r).toMatchObject({
      ok: true,
      source: {
        id: root.id,
        review: false,
        finished: true,
        root: root.id,
        branch: root.branch,
        repository: REPO,
        base_ref: "main",
        pr_number: root.pr,
        pr_url: root.prUrl,
        closed_empty: false,
        pr_merged: false,
        head_sha: root.head,
        initial_sha: root.initial,
        warnings: [],
        inherited_warnings: [],
      },
    });
  });
});

describe("task service: start と continue_task_id（B1 では作成しない）", () => {
  const principal = (): Principal => ({ githubUserId: newUserId(), login: "alice" });
  const input = (id: string) => ({
    continue_task_id: id,
    base_sha: "0123456789abcdef0123456789abcdef01234567",
    title: "fix review comments",
    instructions: "apply the review comments",
  });

  it("authorizeContinue の事実（options.continuation）が無ければ internal。予約しない", async () => {
    const svc = createTaskService(env);
    const p = principal();
    const r = await svc.start(p, input(newTaskId()), { repositoryId: 4242, installationId: 77 });
    expect(r).toMatchObject({ ok: false, error: { code: "internal" } });
    const rows = await runInDurableObject(userStub(p.githubUserId), (_i, s) =>
      s.storage.sql.exec("SELECT * FROM requests").toArray(),
    );
    expect(rows).toEqual([]);
  });

  it("事実があっても、まだ ensureCreated を呼ばない（予約も TaskDO も作らない）", async () => {
    const svc = createTaskService(env);
    const p = principal();
    const of = newTaskId();
    const r = await svc.start(p, input(of), {
      repositoryId: 4242,
      installationId: 77,
      continuation: {
        of,
        root: of,
        branch: `agent/task-${of}`,
        repository: "acme/widgets",
        base_ref: "main",
        pr_number: 1,
        pr_url: "https://github.com/acme/widgets/pull/1",
        inherited_warnings: [],
      },
    });
    expect(r.ok).toBe(false);
    const rows = await runInDurableObject(userStub(p.githubUserId), (_i, s) => ({
      requests: s.storage.sql.exec("SELECT * FROM requests").toArray(),
      slots: s.storage.sql.exec("SELECT * FROM reservation_slot").toArray(),
    }));
    expect(rows).toEqual({ requests: [], slots: [] });
  });

  it("事実の of が continue_task_id と違えば internal", async () => {
    const svc = createTaskService(env);
    const of = newTaskId();
    const other = newTaskId();
    const r = await svc.start(principal(), input(of), {
      repositoryId: 4242,
      installationId: 77,
      continuation: {
        of: other,
        root: other,
        branch: `agent/task-${other}`,
        repository: "acme/widgets",
        base_ref: "main",
        pr_number: 1,
        pr_url: "https://github.com/acme/widgets/pull/1",
        inherited_warnings: [],
      },
    });
    expect(r).toMatchObject({ ok: false, error: { code: "internal" } });
  });

  it("continue_task_id が無い task_start は従来どおり（repository・base_ref は必須）", async () => {
    const svc = createTaskService(env);
    const { continue_task_id: _c, ...plain } = input(newTaskId());
    const r = await svc.start(principal(), plain, { repositoryId: 4242, installationId: 77 });
    expect(r).toMatchObject({ ok: false, error: { code: "invalid_input" } });
    expect(!r.ok && r.error.message).toContain("repository");
  });
});
