import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { GitHubError } from "../../src/github";
import { getFakeApp, UNIT_REPO, type UnitGitHubEnv } from "../support/unit-github";
import { FakeGitHubFetch, installFakeGitHub } from "./fake-github-fetch";
import { newUserId } from "./helpers";

// UserDO の PR 操作（D9）。利用者の GitHub トークンで、Ready 化・マージ・ブランチ削除を行う。トークンは戻り値に出ない。

const app = () => getFakeApp(env as unknown as UnitGitHubEnv);
const REPO = UNIT_REPO.fullName;
const BRANCH = "agent/task-UNIT";

async function setup() {
  const id = newUserId();
  const gh = new FakeGitHubFetch();
  gh.user = { id, login: "alice" };
  gh.app = app();
  const stub = await installFakeGitHub(id, gh);
  const sha = await app().addCommit(REPO, "0123456789abcdef0123456789abcdef01234567", "work");
  app().setBranch(REPO, BRANCH, sha);
  const number = app().seedPull(REPO, { head: BRANCH, base: "main", draft: true });
  const target = { repository: REPO, number, branch: BRANCH };
  return { id, gh, stub, sha, number, target };
}

const pull = () => app().pulls(REPO)[0];

describe("UserDO.prReady", () => {
  it("Draft の PR を Ready にする。利用者のトークンで GET pulls → POST /graphql（Installation Token は使わない）", async () => {
    const { stub, target } = await setup();
    expect(await stub.prReady(target)).toEqual({ ok: true, already_ready: false });
    expect(pull()?.draft).toBe(false);
    const reqs = app().requests();
    expect(reqs.map((r) => `${r.method} ${r.path}`)).toEqual([
      `GET /repos/${REPO}/pulls/${target.number}`,
      "POST /graphql",
    ]);
    expect(reqs.every((r) => r.auth === "user")).toBe(true);
  });

  it("冪等: すでに Ready なら成功（GraphQL は呼ばない）", async () => {
    const { stub, target } = await setup();
    await stub.prReady(target);
    app().reset();
    app().seedRepo(UNIT_REPO);
    // 別の Ready な PR を用意する
    const sha = await app().addCommit(REPO, "0123456789abcdef0123456789abcdef01234567", "w2");
    app().setBranch(REPO, "agent/task-OTHER", sha);
    const n = app().seedPull(REPO, { head: "agent/task-OTHER", base: "main", draft: false });
    const r = await stub.prReady({ repository: REPO, number: n, branch: "agent/task-OTHER" });
    expect(r).toEqual({ ok: true, already_ready: true });
    expect(
      app()
        .requests()
        .map((x) => x.path),
    ).toEqual([`/repos/${REPO}/pulls/${n}`]);
  });

  it("PR の head が記録のブランチと違う（別の PR を指している）なら conflict で、何も変えない", async () => {
    const { stub, target } = await setup();
    const r = await stub.prReady({ ...target, branch: "agent/task-NOT-THIS" });
    expect(r).toMatchObject({ ok: false, code: "conflict", reason: "pr_mismatch" });
    expect(pull()?.draft).toBe(true);
    expect(
      app()
        .requests()
        .some((x) => x.path === "/graphql"),
    ).toBe(false);
  });

  it("閉じた PR は conflict（pr_closed）", async () => {
    const { stub, target } = await setup();
    app().closePull(REPO, target.number);
    expect(await stub.prReady(target)).toMatchObject({
      ok: false,
      code: "conflict",
      reason: "pr_closed",
    });
  });

  it("GitHub の失敗を code で返す: App に Pull requests の write が無ければ forbidden、障害は upstream_unavailable", async () => {
    const { stub, target } = await setup();
    app().setUserPermissions({ contents: "write", pull_requests: "read" });
    expect(await stub.prReady(target)).toMatchObject({ ok: false, code: "forbidden" });
    app().setUserPermissions({ contents: "write", pull_requests: "write" });
    app().setFault({ pattern: "^POST /graphql$", status: 502, count: 1 });
    expect(await stub.prReady(target)).toMatchObject({ ok: false, code: "upstream_unavailable" });
    expect(pull()?.draft).toBe(true);
  });

  it("401 なら 1 回だけ refresh して続ける。戻り値にトークンは出ない", async () => {
    const { gh, stub, target } = await setup();
    gh.validTokens.clear(); // 保存済みのアクセストークンを無効にする（refresh token は有効）
    const r = await stub.prReady(target);
    expect(r).toEqual({ ok: true, already_ready: false });
    expect(gh.count("/login/oauth/access_token")).toBe(1);
    expect(JSON.stringify(r)).not.toMatch(/ghu_|ghr_/);
  });

  it("資格が無ければ reauth_required", async () => {
    const id = newUserId();
    const gh = new FakeGitHubFetch();
    gh.user = { id, login: "alice" };
    gh.app = app();
    const stub = await installFakeGitHub(id, gh, { login: false });
    expect(await stub.prReady({ repository: REPO, number: 1, branch: BRANCH })).toMatchObject({
      ok: false,
      code: "reauth_required",
    });
  });
});

