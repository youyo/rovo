import { describe, expect, it } from "vitest";
import { GitHubClient, GitHubError } from "../../../src/github/client";
import { json as jsonBase, routerFetch } from "./helpers";

const json = (body: unknown, status = 200) => jsonBase(body, { status });

// 利用者のトークンでの PR 操作（D9）。GitHub のエラーを、呼び出し元に分かるコードに写す。

function make(routes: Parameters<typeof routerFetch>[0]) {
  const r = routerFetch(routes);
  const client = new GitHubClient({
    clientId: "cid",
    clientSecret: "csecret",
    oauthBase: "https://gh.test",
    apiBase: "https://api.gh.test",
    fetch: r.fetch,
  });
  return { client, ...r };
}

async function errOf(p: Promise<unknown>): Promise<GitHubError> {
  try {
    await p;
  } catch (e) {
    if (e instanceof GitHubError) return e;
    throw e;
  }
  throw new Error("no error");
}

const PULL = {
  number: 7,
  node_id: "PR_node_7",
  html_url: "https://github.com/acme/widgets/pull/7",
  draft: true,
  state: "open",
  merged: false,
  head: { ref: "agent/task-X", sha: "a".repeat(40), repo: { full_name: "acme/widgets" } },
  base: { ref: "main", repo: { full_name: "acme/widgets" } },
};

describe("getPull（利用者のトークン）", () => {
  it("PR の node_id・draft・head・base を読む", async () => {
    const { client, calls } = make({
      "GET /repos/acme/widgets/pulls/7": () => json(PULL),
    });
    expect(await client.getPull("tok", "acme/widgets", 7)).toEqual({
      nodeId: "PR_node_7",
      number: 7,
      url: "https://github.com/acme/widgets/pull/7",
      draft: true,
      state: "open",
      merged: false,
      headSha: "a".repeat(40),
      headRef: "agent/task-X",
      headRepo: "acme/widgets",
      baseRef: "main",
      baseRepo: "acme/widgets",
    });
    expect(calls[0]?.headers.get("authorization")).toBe("Bearer tok");
  });

  it("404 は forbidden、401 は reauth_required、想定外の形は upstream_unavailable", async () => {
    const { client } = make({
      "GET /repos/acme/widgets/pulls/1": () => json({ message: "Not Found" }, 404),
      "GET /repos/acme/widgets/pulls/2": () => json({ message: "Bad credentials" }, 401),
      "GET /repos/acme/widgets/pulls/3": () => json({ number: 3 }),
    });
    expect((await errOf(client.getPull("t", "acme/widgets", 1))).code).toBe("forbidden");
    expect((await errOf(client.getPull("t", "acme/widgets", 2))).code).toBe("reauth_required");
    expect((await errOf(client.getPull("t", "acme/widgets", 3))).code).toBe("upstream_unavailable");
  });
});

describe("markReadyForReview（GraphQL）", () => {
  const ok = () =>
    json({
      data: { markPullRequestReadyForReview: { pullRequest: { id: "n", isDraft: false } } },
    });

  it("POST /graphql に node_id を渡し、isDraft:false を確かめる", async () => {
    const { client, calls } = make({ "POST /graphql": ok });
    await client.markReadyForReview("tok", "PR_node_7");
    const body = (await calls[0]?.json()) as { query: string; variables: { id: string } };
    expect(body.query).toContain("markPullRequestReadyForReview");
    expect(body.variables).toEqual({ id: "PR_node_7" });
    expect(calls[0]?.headers.get("authorization")).toBe("Bearer tok");
  });

  it("errors（HTTP 200）: FORBIDDEN / NOT_FOUND は forbidden、それ以外は github_rejected（GitHub のメッセージ付き）", async () => {
    const withErr = (type: string, message: string) => () =>
      json({ data: null, errors: [{ type, message }] });
    const f = (type: string, message: string) =>
      make({ "POST /graphql": withErr(type, message) }).client.markReadyForReview("t", "n");
    expect((await errOf(f("FORBIDDEN", "Resource not accessible by integration"))).code).toBe(
      "forbidden",
    );
    expect((await errOf(f("NOT_FOUND", "Could not resolve"))).code).toBe("forbidden");
    const other = await errOf(f("UNPROCESSABLE", "Pull request is not a draft"));
    expect(other.code).toBe("github_rejected");
    expect(other.message).toContain("Pull request is not a draft");
  });

  it("isDraft が false にならない応答は github_rejected。401 は reauth_required、5xx は upstream_unavailable", async () => {
    const bad = make({
      "POST /graphql": () =>
        json({ data: { markPullRequestReadyForReview: { pullRequest: { isDraft: true } } } }),
    });
    expect((await errOf(bad.client.markReadyForReview("t", "n"))).code).toBe("github_rejected");
    const r401 = make({ "POST /graphql": () => json({ message: "Bad credentials" }, 401) });
    expect((await errOf(r401.client.markReadyForReview("t", "n"))).code).toBe("reauth_required");
    const r502 = make({ "POST /graphql": () => json({ message: "x" }, 502) });
    expect((await errOf(r502.client.markReadyForReview("t", "n"))).code).toBe(
      "upstream_unavailable",
    );
  });
});

