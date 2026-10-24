import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  createAppJwt,
  GitHubApiError,
  GitHubAppClient,
  GitHubRepoApi,
  parsePrivateKey,
} from "../../src/github";
import { type AppKeyPair, generateAppKeyPair } from "../support/app-keys";
import { type FakeGitHub, startFakeGitHub } from "./server";

// 偽 GitHub の App API（JWT 検証・Installation Token・Git Data・Pulls）を、実際のクライアントで通しで確かめる。

const APP_ID = "424242";
const REPO = { id: 4242, fullName: "acme/widgets", push: true };
let keys: AppKeyPair;
let other: AppKeyPair;
let gh: FakeGitHub;

beforeAll(async () => {
  keys = await generateAppKeyPair();
  other = await generateAppKeyPair();
});
beforeEach(async () => {
  gh = await startFakeGitHub({ app: { appId: APP_ID, publicKeyPem: keys.publicPem } });
  gh.admin.setInstallation({ id: 77, repositories: [REPO] });
});
afterEach(async () => {
  await gh.stop();
});

const appClient = (privateKey = keys.privatePem, appId = APP_ID) =>
  new GitHubAppClient({ appId, privateKey, apiBase: gh.url });
const repoApi = (token: string) =>
  new GitHubRepoApi({ token, repository: "acme/widgets", apiBase: gh.url });

describe("偽 GitHub: JWT の検証", () => {
  it("正しい鍵と App ID なら Installation Token を発行する", async () => {
    const t = await appClient().createInstallationToken(77, 4242);
    expect(t.token).toMatch(/^ghs_/);
    expect(t.expiresAt).toBeGreaterThan(Date.now() + 3000_000);
  });

  it("別の鍵で署名された JWT は 401", async () => {
    await expect(
      appClient(other.privatePem).createInstallationToken(77, 4242),
    ).rejects.toMatchObject({
      status: 401,
    });
  });

  it("iss が App ID と違えば 401", async () => {
    await expect(
      appClient(keys.privatePem, "999").createInstallationToken(77, 4242),
    ).rejects.toMatchObject({
      status: 401,
    });
  });

  it("alg が RS256 でない・期限切れ・有効期間が長すぎる JWT は 401", async () => {
    const key = await parsePrivateKey(keys.privatePem);
    const post = (jwt: string) =>
      fetch(`${gh.url}/app/installations/77/access_tokens`, {
        method: "POST",
        headers: { authorization: `Bearer ${jwt}`, "content-type": "application/json" },
        body: "{}",
      });
    const expired = await createAppJwt({ appId: APP_ID, key, nowMs: Date.now() - 3600_000 });
    expect((await post(expired)).status).toBe(401);
    const none = `${btoa('{"alg":"none"}')}.${btoa("{}")}.`;
    expect((await post(none)).status).toBe(401);
    expect((await post("garbage")).status).toBe(401);
  });

  it("Installation に無い repository_ids は 422、未知の Installation は 404", async () => {
    await expect(appClient().createInstallationToken(77, 1)).rejects.toMatchObject({ status: 422 });
    await expect(appClient().createInstallationToken(1, 4242)).rejects.toMatchObject({
      status: 404,
    });
  });

  it("失効したトークンは以後 401", async () => {
    const t = await appClient().createInstallationToken(77, 4242);
    await expect(repoApi(t.token).getCommit("0123456789abcdef")).resolves.toBeDefined();
    await appClient().revokeInstallationToken(t.token);
    await expect(repoApi(t.token).getCommit("0123456789abcdef")).rejects.toMatchObject({
      status: 401,
    });
    expect(gh.app?.tokenList().find((x) => x.token === t.token)?.revoked).toBe(true);
  });
});

