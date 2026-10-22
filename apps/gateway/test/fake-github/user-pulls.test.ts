import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { generateAppKeyPair } from "../support/app-keys";
import { type FakeGitHub, startFakeGitHub } from "./server";

// 偽 GitHub の「利用者のトークンでの PR 操作」（GraphQL の Ready 化・マージ・ブランチ削除）を、実際の HTTP で確かめる。

const REPO = { id: 4242, fullName: "acme/widgets", push: true };
const BRANCH = "agent/task-X";
let gh: FakeGitHub;
let token: string;
let headSha: string;

async function admin(path: string, body: unknown = {}) {
  const res = await fetch(`${gh.url}/__admin/${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  expect(res.status).toBe(200);
  return res.json() as Promise<Record<string, unknown>>;
}

async function loginAs(login: string): Promise<string> {
  const res = await fetch(
    `${gh.url}/login/oauth/authorize?client_id=${gh.clientId}&redirect_uri=${encodeURIComponent("http://app.test/cb")}&state=s&login=${login}`,
    { redirect: "manual" },
  );
  const code = new URL(res.headers.get("location") ?? "").searchParams.get("code") ?? "";
  const t = await fetch(`${gh.url}/login/oauth/access_token`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({ client_id: gh.clientId, client_secret: gh.clientSecret, code }),
  });
  return ((await t.json()) as { access_token: string }).access_token;
}

function call(method: string, path: string, body?: unknown, tok: string | null = token) {
  return fetch(`${gh.url}${path}`, {
    method,
    headers: {
      ...(tok ? { authorization: `Bearer ${tok}` } : {}),
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}

const READY_QUERY =
  "mutation($id: ID!) { markPullRequestReadyForReview(input: {pullRequestId: $id}) { pullRequest { id isDraft } } }";

async function nodeId(): Promise<string> {
  const pull = (await (await call("GET", "/repos/acme/widgets/pulls/1")).json()) as {
    node_id: string;
  };
  return pull.node_id;
}

beforeEach(async () => {
  const keys = await generateAppKeyPair();
  gh = await startFakeGitHub({ app: { appId: "424242", publicKeyPem: keys.publicPem } });
  await admin("installations", { id: 77, repositories: [REPO] });
  await admin("users", { id: 1, login: "alice" });
  token = await loginAs("alice");
  const app = gh.app;
  if (!app) throw new Error("app is required");
  headSha = await app.addCommit(REPO.fullName, "0123456789abcdef", "work");
  app.setBranch(REPO.fullName, BRANCH, headSha);
  app.seedPull(REPO.fullName, { head: BRANCH, base: "main", draft: true });
});
afterEach(async () => {
  await gh.stop();
});

describe("偽 GitHub: 利用者のトークンでの Pulls", () => {
  it("GET pulls/{n}: node_id・merged・head.sha・head.repo / base.repo を返す", async () => {
    const res = await call("GET", "/repos/acme/widgets/pulls/1");
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      number: 1,
      node_id: expect.stringMatching(/^PR_/),
      draft: true,
      state: "open",
      merged: false,
      head: { ref: BRANCH, sha: headSha, repo: { full_name: "acme/widgets" } },
      base: { ref: "main", repo: { full_name: "acme/widgets" } },
    });
  });

  it("トークン無し・不明なトークンは 401。push できないリポジトリは 404", async () => {
    expect((await call("GET", "/repos/acme/widgets/pulls/1", undefined, null)).status).toBe(401);
    expect((await call("GET", "/repos/acme/widgets/pulls/1", undefined, "ghu_nope")).status).toBe(
      401,
    );
    expect((await call("POST", "/graphql", { query: READY_QUERY }, null)).status).toBe(401);
    await admin("installations", {
      id: 77,
      repositories: [{ ...REPO, push: false }],
    });
    expect((await call("GET", "/repos/acme/widgets/pulls/1")).status).toBe(404);
  });

  it("POST /graphql の markPullRequestReadyForReview: Draft を外し、isDraft:false を返す", async () => {
    const res = await call("POST", "/graphql", {
      query: READY_QUERY,
      variables: { id: await nodeId() },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      data: { markPullRequestReadyForReview: { pullRequest: { isDraft: false } } },
    });
    expect(gh.app?.pulls(REPO.fullName)[0]?.draft).toBe(false);
  });

  it("GraphQL のエラーは HTTP 200 の errors で返す（不明な node / 権限なし / 対象外の操作）", async () => {
    const missing = await (
      await call("POST", "/graphql", { query: READY_QUERY, variables: { id: "PR_nope" } })
    ).json();
    expect(missing).toMatchObject({ errors: [{ type: "NOT_FOUND" }] });
    gh.app?.setUserPermissions({ contents: "write", pull_requests: "read" });
    const denied = await (
      await call("POST", "/graphql", { query: READY_QUERY, variables: { id: await nodeId() } })
    ).json();
    expect(denied).toMatchObject({
      errors: [{ type: "FORBIDDEN", message: "Resource not accessible by integration" }],
    });
    expect(gh.app?.pulls(REPO.fullName)[0]?.draft).toBe(true);
    const other = await (await call("POST", "/graphql", { query: "{ viewer { login } }" })).json();
    expect(other).toMatchObject({ errors: [{ type: "UNSUPPORTED" }] });
  });

  describe("PUT pulls/{n}/merge", () => {
    const merge = (body: Record<string, unknown>) =>
      call("PUT", "/repos/acme/widgets/pulls/1/merge", body);

    async function makeReady() {
      await call("POST", "/graphql", { query: READY_QUERY, variables: { id: await nodeId() } });
    }

    it("Draft は 405（Pull Request is still a draft）", async () => {
      const res = await merge({ sha: headSha, merge_method: "squash" });
      expect(res.status).toBe(405);
      expect(await res.json()).toMatchObject({ message: expect.stringContaining("draft") });
    });

    it("sha が head と違えば 409。一致すれば merged:true で、PR は merged / closed になり、方法と sha が残る", async () => {
      await makeReady();
      const stale = await merge({ sha: "0".repeat(40), merge_method: "squash" });
      expect(stale.status).toBe(409);
      expect(gh.app?.pulls(REPO.fullName)[0]?.merged).toBe(false);
      const ok = await merge({ sha: headSha, merge_method: "squash" });
      expect(ok.status).toBe(200);
      expect(await ok.json()).toMatchObject({ merged: true, sha: headSha });
      expect(gh.app?.pulls(REPO.fullName)[0]).toMatchObject({
        merged: true,
        state: "closed",
        mergeMethod: "squash",
        mergeSha: headSha,
      });
      // 2 回目は 405（マージ済み）
      expect((await merge({ sha: headSha, merge_method: "squash" })).status).toBe(405);
    });

    it("ブランチ保護の再現（setMergeBlock）は 405 とそのメッセージ。解除すると通る", async () => {
      await makeReady();
      gh.app?.setMergeBlock(REPO.fullName, 'Required status check "ci" is expected.');
      const blocked = await merge({ sha: headSha, merge_method: "squash" });
      expect(blocked.status).toBe(405);
      expect(await blocked.json()).toMatchObject({
        message: 'Required status check "ci" is expected.',
      });
      expect(gh.app?.pulls(REPO.fullName)[0]?.merged).toBe(false);
      gh.app?.setMergeBlock(REPO.fullName, null);
      expect((await merge({ sha: headSha, merge_method: "squash" })).status).toBe(200);
    });

    it("許可していないマージ方法は 405、不正な方法は 422、App に書き込み権限が無ければ 403", async () => {
      await makeReady();
      gh.app?.disallowMergeMethod(REPO.fullName, "rebase");
      expect((await merge({ sha: headSha, merge_method: "rebase" })).status).toBe(405);
      expect((await merge({ sha: headSha, merge_method: "fast" })).status).toBe(422);
      gh.app?.setUserPermissions({ contents: "read", pull_requests: "write" });
      expect((await merge({ sha: headSha, merge_method: "squash" })).status).toBe(403);
    });
  });

  it("DELETE git/refs/heads/{branch}: 204 でブランチが消え、無ければ 422", async () => {
    const res = await call("DELETE", `/repos/acme/widgets/git/refs/heads/${BRANCH}`);
    expect(res.status).toBe(204);
    expect(gh.app?.branch(REPO.fullName, BRANCH)).toBeNull();
    const again = await call("DELETE", `/repos/acme/widgets/git/refs/heads/${BRANCH}`);
    expect(again.status).toBe(422);
  });

  it("障害の注入（POST /graphql・PUT merge）が効く", async () => {
    gh.app?.setFault({ pattern: "^POST /graphql$", status: 502, count: 1 });
    const bad = await call("POST", "/graphql", { query: READY_QUERY, variables: { id: "x" } });
    expect(bad.status).toBe(502);
    const next = await call("POST", "/graphql", { query: READY_QUERY, variables: { id: "x" } });
    expect(next.status).toBe(200);
  });
});

// ダッシュボードが PR の状態を取る GraphQL（repository(owner,name){ pullRequest(number){ state merged } } を alias で並べる）。
const STATE_QUERY =
  "query($o0: String!, $n0: String!, $p0: Int!, $o1: String!, $n1: String!, $p1: Int!) { r0: repository(owner: $o0, name: $n0) { pullRequest(number: $p0) { state merged } } r1: repository(owner: $o1, name: $n1) { pullRequest(number: $p1) { state merged } } }";

describe("偽 GitHub: PR の状態の GraphQL（ダッシュボード）", () => {
  const ask = async (variables: Record<string, unknown>, tok: string | null = token) =>
    (await call("POST", "/graphql", { query: STATE_QUERY, variables }, tok)).json() as Promise<{
      data: Record<string, { pullRequest: { state: string; merged: boolean } | null } | null>;
      errors?: { type: string; path: string[] }[];
    }>;

  it("open は OPEN、閉じたら CLOSED。無い PR は pullRequest: null", async () => {
    const vars = { o0: "acme", n0: "widgets", p0: 1, o1: "acme", n1: "widgets", p1: 99 };
    expect((await ask(vars)).data).toEqual({
      r0: { pullRequest: { state: "OPEN", merged: false } },
      r1: { pullRequest: null },
    });
    gh.app?.closePull(REPO.fullName, 1);
    expect((await ask(vars)).data.r0).toEqual({ pullRequest: { state: "CLOSED", merged: false } });
  });

  it("マージ済みは MERGED（merged: true）", async () => {
    // Draft のままだとマージできないので、Ready にしてから
    await call("POST", "/graphql", { query: READY_QUERY, variables: { id: await nodeId() } });
    const merge = await call("PUT", "/repos/acme/widgets/pulls/1/merge", {
      sha: headSha,
      merge_method: "squash",
    });
    expect(merge.status).toBe(200);
    const vars = { o0: "acme", n0: "widgets", p0: 1, o1: "acme", n1: "widgets", p1: 1 };
    expect((await ask(vars)).data.r0).toEqual({ pullRequest: { state: "MERGED", merged: true } });
  });

  it("見えないリポジトリは data が null + NOT_FOUND（存在を隠す）。トークン無しは 401", async () => {
    await admin("users", { id: 2, login: "bob" });
    await admin("installations", {
      id: 77,
      repositories: [{ ...REPO, visibleTo: ["alice"] }],
    });
    const bob = await loginAs("bob");
    const body = await ask({ o0: "acme", n0: "widgets", p0: 1, o1: "x", n1: "y", p1: 1 }, bob);
    expect(body.data.r0).toBeNull();
    expect(body.errors?.map((e) => e.type)).toContain("NOT_FOUND");
    const none = await call("POST", "/graphql", { query: STATE_QUERY, variables: {} }, null);
    expect(none.status).toBe(401);
  });

  it("PR の URL の host を変えられる（setPrHost）。reset で既定に戻る", async () => {
    const url = async () =>
      ((await (await call("GET", "/repos/acme/widgets/pulls/1")).json()) as { html_url: string })
        .html_url;
    expect(await url()).toBe("https://github.test/acme/widgets/pull/1");
    gh.app?.setPrHost("github.com");
    expect(await url()).toBe("https://github.com/acme/widgets/pull/1");
    gh.app?.reset();
    expect(gh.app?.prHost).toBe("github.test");
  });
});
