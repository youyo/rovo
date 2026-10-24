import { describe, expect, it } from "vitest";
import { GitHubRepoApi } from "../../../src/github";
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

const HEAD = "a".repeat(40);
const BASE = "b".repeat(40);

describe("GitHubRepoApi: task_review（レビューの投稿と差分）", () => {
  it("createPullReview: event は常に COMMENT、commit_id はレビューした head（APPROVE / REQUEST_CHANGES を送る口は無い）", async () => {
    const { a, calls } = api({
      "POST /repos/acme/widgets/pulls/7/reviews": () =>
        json(
          {
            id: 99,
            html_url: "https://github.test/acme/widgets/pull/7#pullrequestreview-99",
            state: "COMMENTED",
          },
          { status: 200 },
        ),
    });
    const r = await a.createPullReview(7, "body text", HEAD);
    expect(r).toEqual({
      id: 99,
      url: "https://github.test/acme/widgets/pull/7#pullrequestreview-99",
    });
    expect(await calls[0]?.json()).toEqual({
      body: "body text",
      event: "COMMENT",
      commit_id: HEAD,
    });
    expect(calls[0]?.headers.get("authorization")).toBe("Bearer ghs_tok");
    // 引数で event を渡す口が無い（型の上でも 3 引数だけ）
    expect(a.createPullReview.length).toBe(3);
  });

  it("createPullReview: 失敗は status 付きの GitHubApiError", async () => {
    const { a } = api({
      "POST /repos/acme/widgets/pulls/7/reviews": () =>
        json({ message: "Unprocessable" }, { status: 422 }),
    });
    await expect(a.createPullReview(7, "b", HEAD)).rejects.toMatchObject({ status: 422 });
  });

  it("getCompareDiff: base...head の diff を diff のメディア型で読む", async () => {
    const diff = "diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1 +1 @@\n-a\n+b\n";
    const { a, calls } = api({
      [`GET /repos/acme/widgets/compare/${BASE}...${HEAD}`]: () =>
        new Response(diff, { headers: { "content-type": "text/plain" } }),
    });
    expect(await a.getCompareDiff(BASE, HEAD, 1024)).toEqual({ diff, truncated: false });
    expect(calls[0]?.headers.get("accept")).toBe("application/vnd.github.diff");
  });

  it("getCompareDiff: 上限を超えたらファイルの区切りで切り、truncated", async () => {
    const file = (n: number) =>
      `diff --git a/f${n} b/f${n}\n--- a/f${n}\n+++ b/f${n}\n@@ -1 +1 @@\n-${"x".repeat(100)}\n+y\n`;
    const diff = `${file(1)}${file(2)}${file(3)}`;
    const { a } = api({
      [`GET /repos/acme/widgets/compare/${BASE}...${HEAD}`]: () => new Response(diff),
    });
    const r = await a.getCompareDiff(BASE, HEAD, file(1).length + file(2).length + 10);
    expect(r.truncated).toBe(true);
    expect(r.diff).toBe(`${file(1)}${file(2)}`);
  });

  it("getCompareDiff: 404 は status 404 の GitHubApiError", async () => {
    const { a } = api({
      [`GET /repos/acme/widgets/compare/${BASE}...${HEAD}`]: () =>
        json({ message: "Not Found" }, { status: 404 }),
    });
    await expect(a.getCompareDiff(BASE, HEAD, 1024)).rejects.toMatchObject({ status: 404 });
  });

  it("getPull: タイトルも読む", async () => {
    const { a } = api({
      "GET /repos/acme/widgets/pulls/7": () =>
        json({
          number: 7,
          html_url: "https://github.test/acme/widgets/pull/7",
          title: "Fix sum",
          body: "b",
          draft: false,
          state: "open",
          head: { sha: HEAD },
          base: { ref: "main" },
        }),
    });
    expect((await a.getPull(7)).title).toBe("Fix sum");
  });
});