describe("mergePull", () => {
  const path = "PUT /repos/acme/widgets/pulls/7/merge";
  const args = { sha: "a".repeat(40), method: "squash" as const };

  it("sha と merge_method を送り、マージ後の sha を返す", async () => {
    const { client, calls } = make({
      [path]: () => json({ sha: "b".repeat(40), merged: true, message: "ok" }),
    });
    expect(await client.mergePull("tok", "acme/widgets", 7, args)).toEqual({
      sha: "b".repeat(40),
    });
    expect(await calls[0]?.json()).toEqual({ sha: "a".repeat(40), merge_method: "squash" });
  });

  it("405 はブランチ保護などによる拒否 merge_blocked（GitHub のメッセージを残す）、409 は head_moved、422 は merge_blocked", async () => {
    const f = (status: number, message: string) =>
      make({ [path]: () => json({ message }, status) }).client.mergePull(
        "t",
        "acme/widgets",
        7,
        args,
      );
    const blocked = await errOf(f(405, 'Required status check "ci" is expected.'));
    expect(blocked.code).toBe("merge_blocked");
    expect(blocked.status).toBe(405);
    expect(blocked.message).toContain('Required status check "ci" is expected.');
    const moved = await errOf(f(409, "Head branch was modified. Review and try the merge again."));
    expect(moved.code).toBe("head_moved");
    expect((await errOf(f(422, "Repository rule violations found"))).code).toBe("merge_blocked");
  });

  it("401 は reauth_required、403 は forbidden（権限の不足）、404 は forbidden、429 / 5xx は upstream_unavailable", async () => {
    const f = (status: number, headers: Record<string, string> = {}) =>
      make({
        [path]: () =>
          new Response(JSON.stringify({ message: "m" }), {
            status,
            headers: { "content-type": "application/json", ...headers },
          }),
      }).client.mergePull("t", "acme/widgets", 7, args);
    expect((await errOf(f(401))).code).toBe("reauth_required");
    const denied = await errOf(f(403));
    expect(denied.code).toBe("forbidden");
    expect(denied.message).toContain("403");
    expect(denied.message).toContain("m");
    expect((await errOf(f(404))).code).toBe("forbidden");
    expect((await errOf(f(403, { "x-ratelimit-remaining": "0" }))).code).toBe(
      "upstream_unavailable",
    );
    expect((await errOf(f(502))).code).toBe("upstream_unavailable");
  });

  it("GitHub のメッセージは 300 文字までに切り、改行などの制御文字を落とす。トークンは含めない", async () => {
    const long = `line1\nline2\u0000${"x".repeat(1000)}`;
    const e = await errOf(
      make({ [path]: () => json({ message: long }, 405) }).client.mergePull(
        "ghu_secret",
        "acme/widgets",
        7,
        args,
      ),
    );
    expect(e.message.length).toBeLessThan(400);
    expect(
      [...e.message].every((ch) => ch.charCodeAt(0) >= 0x20 && ch.charCodeAt(0) !== 0x7f),
    ).toBe(true);
    expect(e.message).not.toContain("ghu_secret");
  });
});

describe("deleteBranch", () => {
  it("DELETE git/refs/heads/{branch}（/ を残してエスケープ）。204 で成功、すでに無い（422）も成功", async () => {
    const ok = make({
      "DELETE /repos/acme/widgets/git/refs/heads/agent/task-X": () =>
        new Response(null, { status: 204 }),
    });
    await ok.client.deleteBranch("tok", "acme/widgets", "agent/task-X");
    expect(ok.calls[0]?.headers.get("authorization")).toBe("Bearer tok");
    const gone = make({
      "DELETE /repos/acme/widgets/git/refs/heads/agent/task-X": () =>
        json({ message: "Reference does not exist" }, 422),
    });
    await gone.client.deleteBranch("tok", "acme/widgets", "agent/task-X");
  });

  it("403 は forbidden（Contents の write が無い）。保護されたブランチなど、その他の 4xx は github_rejected", async () => {
    const f = (status: number) =>
      make({
        "DELETE /repos/acme/widgets/git/refs/heads/b": () => json({ message: "nope" }, status),
      }).client.deleteBranch("t", "acme/widgets", "b");
    expect((await errOf(f(403))).code).toBe("forbidden");
    expect((await errOf(f(409))).code).toBe("github_rejected");
    expect((await errOf(f(500))).code).toBe("upstream_unavailable");
  });
});

