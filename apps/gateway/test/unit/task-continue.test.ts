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
      mustRepo(n: string): { pulls: { number: number; headRepo?: string; headSha?: string }[] };
    };
    const p = inner.mustRepo(REPO).pulls.find((x) => x.number === root.pr);
    // fork の PR は head のブランチが base のリポジトリに無いので、偽物では head の SHA を固定する
    if (p) {
      p.headRepo = "mallory/widgets";
      p.headSha = root.head;
    }
    const r = await authorize(o.user, o.id, { continue_task_id: root.id, base_sha: root.head });
    expectFailure(r, "conflict", "continue_pr_mismatch");
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

describe("task service: start と continue_task_id", () => {
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

  it("authorizeContinue → reserve（鍵とチェーン）→ ensureCreated（元の PR の写し）の順に作る。draft_pr_url は既存の PR", async () => {
    const o = await newOwner();
    const root = await completedRoot(o.id);
    const authz = await authorize(o.user, o.id, { continue_task_id: root.id, base_sha: root.head });
    if (!authz.ok) throw new Error(`authorizeContinue failed: ${authz.code}`);
    const svc = createTaskService(env);
    const p: Principal = { githubUserId: o.id, login: "alice" };
    const r = await svc.start(
      p,
      { ...input(root.id), base_sha: root.head, idempotency_key: "cont-1" },
      {
        repositoryId: authz.repositoryId,
        installationId: authz.installationId,
        continuation: authz.continuation,
      },
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const stub = taskStub(r.value.task_id);
    extraStubs.push(stub);
    expect(r.value.draft_pr_url).toBe(root.prUrl);
    const locks = await runInDurableObject(o.user, (_i, s) => ({
      lock: s.storage.sql.exec("SELECT branch, task_id, continue_of FROM branch_lock").toArray(),
      chain: s.storage.sql
        .exec("SELECT branch, latest_task_id, prev_task_id FROM branch_chain")
        .toArray(),
    }));
    expect(locks).toEqual({
      lock: [{ branch: root.branch, task_id: r.value.task_id, continue_of: root.id }],
      chain: [{ branch: root.branch, latest_task_id: r.value.task_id, prev_task_id: root.id }],
    });
    expect(await glOf(stub)).toMatchObject({
      branch: root.branch,
      initial_sha: root.head,
      pr_number: root.pr,
      pr_url: root.prUrl,
    });
    // 同じキーの再試行は同じタスク
    const again = await svc.start(
      p,
      { ...input(root.id), base_sha: root.head, idempotency_key: "cont-1" },
      {
        repositoryId: authz.repositoryId,
        installationId: authz.installationId,
        continuation: authz.continuation,
      },
    );
    expect(again.ok && again.value.task_id).toBe(r.value.task_id);
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

// 積み足しを作って進める共通部品（B2・B3a）
type Owner = Awaited<ReturnType<typeof newOwner>>;
let keySeq = 0;

/** COMPLETED まで進めた根（ワーカーの warnings 付き） */
async function rootWithWarnings(o: Owner, warnings: string[]) {
  const t = await createTask({}, o.id);
  await t.stub.advance();
  const head = await pushChildCommit(t.branch);
  await t.agent.setProgram({ result: completedResult(head, { warnings }) });
  await t.agent.setPhase("completed");
  for (let i = 0; i < 5; i++) {
    await t.stub.advance();
    if ((await t.stub.result(o.id)).ok) break;
  }
  expect((await t.stub.result(o.id)).ok).toBe(true);
  return { ...t, head };
}

/** authorizeContinue → service.start（reserve → ensureCreated）で積み足しを作る */
async function startContinuation(o: Owner, of: string, baseSha: string) {
  const authz = await authorize(o.user, o.id, { continue_task_id: of, base_sha: baseSha });
  if (!authz.ok) throw new Error(`authorizeContinue failed: ${authz.code} ${authz.message}`);
  const svc = createTaskService(env);
  const r = await svc.start(
    { githubUserId: o.id, login: "alice" },
    {
      continue_task_id: of,
      base_sha: baseSha,
      title: "fix",
      instructions: "apply the review comments",
      idempotency_key: `cont-${++keySeq}`,
    },
    {
      repositoryId: authz.repositoryId,
      installationId: authz.installationId,
      continuation: authz.continuation,
    },
  );
  if (!r.ok) throw new Error(`start failed: ${r.error.code}`);
  const stub = taskStub(r.value.task_id);
  extraStubs.push(stub);
  return { id: r.value.task_id, stub };
}

/** 積み足しを COMPLETED まで進める（PR のブランチに 1 つ commit を積む） */
async function completeContinuation(
  o: Owner,
  c: { id: string; stub: TaskStub },
  branch: string,
  warnings: string[],
) {
  await c.stub.advance();
  const head = await pushChildCommit(branch);
  await fakeAgent(c.id).setProgram({ result: completedResult(head, { warnings }) });
  await fakeAgent(c.id).setPhase("completed");
  for (let i = 0; i < 5; i++) {
    await c.stub.advance();
    if ((await c.stub.result(o.id)).ok) break;
  }
  const r = await c.stub.result(o.id);
  if (!r.ok) throw new Error(`result failed: ${r.code}`);
  return { head, result: r.result };
}

describe("B2: 積み足しの終端（warnings の引き継ぎ・superseded_by・予約の回収）", () => {
  it("根 R → C1（警告あり）→ C2: C2 の warnings に R と C1 の警告が 1 回ずつ、入れ子の接頭辞なしで出る", async () => {
    const o = await newOwner();
    const wR = "tests_modified: root changed a test";
    const wC1 = "ci_config_changed: c1 changed the CI";
    const root = await rootWithWarnings(o, [wR]);
    const c1 = await startContinuation(o, root.id, root.head);
    const d1 = await completeContinuation(o, c1, root.branch, [wC1]);
    // C1 自身の warnings: 自分の分と、R から引き継いだ分
    expect(d1.result.warnings).toContain(wC1);
    expect(d1.result.warnings.filter((w) => w === `inherited from ${root.id}: ${wR}`)).toHaveLength(
      1,
    );
    // C1 を元にしたときの continuationSource の warnings は C1 自身の分だけ
    const src = await c1.stub.continuationSource(o.id);
    expect(src.ok && src.source.warnings).toEqual([wC1]);

    const c2 = await startContinuation(o, c1.id, d1.head);
    const d2 = await completeContinuation(o, c2, root.branch, []);
    const inherited = d2.result.warnings.filter((w) => w.startsWith("inherited from"));
    expect(inherited.sort()).toEqual(
      [`inherited from ${root.id}: ${wR}`, `inherited from ${c1.id}: ${wC1}`].sort(),
    );
    expect(d2.result.warnings.some((w) => w.includes("inherited from", 15))).toBe(false);
    // 引き継いだ警告があるので task_pr_merge は warnings_present で止まる
    const ctx = await c2.stub.prContext(o.id, "merge");
    expect(ctx).toMatchObject({ ok: false, code: "conflict" });
  });

  it("task_result に superseded_by（最新の積み足しの id）と pr.continuation_of が出る。根の結果は他を変えない", async () => {
    const o = await newOwner();
    const root = await completedRoot(o.id);
    const before = await root.stub.result(o.id);
    if (!before.ok) throw new Error("not ready");
    expect(before.result).not.toHaveProperty("superseded_by");
    const c1 = await startContinuation(o, root.id, root.head);
    const after = await root.stub.result(o.id);
    if (!after.ok) throw new Error("not ready");
    expect(after.result.superseded_by).toBe(c1.id);
    const { superseded_by: _s, ...rest } = after.result;
    expect(rest).toEqual(before.result);
    const d1 = await completeContinuation(o, c1, root.branch, []);
    expect(d1.result.pr).toMatchObject({
      number: root.pr,
      url: root.prUrl,
      branch: root.branch,
      continuation_of: root.id,
    });
    // service の task_result にも出る
    const svc = createTaskService(env);
    const p: Principal = { githubUserId: o.id, login: "alice" };
    const viaService = await svc.result(p, root.id);
    expect(viaService.ok && viaService.value.superseded_by).toBe(c1.id);
  });

  it("同じ元から実行中の積み足しがあるあいだは、authorizeContinue は通し、reserve が branch_busy で断る（decide の順: 鍵 → 最新）", async () => {
    const o = await newOwner();
    const root = await completedRoot(o.id);
    const c1 = await startContinuation(o, root.id, root.head);
    const authz = await authorize(o.user, o.id, { continue_task_id: root.id, base_sha: root.head });
    expect(authz.ok).toBe(true);
    if (!authz.ok) return;
    const svc = createTaskService(env);
    const r = await svc.start(
      { githubUserId: o.id, login: "alice" },
      {
        continue_task_id: root.id,
        base_sha: root.head,
        title: "fix",
        instructions: "apply the review comments",
        idempotency_key: "busy-1",
      },
      {
        repositoryId: authz.repositoryId,
        installationId: authz.installationId,
        continuation: authz.continuation,
      },
    );
    expect(r).toMatchObject({ ok: false, error: { code: "branch_busy" } });
    expect(!r.ok && r.error.message).toContain(c1.id);
  });

  it("reserve のあとに ensureCreated が失敗しても、予約が回収されて branch_chain が戻り、次の積み足しが通る", async () => {
    const o = await newOwner();
    const root = await completedRoot(o.id);
    const authz = await authorize(o.user, o.id, { continue_task_id: root.id, base_sha: root.head });
    if (!authz.ok) throw new Error("authorizeContinue failed");
    const svc = createTaskService(env);
    const p: Principal = { githubUserId: o.id, login: "alice" };
    // TaskDO だけが断る事実（PR の URL の形が違う）: reserve は通り、ensureCreated が invalid_input
    const bad = await svc.start(
      p,
      {
        continue_task_id: root.id,
        base_sha: root.head,
        title: "fix",
        instructions: "apply the review comments",
        idempotency_key: "bad-1",
      },
      {
        repositoryId: authz.repositoryId,
        installationId: authz.installationId,
        continuation: { ...authz.continuation, pr_url: "ftp://example.invalid/pull/1" },
      },
    );
    expect(bad).toMatchObject({ ok: false, error: { code: "invalid_input" } });
    const state = () =>
      runInDurableObject(o.user, (_i, s) => ({
        lock: s.storage.sql.exec("SELECT task_id FROM branch_lock").toArray(),
        chain: s.storage.sql
          .exec("SELECT latest_task_id, prev_task_id FROM branch_chain")
          .toArray() as { latest_task_id: string; prev_task_id: string }[],
      }));
    const held = await state();
    expect(held.lock).toHaveLength(1);
    const phantom = held.chain[0]?.latest_task_id as string;
    expect(phantom).not.toBe(root.id);
    extraStubs.push(taskStub(phantom));
    // 回収の待ち（RESERVATION_RECLAIM_AFTER_MS）を過ぎる
    await runInDurableObject(o.user, (i) => {
      const u = i as unknown as { now: () => number };
      const base = u.now.bind(u);
      u.now = () => base() + 11 * 60 * 1000;
    });
    const next = await startContinuation(o, root.id, root.head);
    expect(next.id).not.toBe(phantom);
    expect(await state()).toEqual({
      lock: [{ task_id: next.id }],
      chain: [{ latest_task_id: next.id, prev_task_id: root.id }],
    });
  });
});

describe("B3a: マージの判定（branch_busy・head_moved）と task_start の continuation", () => {
  const principalOf = (o: Owner): Principal => ({ githubUserId: o.id, login: "alice" });
  const writes = () =>
    app()
      .requests()
      .filter((r) => r.method === "PUT" || r.method === "DELETE");
  const lockRows = (o: Owner) =>
    runInDurableObject(
      o.user,
      (_i, s) =>
        s.storage.sql.exec("SELECT branch, task_id FROM branch_lock").toArray() as {
          branch: string;
          task_id: string;
        }[],
    );
  /** finishTask の前（終端から数秒）の状態: 鍵が残っている */
  const holdLock = (o: Owner, branch: string, taskId: string, of: string) =>
    runInDurableObject(o.user, (_i, s) => {
      s.storage.sql.exec(
        "INSERT OR REPLACE INTO branch_lock (branch, task_id, continue_of, reserved_at) VALUES (?, ?, ?, ?)",
        branch,
        taskId,
        of,
        Date.now(),
      );
    });
  const releaseLock = (o: Owner, branch: string) =>
    runInDurableObject(o.user, (_i, s) => {
      s.storage.sql.exec("DELETE FROM branch_lock WHERE branch = ?", branch);
    });

  it("M3: 積み足しの実行中は、最新でない id でも最新の id でも task_pr_merge が branch_busy で止まり、マージもブランチの削除もしない。鍵が開けば最新の id で通る。task_pr_ready は止まらない", async () => {
    const o = await newOwner();
    const root = await completedRoot(o.id);
    const svc = createTaskService(env);
    const p = principalOf(o);
    const c1 = await startContinuation(o, root.id, root.head);
    expect(await lockRows(o)).toEqual([{ branch: root.branch, task_id: c1.id }]);
    const before = writes().length;

    // 最新でない id（根）: 実行中の積み足しがあるので branch_busy（id が載り、not_ready でなくなってからの再試行を案内する）
    const old = await svc.prMerge(p, { task_id: root.id, delete_branch: true });
    expect(old).toMatchObject({ ok: false, error: { code: "conflict" } });
    expect(!old.ok && old.error.message.startsWith("branch_busy:")).toBe(true);
    expect(!old.ok && old.error.message).toContain(c1.id);
    expect(!old.ok && old.error.message).toContain("not_ready");
    // UserDO.prMerge 自身も鍵を見る（正しさは prMerge が保つ）
    const direct = await o.user.prMerge(
      { repository: REPO, number: root.pr, branch: root.branch },
      { expectedSha: root.head, method: "squash", deleteBranch: true },
    );
    expect(direct).toMatchObject({ ok: false, code: "conflict", reason: "branch_busy" });
    expect(!direct.ok && direct.message.startsWith("branch_busy:")).toBe(true);
    expect(!direct.ok && direct.message).toContain(c1.id);
    expect(writes()).toHaveLength(before);
    expect(app().branch(REPO, root.branch)).not.toBeNull();
    expect(
      app()
        .pulls(REPO)
        .find((x) => x.number === root.pr)?.merged,
    ).toBe(false);

    // task_pr_ready は PR の状態だけを見るので止めない
    expect((await svc.prReady(p, { task_id: root.id })).ok).toBe(true);

    // 最新の id（C1）: 終端になっても、鍵が開くまで（finishTask の前）は branch_busy
    const d1 = await completeContinuation(o, c1, root.branch, []);
    await holdLock(o, root.branch, c1.id, root.id);
    const latest = await svc.prMerge(p, { task_id: c1.id, delete_branch: true });
    expect(latest).toMatchObject({ ok: false, error: { code: "conflict" } });
    expect(!latest.ok && latest.error.message.startsWith("branch_busy:")).toBe(true);
    expect(writes()).toHaveLength(before);
    expect(
      app()
        .pulls(REPO)
        .find((x) => x.number === root.pr)?.merged,
    ).toBe(false);

    // 鍵が開いたあとは最新の id で通る
    await releaseLock(o, root.branch);
    const ok = await svc.prMerge(p, { task_id: c1.id });
    expect(ok).toMatchObject({ ok: true, value: { merged: true, merge_sha: d1.head } });
  });

  it("prMerge: 積み足しのあと古い id でマージすると head_moved（マージしない）。メッセージは最新のタスクでマージするよう案内する。マージ済みなら「すでにマージ済み」を含める", async () => {
    const o = await newOwner();
    const root = await completedRoot(o.id);
    const svc = createTaskService(env);
    const p = principalOf(o);
    const c1 = await startContinuation(o, root.id, root.head);
    const d1 = await completeContinuation(o, c1, root.branch, []);
    await releaseLock(o, root.branch);
    const puts = () =>
      app()
        .requests()
        .filter((r) => r.method === "PUT").length;
    const before = puts();

    const old = await svc.prMerge(p, { task_id: root.id });
    expect(old).toMatchObject({ ok: false, error: { code: "head_moved" } });
    const msg = !old.ok ? old.error.message : "";
    expect(msg).toContain(d1.head.slice(0, 12));
    expect(msg).toContain("continue_task_id");
    expect(msg).toContain("latest task");
    expect(msg).toContain(c1.id);
    expect(msg).toContain("task_pr_merge");
    expect(msg).not.toContain("already merged");
    expect(puts()).toBe(before);

    expect((await svc.prMerge(p, { task_id: c1.id })).ok).toBe(true);
    const after = await svc.prMerge(p, { task_id: root.id });
    expect(after).toMatchObject({ ok: false, error: { code: "head_moved" } });
    expect(!after.ok && after.error.message).toContain("already merged");
    expect(puts()).toBe(before + 1);
  });

  it("task_start の応答: 積み足しのときだけ continuation（of・pr_number・pr_url・branch）が付き、draft_pr_url は既存の PR。task_status・task_result と食い違わない", async () => {
    const o = await newOwner();
    const root = await completedRoot(o.id);
    const authz = await authorize(o.user, o.id, { continue_task_id: root.id, base_sha: root.head });
    if (!authz.ok) throw new Error("authorizeContinue failed");
    const svc = createTaskService(env);
    const p = principalOf(o);
    const req = {
      continue_task_id: root.id,
      base_sha: root.head,
      title: "fix",
      instructions: "apply the review comments",
      idempotency_key: "cont-shape",
    };
    const opts = {
      repositoryId: authz.repositoryId,
      installationId: authz.installationId,
      continuation: authz.continuation,
    };
    const r = await svc.start(p, req, opts);
    if (!r.ok) throw new Error(`start failed: ${r.error.code}`);
    extraStubs.push(taskStub(r.value.task_id));
    expect(r.value.continuation).toEqual({
      of: root.id,
      pr_number: root.pr,
      pr_url: root.prUrl,
      branch: root.branch,
    });
    expect(r.value.draft_pr_url).toBe(root.prUrl);
    // 再試行（同じキー）でも同じ形
    const again = await svc.start(p, req, opts);
    expect(again.ok && again.value.continuation).toEqual(r.value.continuation);
    // task_status の pr と食い違わない
    const st = await svc.status(p, r.value.task_id);
    expect(st.ok && st.value.pr).toEqual({
      number: root.pr,
      url: root.prUrl,
      branch: root.branch,
      continuation_of: root.id,
    });
    expect(st.ok && st.value.draft_pr_url).toBe(root.prUrl);
    // task_result の pr とも食い違わない（終端になったあと）
    const d = await completeContinuation(
      o,
      { id: r.value.task_id, stub: taskStub(r.value.task_id) },
      root.branch,
      [],
    );
    expect(d.result.pr).toMatchObject({
      number: r.value.continuation?.pr_number,
      url: r.value.continuation?.pr_url,
      branch: r.value.continuation?.branch,
      continuation_of: r.value.continuation?.of,
    });
  });

  it("通し: C1 の実行中に R から始めると branch_busy → C1 を終えると、R からの authorizeContinue は continue_superseded（C1 の id が載る）", async () => {
    const o = await newOwner();
    const root = await completedRoot(o.id);
    const svc = createTaskService(env);
    const c1 = await startContinuation(o, root.id, root.head);
    const authz = await authorize(o.user, o.id, { continue_task_id: root.id, base_sha: root.head });
    if (!authz.ok) throw new Error("authorizeContinue failed");
    const busy = await svc.start(
      principalOf(o),
      {
        continue_task_id: root.id,
        base_sha: root.head,
        title: "fix",
        instructions: "apply the review comments",
        idempotency_key: "flow-busy",
      },
      {
        repositoryId: authz.repositoryId,
        installationId: authz.installationId,
        continuation: authz.continuation,
      },
    );
    expect(busy).toMatchObject({ ok: false, error: { code: "branch_busy" } });
    expect(!busy.ok && busy.error.message).toContain(c1.id);

    const d1 = await completeContinuation(o, c1, root.branch, []);
    // 鍵は finishTask で開く（数秒の遅れ）。開いたあと
    await releaseLock(o, root.branch);
    for (const base of [root.head, d1.head]) {
      const r = await authorize(o.user, o.id, { continue_task_id: root.id, base_sha: base });
      expectFailure(r, "conflict", "continue_superseded");
      expect(!r.ok && r.message).toContain(c1.id);
    }
    // C1 からは通る
    expect((await authorize(o.user, o.id, { continue_task_id: c1.id, base_sha: d1.head })).ok).toBe(
      true,
    );
  });
});
