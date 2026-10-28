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
      // task_review が読む項目（応答に無ければ null / 空）
      baseSha: null,
      title: "",
      body: "",
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

describe("listChecks（PR の今の head に付いた check の一覧。ダッシュボード）", () => {
  const SHA = "b".repeat(40);
  const PULL_PATH = "GET /repos/acme/widgets/pulls/7";
  const RUNS = `GET /repos/acme/widgets/commits/${SHA}/check-runs`;
  const STATUS = `GET /repos/acme/widgets/commits/${SHA}/status`;
  const pull = () => json({ ...PULL, head: { ...PULL.head, sha: SHA } });
  const run = (over: Record<string, unknown> = {}) => ({
    id: 1,
    name: "build",
    status: "completed",
    conclusion: "success",
    started_at: "2026-10-21T05:00:00Z",
    completed_at: "2026-10-21T05:01:30Z",
    html_url: "https://github.com/acme/widgets/runs/1",
    details_url: "https://example.invalid/details",
    ...over,
  });
  const runs = (items: unknown[], total = items.length) =>
    json({ total_count: total, check_runs: items });
  const statuses = (items: unknown[], total = items.length) =>
    json({ state: "success", sha: SHA, total_count: total, statuses: items });
  const list = (routes: Parameters<typeof routerFetch>[0]) =>
    make({ [PULL_PATH]: pull, ...routes }).client.listChecks("tok", "acme/widgets", 7);

  it("PR の head を pulls/{n} から読み、check run と commit status を写す", async () => {
    const { client, calls } = make({
      [PULL_PATH]: pull,
      [RUNS]: () => runs([run()]),
      [STATUS]: () =>
        statuses([
          {
            context: "ci/preview",
            state: "success",
            target_url: "https://github.com/acme/widgets/deployments/1",
            updated_at: "2026-10-21T05:02:00Z",
          },
        ]),
    });
    const out = await client.listChecks("tok", "acme/widgets", 7);
    expect(out).toEqual({
      headSha: SHA,
      state: "passing",
      truncated: false,
      partial: false,
      checks: [
        {
          name: "build",
          kind: "check_run",
          status: "completed",
          conclusion: "success",
          started_at: "2026-10-21T05:00:00Z",
          completed_at: "2026-10-21T05:01:30Z",
          url: "https://github.com/acme/widgets/runs/1",
        },
        {
          name: "ci/preview",
          kind: "status",
          status: "completed",
          conclusion: "success",
          started_at: null,
          completed_at: null,
          url: "https://github.com/acme/widgets/deployments/1",
        },
      ],
    });
    // 利用者のトークンで、pulls → check-runs → status の順に読む
    expect(calls.map((c) => new URL(c.url).pathname)).toEqual([
      "/repos/acme/widgets/pulls/7",
      `/repos/acme/widgets/commits/${SHA}/check-runs`,
      `/repos/acme/widgets/commits/${SHA}/status`,
    ]);
    expect(calls.every((c) => c.headers.get("authorization") === "Bearer tok")).toBe(true);
  });

  it("リンクは https://github.com/ で始まるものだけ（html_url が外部なら details_url、どちらも外部なら null）", async () => {
    const out = await list({
      [RUNS]: () =>
        runs([
          run({
            name: "a",
            html_url: "https://evil.example/x",
            details_url: "https://github.com/acme/widgets/runs/9",
          }),
          run({
            name: "b",
            html_url: "javascript:alert(1)",
            details_url: "https://evil.example/y",
          }),
          run({ name: "c", html_url: null, details_url: "http://github.com/x" }),
          run({ name: "d", html_url: "https://github.com@evil.example/x", details_url: undefined }),
          run({
            name: "e",
            html_url: "https://github.com/acme/widgets/runs/1 x",
            details_url: undefined,
          }),
          run({
            name: "f",
            html_url: `https://github.com/${"a".repeat(400)}`,
            details_url: undefined,
          }),
        ]),
      [STATUS]: () =>
        statuses([
          { context: "s1", state: "success", target_url: "https://evil.example/z" },
          { context: "s2", state: "success", target_url: "data:text/html,x" },
          { context: "s3", state: "success", target_url: null },
        ]),
    });
    expect(out.checks.map((c) => [c.name, c.url])).toEqual([
      ["a", "https://github.com/acme/widgets/runs/9"],
      ["b", null],
      ["c", null],
      ["d", null],
      ["e", null],
      ["f", null],
      ["s1", null],
      ["s2", null],
      ["s3", null],
    ]);
  });

  it("名前は 200 文字で切り、名前の無い check は捨てる。不正な時刻は null", async () => {
    const out = await list({
      [RUNS]: () =>
        runs([
          run({ name: "n".repeat(500), started_at: "yesterday", completed_at: 5 }),
          run({ name: "" }),
          run({ name: undefined }),
        ]),
      [STATUS]: () => statuses([]),
    });
    expect(out.checks).toHaveLength(1);
    expect(out.checks[0]?.name).toBe("n".repeat(200));
    expect(out.checks[0]?.started_at).toBeNull();
    expect(out.checks[0]?.completed_at).toBeNull();
  });

  it("check run の status は queued / in_progress / completed に寄せ、commit status の pending は in_progress", async () => {
    const out = await list({
      [RUNS]: () =>
        runs([
          run({ name: "q", status: "queued", conclusion: null }),
          run({ name: "w", status: "waiting", conclusion: null }),
          run({ name: "p", status: "in_progress", conclusion: null }),
        ]),
      [STATUS]: () =>
        statuses([
          { context: "s-pending", state: "pending" },
          { context: "s-fail", state: "failure" },
          { context: "s-err", state: "error" },
        ]),
    });
    expect(out.checks.map((c) => [c.name, c.status, c.conclusion])).toEqual([
      ["q", "queued", null],
      ["w", "queued", null],
      ["p", "in_progress", null],
      ["s-pending", "in_progress", null],
      ["s-fail", "completed", "failure"],
      ["s-err", "completed", "error"],
    ]);
  });

  const stateOf = async (runItems: unknown[], statusItems: unknown[] = []): Promise<string> =>
    (await list({ [RUNS]: () => runs(runItems), [STATUS]: () => statuses(statusItems) })).state;

  it("集約: 無ければ none、success / skipped / neutral だけなら passing", async () => {
    expect(await stateOf([])).toBe("none");
    expect(
      await stateOf([
        run({ conclusion: "success" }),
        run({ conclusion: "skipped" }),
        run({ conclusion: "neutral" }),
      ]),
    ).toBe("passing");
    expect(await stateOf([], [{ context: "s", state: "success" }])).toBe("passing");
  });

  it("集約: 失敗（failure・cancelled・timed_out・action_required・stale・commit status の failure / error）があれば failing、実行中より優先", async () => {
    for (const conclusion of ["failure", "cancelled", "timed_out", "action_required", "stale"]) {
      expect(
        await stateOf([run({ conclusion }), run({ status: "in_progress", conclusion: null })]),
      ).toBe("failing");
    }
    expect(await stateOf([], [{ context: "s", state: "failure" }])).toBe("failing");
    expect(await stateOf([], [{ context: "s", state: "error" }])).toBe("failing");
  });

  it("集約: 失敗が無く、完了していない check run か pending の commit status があれば pending", async () => {
    expect(await stateOf([run(), run({ status: "queued", conclusion: null })])).toBe("pending");
    expect(await stateOf([run({ status: "in_progress", conclusion: null })])).toBe("pending");
    expect(await stateOf([], [{ context: "s", state: "pending" }])).toBe("pending");
  });

  it("total_count が返した件数より多ければ truncated（check run は 1 ページ 100 件だけ読む）", async () => {
    const { client, calls } = make({
      [PULL_PATH]: pull,
      [RUNS]: () => runs([run()], 150),
      [STATUS]: () => statuses([]),
    });
    const out = await client.listChecks("tok", "acme/widgets", 7);
    expect(out.truncated).toBe(true);
    expect(out.checks).toHaveLength(1);
    expect(calls.map((c) => new URL(c.url).search)).toContain("?per_page=100");
    const st = await list({
      [RUNS]: () => runs([]),
      [STATUS]: () => statuses([{ context: "s", state: "success" }], 101),
    });
    expect(st.truncated).toBe(true);
  });

  it("check-runs だけ 403 なら commit status の分を返し partial（権限が片方だけの App）", async () => {
    const out = await list({
      [RUNS]: () => json({ message: "Resource not accessible by integration" }, 403),
      [STATUS]: () => statuses([{ context: "s", state: "success" }]),
    });
    expect(out.partial).toBe(true);
    expect(out.state).toBe("passing");
    expect(out.checks.map((c) => c.name)).toEqual(["s"]);
  });

  it("status だけ 404 なら check run の分を返し partial", async () => {
    const out = await list({
      [RUNS]: () => runs([run()]),
      [STATUS]: () => json({ message: "Not Found" }, 404),
    });
    expect(out.partial).toBe(true);
    expect(out.checks.map((c) => c.name)).toEqual(["build"]);
  });

  it("両方読めなければ GitHubError（forbidden）。pulls が読めなくても同じ", async () => {
    const e = await errOf(
      list({
        [RUNS]: () => json({ message: "no" }, 403),
        [STATUS]: () => json({ message: "no" }, 403),
      }),
    );
    expect(e.code).toBe("forbidden");
    const e2 = await errOf(
      make({ [PULL_PATH]: () => json({ message: "Not Found" }, 404) }).client.listChecks(
        "tok",
        "acme/widgets",
        7,
      ),
    );
    expect(e2.code).toBe("forbidden");
  });

  it("5xx は片方だけなら partial、両方なら upstream_unavailable", async () => {
    const out = await list({
      [RUNS]: () => json({}, 502),
      [STATUS]: () => statuses([{ context: "s", state: "success" }]),
    });
    expect(out.partial).toBe(true);
    const e = await errOf(list({ [RUNS]: () => json({}, 502), [STATUS]: () => json({}, 500) }));
    expect(e.code).toBe("upstream_unavailable");
  });

  it("401 は片方でも reauth_required を投げる（partial にしない）", async () => {
    const e = await errOf(list({ [RUNS]: () => json({}, 401), [STATUS]: () => statuses([]) }));
    expect(e.code).toBe("reauth_required");
  });

  it("head の sha が 40 桁でない応答は upstream_unavailable", async () => {
    const e = await errOf(
      make({
        [PULL_PATH]: () => json({ ...PULL, head: { ...PULL.head, sha: "zz" } }),
      }).client.listChecks("tok", "acme/widgets", 7),
    );
    expect(e.code).toBe("upstream_unavailable");
  });
});