describe("getCheckState（PR の head に付いた check と status）", () => {
  const SHA = "a".repeat(40);
  const RUNS = `GET /repos/acme/widgets/commits/${SHA}/check-runs`;
  const STATUS = `GET /repos/acme/widgets/commits/${SHA}/status`;
  const runs = (...rs: { status: string; conclusion?: string | null }[]) =>
    json({
      total_count: rs.length,
      check_runs: rs.map((r, i) => ({
        id: i,
        name: `c${i}`,
        status: r.status,
        conclusion: r.conclusion ?? null,
      })),
    });
  const statuses = (state: string, ...ss: string[]) =>
    json({ state, sha: SHA, total_count: ss.length, statuses: ss.map((s) => ({ state: s })) });
  const state = (routes: Parameters<typeof routerFetch>[0]) =>
    make(routes).client.getCheckState("tok", "acme/widgets", SHA);

  it("check run も status も 1 つも無ければ none（statuses が 0 件の pending は「無い」とみなす）", async () => {
    expect(await state({ [RUNS]: () => runs(), [STATUS]: () => statuses("pending") })).toBe("none");
  });

  it("check run がすべて success / skipped / neutral なら passing", async () => {
    expect(
      await state({
        [RUNS]: () =>
          runs(
            { status: "completed", conclusion: "success" },
            { status: "completed", conclusion: "skipped" },
            { status: "completed", conclusion: "neutral" },
          ),
        [STATUS]: () => statuses("pending"),
      }),
    ).toBe("passing");
  });

  it("commit status がすべて success なら passing（check run は無い）", async () => {
    expect(
      await state({ [RUNS]: () => runs(), [STATUS]: () => statuses("success", "success") }),
    ).toBe("passing");
  });

  it("check run の conclusion が success / skipped / neutral 以外（failure・cancelled・timed_out・action_required・stale）なら failing", async () => {
    for (const conclusion of ["failure", "cancelled", "timed_out", "action_required", "stale"]) {
      expect(
        await state({
          [RUNS]: () =>
            runs(
              { status: "completed", conclusion: "success" },
              { status: "completed", conclusion },
            ),
          [STATUS]: () => statuses("pending"),
        }),
        conclusion,
      ).toBe("failing");
    }
  });

  it("check run が completed でない（queued / in_progress）なら pending。failing があれば failing が先", async () => {
    expect(
      await state({
        [RUNS]: () =>
          runs({ status: "in_progress" }, { status: "completed", conclusion: "success" }),
        [STATUS]: () => statuses("pending"),
      }),
    ).toBe("pending");
    expect(
      await state({
        [RUNS]: () => runs({ status: "queued" }),
        [STATUS]: () => statuses("pending"),
      }),
    ).toBe("pending");
    expect(
      await state({
        [RUNS]: () => runs({ status: "queued" }, { status: "completed", conclusion: "failure" }),
        [STATUS]: () => statuses("pending"),
      }),
    ).toBe("failing");
  });

  it("commit status の failure / error は failing、pending（1 件以上）は pending", async () => {
    expect(
      await state({
        [RUNS]: () => runs(),
        [STATUS]: () => statuses("failure", "failure", "success"),
      }),
    ).toBe("failing");
    expect(
      await state({ [RUNS]: () => runs(), [STATUS]: () => statuses("failure", "error") }),
    ).toBe("failing");
    expect(
      await state({ [RUNS]: () => runs(), [STATUS]: () => statuses("pending", "pending") }),
    ).toBe("pending");
  });

  it("check run が成功でも、commit status が失敗なら failing", async () => {
    expect(
      await state({
        [RUNS]: () => runs({ status: "completed", conclusion: "success" }),
        [STATUS]: () => statuses("failure", "failure"),
      }),
    ).toBe("failing");
  });

  it("check run は Link ヘッダの次のページも読む", async () => {
    const page2 = `https://api.gh.test/repos/acme/widgets/commits/${SHA}/check-runs?per_page=100&page=2`;
    const { client, calls } = make({
      [RUNS]: (req) =>
        new URL(req.url).searchParams.get("page") === "2"
          ? runs({ status: "completed", conclusion: "failure" })
          : jsonBase(
              {
                total_count: 2,
                check_runs: [{ id: 1, name: "a", status: "completed", conclusion: "success" }],
              },
              { headers: { link: `<${page2}>; rel="next"` } },
            ),
      [STATUS]: () => statuses("pending"),
    });
    expect(await client.getCheckState("tok", "acme/widgets", SHA)).toBe("failing");
    expect(calls.filter((c) => new URL(c.url).pathname.endsWith("/check-runs")).length).toBe(2);
    expect(calls[0]?.headers.get("authorization")).toBe("Bearer tok");
  });

  it("読めない（403 = Checks の read 権限が無い・404・5xx）ときは GitHubError。通してしまわない", async () => {
    const e403 = await errOf(
      state({ [RUNS]: () => json({ message: "nope" }, 403), [STATUS]: () => statuses("pending") }),
    );
    expect(e403.code).toBe("forbidden");
    const e500 = await errOf(
      state({ [RUNS]: () => runs(), [STATUS]: () => json({ message: "x" }, 500) }),
    );
    expect(e500.code).toBe("upstream_unavailable");
  });

  it("不正な sha は問い合わせない", async () => {
    const e = await errOf(make({}).client.getCheckState("tok", "acme/widgets", "../x"));
    expect(e.code).toBe("forbidden");
  });
});