describe("UserDO.prMerge", () => {
  const opts = (sha: string, over: Record<string, unknown> = {}) => ({
    expectedSha: sha,
    method: "squash" as const,
    deleteBranch: false,
    ...over,
  });

  it("Ready な PR を、検証済みの sha 付きでマージする（方法が渡る）。ブランチは消さない", async () => {
    const { stub, target, sha } = await setup();
    await stub.prReady(target);
    const r = await stub.prMerge(target, opts(sha));
    expect(r).toEqual({
      ok: true,
      already_merged: false,
      merge_sha: sha,
      branch_deleted: null,
      warnings: [],
    });
    expect(pull()).toMatchObject({ merged: true, mergeMethod: "squash", mergeSha: sha });
    expect(app().branch(REPO, BRANCH)).toBe(sha);
  });

  it("delete_branch: マージ後に作業ブランチだけを消す", async () => {
    const { stub, target, sha } = await setup();
    await stub.prReady(target);
    const r = await stub.prMerge(target, opts(sha, { deleteBranch: true, method: "rebase" }));
    expect(r).toMatchObject({ ok: true, branch_deleted: true, warnings: [] });
    expect(app().branch(REPO, BRANCH)).toBeNull();
    expect(pull()?.mergeMethod).toBe("rebase");
  });

  it("ブランチの削除に失敗しても、マージ済みなので成功で返す（warnings に残す）", async () => {
    const { stub, target, sha } = await setup();
    await stub.prReady(target);
    app().setFault({
      pattern: "^DELETE /repos/.+/git/refs/",
      status: 403,
      message: "Resource not accessible by integration",
    });
    const r = await stub.prMerge(target, opts(sha, { deleteBranch: true }));
    expect(r).toMatchObject({ ok: true, branch_deleted: false });
    expect((r as { warnings: string[] }).warnings[0]).toContain("branch_delete_failed");
    expect(pull()?.merged).toBe(true);
  });

  it("Draft のままなら conflict（pr_draft）。task_pr_ready を先に呼ぶよう促し、マージを試みない", async () => {
    const { stub, target, sha } = await setup();
    const r = await stub.prMerge(target, opts(sha));
    expect(r).toMatchObject({ ok: false, code: "conflict", reason: "pr_draft" });
    expect((r as { message: string }).message).toContain("task_pr_ready");
    expect(
      app()
        .requests()
        .some((x) => x.method === "PUT"),
    ).toBe(false);
  });

  it("検証後にブランチが動いていたらマージしない（head_moved）。PUT を送る前に分かる場合", async () => {
    const { stub, target, sha } = await setup();
    await stub.prReady(target);
    const moved = await app().addCommit(REPO, sha, "after verification");
    app().setBranch(REPO, BRANCH, moved);
    const r = await stub.prMerge(target, opts(sha));
    expect(r).toMatchObject({ ok: false, code: "head_moved" });
    expect(pull()?.merged).toBe(false);
  });

  it("GET と PUT の間でブランチが動いた場合は、GitHub の 409 で拒否される（sha を渡している）", async () => {
    const { stub, target, sha } = await setup();
    await stub.prReady(target);
    const moved = await app().addCommit(REPO, sha, "race");
    app().beforeHandle = (key) => {
      if (key.startsWith("PUT ")) app().setBranch(REPO, BRANCH, moved);
    };
    const r = await stub.prMerge(target, opts(sha));
    expect(r).toMatchObject({ ok: false, code: "head_moved" });
    expect(pull()?.merged).toBe(false);
    // PUT には検証済みの sha を渡している
    const put = app()
      .requests()
      .find((x) => x.method === "PUT");
    expect(put?.body).toMatchObject({ sha, merge_method: "squash" });
  });

  it("ブランチ保護で拒否されたら merge_blocked と GitHub のメッセージを返す", async () => {
    const { stub, target, sha } = await setup();
    await stub.prReady(target);
    app().setMergeBlock(
      REPO,
      "At least 1 approving review is required by reviewers with write access.",
    );
    const r = await stub.prMerge(target, opts(sha));
    expect(r).toMatchObject({ ok: false, code: "merge_blocked" });
    expect((r as { message: string }).message).toContain("At least 1 approving review");
    expect(pull()?.merged).toBe(false);
  });

  it("冪等: マージ済みで head が検証済みの sha なら成功（already_merged）。head が違えば head_moved", async () => {
    const { stub, target, sha } = await setup();
    await stub.prReady(target);
    await stub.prMerge(target, opts(sha));
    const again = await stub.prMerge(target, opts(sha, { deleteBranch: true }));
    expect(again).toMatchObject({ ok: true, already_merged: true, branch_deleted: true });
    expect(
      app()
        .requests()
        .filter((x) => x.method === "PUT"),
    ).toHaveLength(1);
    const other = await stub.prMerge(target, opts("f".repeat(40)));
    expect(other).toMatchObject({ ok: false, code: "head_moved" });
  });

  it("別の PR・fork の PR（ブランチ・リポジトリの食い違い）は触らない", async () => {
    const { stub, target, sha } = await setup();
    await stub.prReady(target);
    const r = await stub.prMerge({ ...target, branch: "main" }, opts(sha));
    expect(r).toMatchObject({ ok: false, code: "conflict", reason: "pr_mismatch" });
    const wrongRepo = await stub.prMerge({ ...target, repository: "acme/other" }, opts(sha));
    expect(wrongRepo.ok).toBe(false);
    expect(pull()?.merged).toBe(false);
  });
});

describe("GitHubError の型", () => {
  it("PR の操作の失敗コードを持つ", () => {
    expect(new GitHubError("merge_blocked", "x").code).toBe("merge_blocked");
  });
});