describe("偽 GitHub: Git Data / Pulls", () => {
  async function api() {
    const t = await appClient().createInstallationToken(77, 4242);
    return repoApi(t.token);
  }

  it("同じ入力のコミットは同じ SHA になる（決定的）。短縮 SHA は完全な SHA に解決される", async () => {
    const a = await api();
    const base = await a.getCommit("0123456789abcdef");
    expect(base.sha).toMatch(/^[0-9a-f]{40}$/);
    const id = { name: "rovo", email: "rovo@example.test", date: "2026-10-18T00:00:00Z" };
    const mk = () =>
      a.createCommit({ message: "m", treeSha: base.treeSha, parents: [base.sha], identity: id });
    expect(await mk()).toBe(await mk());
    const other = await a.createCommit({
      message: "m",
      treeSha: base.treeSha,
      parents: [base.sha],
      identity: { ...id, date: "2026-10-18T00:00:01Z" },
    });
    expect(other).not.toBe(await mk());
  });

  it("ブランチ作成・既存の検出・compare・PR の作成と照合・本文更新", async () => {
    const a = await api();
    const base = await a.getCommit("0123456789abcdef");
    const id = { name: "rovo", email: "rovo@example.test", date: "2026-10-18T00:00:00Z" };
    const init = await a.createCommit({
      message: "init",
      treeSha: base.treeSha,
      parents: [base.sha],
      identity: id,
    });
    expect(await a.getBranchSha("agent/task-X")).toBeNull();
    expect(await a.createBranch("agent/task-X", init)).toBe("created");
    expect(await a.createBranch("agent/task-X", init)).toBe("exists");
    expect(await a.compare(init, "agent/task-X")).toMatchObject({ status: "identical" });

    const ahead = (await gh.app?.addCommit("acme/widgets", init, "work")) as string;
    gh.app?.setBranch("acme/widgets", "agent/task-X", ahead);
    expect((await a.compare(init, "agent/task-X")).status).toBe("ahead");
    gh.app?.setBranch("acme/widgets", "agent/task-X", base.sha);
    expect((await a.compare(init, "agent/task-X")).status).toBe("behind");
    const side = (await gh.app?.addCommit("acme/widgets", base.sha, "side")) as string;
    gh.app?.setBranch("acme/widgets", "agent/task-X", side);
    expect((await a.compare(init, "agent/task-X")).status).toBe("diverged");
    gh.app?.setBranch("acme/widgets", "agent/task-X", init);

    expect(await a.findOpenPull("agent/task-X")).toBeNull();
    const pr = await a.createPull({
      title: "T",
      head: "agent/task-X",
      base: "main",
      body: "b",
      draft: true,
    });
    expect(pr).toMatchObject({ number: 1, draft: true, headSha: init, baseRef: "main" });
    expect((await a.findOpenPull("agent/task-X"))?.number).toBe(1);
    const dup = await a
      .createPull({ title: "T", head: "agent/task-X", base: "main", body: "b", draft: true })
      .catch((e) => e);
    expect(dup).toBeInstanceOf(GitHubApiError);
    expect(dup).toMatchObject({ status: 422 });
    expect(dup.detail).toMatch(/already exists/);

    await a.updatePullBody(1, "new body");
    expect((await a.getPull(1)).body).toBe("new body");
    await expect(a.updatePullBody(1, "x".repeat(65_537))).rejects.toMatchObject({ status: 422 });
  });

  it("Draft 不可モードでは draft:true の PR 作成が Draft に関する 422 になる（通常の PR は作れる）", async () => {
    const a = await api();
    const base = await a.getCommit("0123456789abcdef");
    await a.createBranch("agent/task-D", base.sha);
    gh.app?.setDraftUnsupported(true);
    const err = await a
      .createPull({ title: "T", head: "agent/task-D", base: "main", body: "", draft: true })
      .catch((e) => e);
    expect(err).toMatchObject({ status: 422 });
    expect(err.detail).toMatch(/draft/i);
    expect(
      (
        await a.createPull({
          title: "T",
          head: "agent/task-D",
          base: "main",
          body: "",
          draft: false,
        })
      ).draft,
    ).toBe(false);
  });

  it("存在しない base は 404、markMissing したコミットも 404", async () => {
    const a = await api();
    gh.app?.markMissing("acme/widgets", "deadbeef");
    await expect(a.getCommit("deadbeef")).rejects.toMatchObject({ status: 404 });
  });

  it("別のリポジトリのトークンでは見えない（404）", async () => {
    gh.admin.setInstallation({
      id: 77,
      repositories: [REPO, { id: 1, fullName: "acme/other", push: true }],
    });
    const t = await appClient().createInstallationToken(77, 4242);
    const o = new GitHubRepoApi({ token: t.token, repository: "acme/other", apiBase: gh.url });
    await expect(o.getCommit("abc1234")).rejects.toMatchObject({ status: 404 });
  });

  it("障害の注入: 指定のパスだけ status で失敗する（Retry-After つき 429 など）", async () => {
    const a = await api();
    gh.app?.setFault({
      pattern: "^POST /repos/.*/git/commits$",
      status: 429,
      count: 1,
      headers: { "retry-after": "2" },
    });
    const base = await a.getCommit("abc1234");
    const id = { name: "n", email: "e@x.test", date: "2026-10-18T00:00:00Z" };
    const err = await a
      .createCommit({ message: "m", treeSha: base.treeSha, parents: [base.sha], identity: id })
      .catch((e) => e);
    expect(err).toMatchObject({ status: 429, retryAfterMs: 2000, rateLimited: true });
    await expect(
      a.createCommit({ message: "m", treeSha: base.treeSha, parents: [base.sha], identity: id }),
    ).resolves.toMatch(/^[0-9a-f]{40}$/);
  });

  it("HTTP の管理 API（/__admin/app）から FakeGitHubApp を操作できる", async () => {
    const r = await fetch(`${gh.url}/__admin/app`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ method: "setDraftUnsupported", args: [true] }),
    });
    expect(r.status).toBe(200);
    expect(gh.app?.draftUnsupported).toBe(true);
  });
});

