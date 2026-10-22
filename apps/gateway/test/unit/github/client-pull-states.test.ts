import { describe, expect, it } from "vitest";
import { GitHubClient, GitHubError, MAX_PULL_STATE_BATCH } from "../../../src/github/client";
import { json as jsonBase, routerFetch } from "./helpers";

const json = (body: unknown, status = 200) => jsonBase(body, { status });
const rateLimited = () => jsonBase({}, { status: 403, headers: { "x-ratelimit-remaining": "0" } });

// ダッシュボードが PR の状態を GitHub から取る（閲覧者のユーザートークン）。GraphQL で 1 回にまとめ、
// owner / name / 番号は変数で渡す。応答の解釈（open / merged / closed / 欠け）と、失敗の写し方を確かめる。

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

const pr = (state: string, merged: boolean) => ({ pullRequest: { state, merged } });
type Sent = { query: string; variables: Record<string, unknown> };
const sentOf = async (req: Request) => (await req.clone().json()) as Sent;

describe("getPullStates", () => {
  it("1 回の POST /graphql にまとめ、OPEN / MERGED / CLOSED を open / merged / closed にする（順序は入力のまま）", async () => {
    const { client, calls } = make({
      "POST /graphql": () =>
        json({
          data: {
            r0: pr("CLOSED", false),
            r1: pr("OPEN", false),
            r2: pr("MERGED", true),
          },
        }),
    });
    const states = await client.getPullStates("tok", [
      { repository: "acme/a", number: 1 },
      { repository: "acme/b", number: 2 },
      { repository: "acme/c", number: 3 },
    ]);
    expect(states).toEqual(["closed", "open", "merged"]);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.headers.get("authorization")).toBe("Bearer tok");
  });

  it("owner / name / 番号は変数で渡し、クエリの文字列には埋めない（インジェクションを避ける）", async () => {
    const { client, calls } = make({
      "POST /graphql": () => json({ data: { r0: pr("OPEN", false) } }),
    });
    const evil = 'x"){id}}query{viewer{login';
    await client.getPullStates("tok", [{ repository: `${evil}/zq"nm`, number: 12 }]);
    const sent = await sentOf(calls[0] as Request);
    expect(sent.query).not.toContain("zqnm");
    expect(sent.query).not.toContain("zq");
    expect(sent.query).not.toContain("viewer{login");
    expect(sent.query).not.toContain("(number: 12");
    expect(Object.values(sent.variables)).toEqual([evil, 'zq"nm', 12]);
    // 同じ件数なら、中身が違ってもクエリは同じ（入力で変わらない）
    await client.getPullStates("tok", [{ repository: "acme/other", number: 5 }]);
    expect((await sentOf(calls[1] as Request)).query).toBe(sent.query);
  });

  it("merged が true なら state が CLOSED でも merged。未知の state・形の崩れ・pullRequest の欠けは unknown", async () => {
    const { client } = make({
      "POST /graphql": () =>
        json({
          data: {
            r0: pr("CLOSED", true),
            r1: pr("WEIRD", false),
            r2: { pullRequest: null },
            r3: null,
            r4: { pullRequest: { state: 5 } },
            r5: "oops",
          },
          // 一部の alias の失敗は errors に入るが、取れた分は使う
          errors: [{ type: "NOT_FOUND", path: ["r3"], message: "Could not resolve" }],
        }),
    });
    const states = await client.getPullStates(
      "tok",
      [0, 1, 2, 3, 4, 5].map((n) => ({ repository: "acme/a", number: n + 1 })),
    );
    expect(states).toEqual(["merged", "unknown", "unknown", "unknown", "unknown", "unknown"]);
  });

  it("owner/name の形でない repository は照会せず unknown。全部そうなら GitHub を呼ばない。0 件も呼ばない", async () => {
    const { client, calls } = make({
      "POST /graphql": () => json({ data: { r0: pr("OPEN", false) } }),
    });
    expect(await client.getPullStates("tok", [])).toEqual([]);
    expect(
      await client.getPullStates("tok", [
        { repository: "no-slash", number: 1 },
        { repository: "a/b", number: 0 },
      ]),
    ).toEqual(["unknown", "unknown"]);
    expect(calls).toHaveLength(0);
    // 混在: 照会できるものだけを送り、位置は保つ
    expect(
      await client.getPullStates("tok", [
        { repository: "bad", number: 1 },
        { repository: "acme/a", number: 1 },
      ]),
    ).toEqual(["unknown", "open"]);
    expect(calls).toHaveLength(1);
  });

  it("1 回の上限を超える件数は呼び出し側の誤り（分割は呼び出し側）", async () => {
    const { client, calls } = make({ "POST /graphql": () => json({ data: {} }) });
    const refs = Array.from({ length: MAX_PULL_STATE_BATCH + 1 }, (_, i) => ({
      repository: "acme/a",
      number: i + 1,
    }));
    await expect(client.getPullStates("tok", refs)).rejects.toThrow(RangeError);
    expect(calls).toHaveLength(0);
  });

  it("失敗の写し方: 401=reauth_required / 403=forbidden / レート制限・429・5xx=upstream_unavailable / 非 JSON・data なし=upstream_unavailable", async () => {
    const cases: [() => Response, string][] = [
      [() => json({ message: "Bad credentials" }, 401), "reauth_required"],
      [() => json({ message: "no" }, 403), "forbidden"],
      [rateLimited, "upstream_unavailable"],
      [() => json({}, 429), "upstream_unavailable"],
      [() => json({}, 502), "upstream_unavailable"],
      [() => new Response("<html>", { status: 200 }), "upstream_unavailable"],
      [
        () => json({ data: null, errors: [{ type: "RATE_LIMITED", message: "x" }] }),
        "upstream_unavailable",
      ],
      [() => json({ errors: [{ message: "x" }] }), "upstream_unavailable"],
    ];
    for (const [res, code] of cases) {
      const { client } = make({ "POST /graphql": res });
      const e = await errOf(client.getPullStates("tok", [{ repository: "acme/a", number: 1 }]));
      expect(e.code, `${res().status} ${code}`).toBe(code);
    }
  });

  it("ネットワークの失敗（接続・タイムアウト）は upstream_unavailable。要求にはタイムアウトの signal が付く", async () => {
    const signals: (AbortSignal | null | undefined)[] = [];
    const client = new GitHubClient({
      clientId: "cid",
      clientSecret: "csecret",
      apiBase: "https://api.gh.test",
      fetch: (async (_u: unknown, init?: RequestInit) => {
        signals.push(init?.signal);
        throw new TypeError("network");
      }) as unknown as typeof fetch,
    });
    const e = await errOf(client.getPullStates("tok", [{ repository: "acme/a", number: 1 }]));
    expect(e.code).toBe("upstream_unavailable");
    expect(signals[0]).toBeInstanceOf(AbortSignal);
  });

  it("エラーのメッセージにトークンを含めない", async () => {
    const { client } = make({ "POST /graphql": () => json({ message: "x" }, 500) });
    const e = await errOf(
      client.getPullStates("tok-secret-value", [{ repository: "acme/a", number: 1 }]),
    );
    expect(e.message).not.toContain("tok-secret-value");
  });
});
