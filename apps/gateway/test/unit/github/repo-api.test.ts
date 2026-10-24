import { describe, expect, it } from "vitest";
import { GitHubApiError, GitHubRepoApi } from "../../../src/github";
import { json, routerFetch } from "./helpers";

function api(routes: Parameters<typeof routerFetch>[0]) {
  const r = routerFetch(routes);
  const a = new GitHubRepoApi({
    token: "ghs_tok",
    repository: "acme/widgets",
    apiBase: "https://api.github.test",
    fetch: r.fetch,
  });
  return { a, ...r };
}

const SHA = "a".repeat(40);
const TREE = "b".repeat(40);

describe("GitHubRepoApi", () => {
  it("getCommit: 完全な SHA と tree を返す。token で認証する", async () => {
    const { a, calls } = api({
      "GET /repos/acme/widgets/git/commits/0123456": () =>
        json({ sha: SHA, tree: { sha: TREE }, parents: [] }),
    });
    expect(await a.getCommit("0123456")).toEqual({ sha: SHA, treeSha: TREE });
    expect(calls[0]?.headers.get("authorization")).toBe("Bearer ghs_tok");
  });

  it("getCommit: 404 は status 404 の GitHubApiError", async () => {
    const { a } = api({
      "GET /repos/acme/widgets/git/commits/dead": () =>
        json({ message: "Not Found" }, { status: 404 }),
    });
    await expect(a.getCommit("dead")).rejects.toMatchObject({ status: 404 });
  });

  it("createCommit: tree・parents・author・committer を指定どおりに送る（日時を固定できる）", async () => {
    const { a, calls } = api({
      "POST /repos/acme/widgets/git/commits": () => json({ sha: SHA }, { status: 201 }),
    });
    const sha = await a.createCommit({
      message: "rovo: start task X",
      treeSha: TREE,
      parents: [SHA],
      identity: { name: "rovo", email: "rovo@example.test", date: "2026-10-18T00:00:00Z" },
    });
    expect(sha).toBe(SHA);
    expect(await calls[0]?.json()).toEqual({
      message: "rovo: start task X",
      tree: TREE,
      parents: [SHA],
      author: { name: "rovo", email: "rovo@example.test", date: "2026-10-18T00:00:00Z" },
      committer: { name: "rovo", email: "rovo@example.test", date: "2026-10-18T00:00:00Z" },
    });
  });

  it("getBranchSha: あれば SHA、404 なら null", async () => {
    const { a } = api({
      "GET /repos/acme/widgets/git/ref/heads/agent/task-A": () =>
        json({ ref: "refs/heads/agent/task-A", object: { sha: SHA } }),
      "GET /repos/acme/widgets/git/ref/heads/agent/task-B": () =>
        json({ message: "Not Found" }, { status: 404 }),
    });
    expect(await a.getBranchSha("agent/task-A")).toBe(SHA);
    expect(await a.getBranchSha("agent/task-B")).toBeNull();
  });

  it("createBranch: 作成できれば created、Reference already exists の 422 は exists、他の 422 は例外", async () => {
    const { a, calls } = api({
      "POST /repos/acme/widgets/git/refs": [
        () => json({ ref: "x" }, { status: 201 }),
        () => json({ message: "Reference already exists" }, { status: 422 }),
        () => json({ message: "Object does not exist" }, { status: 422 }),
      ],
    });
    expect(await a.createBranch("agent/task-A", SHA)).toBe("created");
    expect(await calls[0]?.json()).toEqual({ ref: "refs/heads/agent/task-A", sha: SHA });
    expect(await a.createBranch("agent/task-A", SHA)).toBe("exists");
    await expect(a.createBranch("agent/task-A", SHA)).rejects.toBeInstanceOf(GitHubApiError);
  });

  it("compare: status と ahead/behind を返す", async () => {
    const { a } = api({
      [`GET /repos/acme/widgets/compare/${SHA}...${TREE}`]: () =>
        json({ status: "ahead", ahead_by: 2, behind_by: 0 }),
    });
    expect(await a.compare(SHA, TREE)).toEqual({ status: "ahead", aheadBy: 2, behindBy: 0 });
  });

  it("findOpenPull: head=owner:branch&state=open で探し、無ければ null", async () => {
    const { a, calls } = api({
      "GET /repos/acme/widgets/pulls": [
        () =>
          json([
            {
              number: 5,
              html_url: "https://gh.test/acme/widgets/pull/5",
              draft: true,
              state: "open",
              body: "b",
              head: { sha: SHA },
              base: { ref: "main" },
            },
          ]),
        () => json([]),
      ],
    });
    expect(await a.findOpenPull("agent/task-A")).toEqual({
      number: 5,
      nodeId: null,
      url: "https://gh.test/acme/widgets/pull/5",
      draft: true,
      state: "open",
      body: "b",
      headSha: SHA,
      baseRef: "main",
    });
    const u = new URL(calls[0]?.url ?? "");
    expect(u.searchParams.get("head")).toBe("acme:agent/task-A");
    expect(u.searchParams.get("state")).toBe("open");
    expect(await a.findOpenPull("agent/task-A")).toBeNull();
  });

  it("createPull / getPull / updatePullBody", async () => {
    const pr = {
      number: 9,
      html_url: "https://gh.test/p/9",
      draft: true,
      state: "open",
      body: "x",
      head: { sha: SHA },
      base: { ref: "main" },
    };
    const { a, calls } = api({
      "POST /repos/acme/widgets/pulls": () => json(pr, { status: 201 }),
      "GET /repos/acme/widgets/pulls/9": () => json(pr),
      "PATCH /repos/acme/widgets/pulls/9": () => json({ ...pr, body: "new" }),
    });
    const created = await a.createPull({
      title: "T",
      head: "agent/task-A",
      base: "main",
      body: "x",
      draft: true,
    });
    expect(created.number).toBe(9);
    expect(await calls[0]?.json()).toEqual({
      title: "T",
      head: "agent/task-A",
      base: "main",
      body: "x",
      draft: true,
    });
    expect((await a.getPull(9)).headSha).toBe(SHA);
    await a.updatePullBody(9, "new");
    expect(await calls[2]?.json()).toEqual({ body: "new" });
  });

  it("getPull: node_id を nodeId として返す（Ready 化に使う）", async () => {
    const { a } = api({
      "GET /repos/acme/widgets/pulls/9": () =>
        json({
          number: 9,
          node_id: "PR_node_9",
          html_url: "https://gh.test/p/9",
          draft: true,
          state: "open",
          body: "x",
          head: { sha: SHA },
          base: { ref: "main" },
        }),
    });
    expect((await a.getPull(9)).nodeId).toBe("PR_node_9");
  });

  describe("markReadyForReview（GraphQL。Installation Token）", () => {
    const ok = {
      data: { markPullRequestReadyForReview: { pullRequest: { id: "N", isDraft: false } } },
    };

    it("POST /graphql に node ID を変数で渡し、token で認証する", async () => {
      const { a, calls } = api({ "POST /graphql": () => json(ok) });
      await a.markReadyForReview("PR_node_9");
      const body = (await calls[0]?.json()) as { query: string; variables: { id: string } };
      expect(body.variables).toEqual({ id: "PR_node_9" });
      expect(body.query).toContain("markPullRequestReadyForReview");
      expect(body.query).not.toContain("PR_node_9");
      expect(calls[0]?.headers.get("authorization")).toBe("Bearer ghs_tok");
    });

    it("HTTP 200 の errors（権限不足・見つからない）も失敗にする", async () => {
      const { a } = api({
        "POST /graphql": () =>
          json({ data: null, errors: [{ type: "FORBIDDEN", message: "Resource not accessible" }] }),
      });
      await expect(a.markReadyForReview("N")).rejects.toMatchObject({
        detail: expect.stringContaining("FORBIDDEN"),
      });
    });

    it("isDraft が false にならなければ失敗にする。HTTP の失敗は status を保つ", async () => {
      const still = api({
        "POST /graphql": () =>
          json({ data: { markPullRequestReadyForReview: { pullRequest: { isDraft: true } } } }),
      });
      await expect(still.a.markReadyForReview("N")).rejects.toBeInstanceOf(GitHubApiError);
      const down = api({ "POST /graphql": () => json({ message: "bad" }, { status: 502 }) });
      await expect(down.a.markReadyForReview("N")).rejects.toMatchObject({ status: 502 });
    });
  });

  it("応答が壊れていれば GitHubApiError", async () => {
    const { a } = api({ "GET /repos/acme/widgets/pulls/9": () => json({ nope: 1 }) });
    await expect(a.getPull(9)).rejects.toBeInstanceOf(GitHubApiError);
  });

  it("repository の形式が不正なら構築時に拒否する", () => {
    expect(() => new GitHubRepoApi({ token: "t", repository: "bad" })).toThrow();
  });
});