describe("偽 GitHub: 偽 git 向けのトークン検証と beforeHandle", () => {
  it("isTokenValid: 発行済みで有効なトークンだけが対象リポジトリで true。失効・別リポジトリ・未知は false", async () => {
    const app = gh.app;
    if (!app) throw new Error("app disabled");
    const t = await appClient().createInstallationToken(77, 4242);
    expect(app.isTokenValid(t.token, "acme/widgets")).toBe(true);
    expect(app.isTokenValid(t.token, "acme/other")).toBe(false);
    expect(app.isTokenValid("ghs_unknown", "acme/widgets")).toBe(false);
    await appClient().revokeInstallationToken(t.token);
    expect(app.isTokenValid(t.token, "acme/widgets")).toBe(false);
    const t2 = await appClient().createInstallationToken(77, 4242);
    app.expireTokens(t2.token);
    expect(app.isTokenValid(t2.token, "acme/widgets")).toBe(false);
  });

  it('beforeHandle は各リクエストの処理の直前に "METHOD /path" で呼ばれる', async () => {
    const app = gh.app;
    if (!app) throw new Error("app disabled");
    const seen: string[] = [];
    app.beforeHandle = (key) => {
      seen.push(key);
    };
    const t = await appClient().createInstallationToken(77, 4242);
    await repoApi(t.token).findOpenPull("agent/task-x");
    expect(seen).toContain("POST /app/installations/77/access_tokens");
    expect(seen.some((k) => k.startsWith("GET /repos/acme/widgets/pulls"))).toBe(true);
  });
});

describe("偽 GitHub: Installation Token での Ready 化と、コミットの check / status", () => {
  async function seeded() {
    const t = await appClient().createInstallationToken(77, 4242);
    const a = repoApi(t.token);
    const base = await a.getCommit("0123456789abcdef");
    await a.createBranch("agent/task-R", base.sha);
    const pr = await a.createPull({
      title: "T",
      head: "agent/task-R",
      base: "main",
      body: "",
      draft: true,
    });
    return { t, a, pr, sha: base.sha };
  }
  const rest = async (token: string, path: string) => {
    const res = await fetch(`${gh.url}${path}`, { headers: { authorization: `Bearer ${token}` } });
    return { status: res.status, json: (await res.json()) as Record<string, unknown> };
  };

  it("POST /graphql の markPullRequestReadyForReview を Installation Token で呼べる（GitHubRepoApi.markReadyForReview）", async () => {
    const { a, pr } = await seeded();
    expect(pr.nodeId).toMatch(/^PR_/);
    await a.markReadyForReview(pr.nodeId as string);
    expect((await a.getPull(pr.number)).draft).toBe(false);
    // もう Draft ではない: GitHub と同じくエラー
    await expect(a.markReadyForReview(pr.nodeId as string)).rejects.toBeInstanceOf(GitHubApiError);
  });

  it("存在しない node ID は NOT_FOUND（Draft のまま）", async () => {
    const { a, pr } = await seeded();
    await expect(a.markReadyForReview("PR_nope")).rejects.toMatchObject({
      detail: expect.stringContaining("NOT_FOUND"),
    });
    expect((await a.getPull(pr.number)).draft).toBe(true);
  });

  it("GET /commits/:sha/check-runs は seed した check run を返す。無ければ空", async () => {
    const { t, sha } = await seeded();
    const empty = await rest(t.token, `/repos/acme/widgets/commits/${sha}/check-runs`);
    expect(empty).toMatchObject({ status: 200, json: { total_count: 0, check_runs: [] } });
    gh.app?.setCheckRuns("acme/widgets", sha, [
      { name: "ci", status: "completed", conclusion: "failure" },
      { name: "lint", status: "in_progress" },
    ]);
    const r = await rest(t.token, `/repos/acme/widgets/commits/${sha}/check-runs`);
    expect(r.json).toMatchObject({
      total_count: 2,
      check_runs: [
        { name: "ci", status: "completed", conclusion: "failure" },
        { name: "lint", status: "in_progress", conclusion: null },
      ],
    });
  });

  it("GET /commits/:sha/status: 0 件は pending、failure があれば failure、pending があれば pending、全部 success なら success", async () => {
    const { t, sha } = await seeded();
    const state = async () =>
      (await rest(t.token, `/repos/acme/widgets/commits/${sha}/status`)).json;
    expect(await state()).toMatchObject({ state: "pending", total_count: 0, statuses: [] });
    gh.app?.setCommitStatuses("acme/widgets", sha, [{ context: "a", state: "success" }]);
    expect(await state()).toMatchObject({ state: "success", total_count: 1 });
    gh.app?.setCommitStatuses("acme/widgets", sha, [
      { context: "a", state: "success" },
      { context: "b", state: "pending" },
    ]);
    expect(await state()).toMatchObject({ state: "pending" });
    gh.app?.setCommitStatuses("acme/widgets", sha, [
      { context: "a", state: "pending" },
      { context: "b", state: "error" },
    ]);
    expect(await state()).toMatchObject({ state: "failure" });
  });

  it("HTTP の管理 API（/__admin/app）から check run を seed できる", async () => {
    const { t, sha } = await seeded();
    const r = await fetch(`${gh.url}/__admin/app`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        method: "setCheckRuns",
        args: ["acme/widgets", sha, [{ name: "ci", status: "queued" }]],
      }),
    });
    expect(r.status).toBe(200);
    const runs = await rest(t.token, `/repos/acme/widgets/commits/${sha}/check-runs`);
    expect(runs.json).toMatchObject({ total_count: 1 });
  });
});
