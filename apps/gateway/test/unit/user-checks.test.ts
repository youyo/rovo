import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { CHECKS_CACHE_TTL_MS } from "../../src/tasks/user-do";
import { FakeGitHubFetch, installFakeGitHub } from "./fake-github-fetch";
import { newUserId } from "./helpers";

// ダッシュボードが閲覧者のトークンで PR の CI（check run と commit status）を読む UserDO の入口（dashboardChecks）。
// 8 秒のキャッシュ・同時呼び出しの束ね・fail-soft（unreadable）を確かめる。

const SEC = 1000;
const SHA = "d".repeat(40);

function clock(start = Date.now()) {
  let t = start;
  return {
    now: () => t,
    advance: (ms: number) => {
      t += ms;
    },
  };
}

interface Routes {
  runs: () => Response | Promise<Response>;
  status: () => Response | Promise<Response>;
  pull: () => Response | Promise<Response>;
}

const jsonRes = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

async function setup() {
  const uid = newUserId();
  const c = clock();
  const gh = new FakeGitHubFetch();
  gh.user = { id: uid, login: "alice" };
  const stub = await installFakeGitHub(uid, gh, { now: c.now });
  const seen: { path: string; auth: string | null }[] = [];
  const routes: Routes = {
    pull: () => jsonRes({ number: 7, head: { sha: SHA, ref: "x" } }),
    runs: () =>
      jsonRes({
        total_count: 1,
        check_runs: [
          {
            name: "build",
            status: "completed",
            conclusion: "success",
            started_at: "2026-10-21T05:00:00Z",
            completed_at: "2026-10-21T05:01:00Z",
            html_url: "https://github.com/acme/widgets/runs/1",
          },
        ],
      }),
    status: () =>
      jsonRes({
        state: "success",
        total_count: 1,
        statuses: [{ context: "ci/x", state: "success" }],
      }),
  };
  const orig = gh.fetch;
  const wrapped: typeof fetch = async (input, init) => {
    const req = new Request(input, init);
    const path = new URL(req.url).pathname;
    if (/^\/repos\//.test(path)) {
      seen.push({ path, auth: req.headers.get("authorization") });
      if (/\/pulls\/\d+$/.test(path)) return routes.pull();
      if (/\/check-runs$/.test(path)) return routes.runs();
      if (/\/status$/.test(path)) return routes.status();
    }
    return orig(input, init);
  };
  gh.fetch = wrapped;
  await runInDurableObject(stub, (i) => {
    (i as unknown as { githubFetch: typeof fetch }).githubFetch = wrapped;
  });
  return { uid, gh, stub, c, seen, routes };
}

const ref = (n = 7, repository = "acme/widgets") => ({ repository, number: n });

describe("dashboardChecks: 取得と解釈", () => {
  it("閲覧者のユーザートークンで pulls → check-runs → status を読み、ChecksDto の形で返す", async () => {
    const { uid, stub, seen } = await setup();
    const out = await stub.dashboardChecks(uid, ref());
    expect(out).toEqual({
      head_sha: SHA,
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
          completed_at: "2026-10-21T05:01:00Z",
          url: "https://github.com/acme/widgets/runs/1",
        },
        {
          name: "ci/x",
          kind: "status",
          status: "completed",
          conclusion: "success",
          started_at: null,
          completed_at: null,
          url: null,
        },
      ],
    });
    expect(seen.map((s) => s.path)).toEqual([
      "/repos/acme/widgets/pulls/7",
      `/repos/acme/widgets/commits/${SHA}/check-runs`,
      `/repos/acme/widgets/commits/${SHA}/status`,
    ]);
    expect(seen.every((s) => /^Bearer ghu_/.test(s.auth ?? ""))).toBe(true);
    expect(JSON.stringify(out)).not.toMatch(/ghu_|token/i);
  });

  it("CI が 1 つも無い PR は none（head_sha は返す）", async () => {
    const { uid, stub, routes } = await setup();
    routes.runs = () => jsonRes({ total_count: 0, check_runs: [] });
    routes.status = () => jsonRes({ state: "pending", total_count: 0, statuses: [] });
    expect(await stub.dashboardChecks(uid, ref())).toEqual({
      head_sha: SHA,
      state: "none",
      checks: [],
      truncated: false,
      partial: false,
    });
  });

  it("許可ルールを満たさない呼び出し（uid が DO の名前と違う）は GitHub を呼ばず unreadable", async () => {
    const { stub, seen } = await setup();
    const out = await stub.dashboardChecks(newUserId(), ref());
    expect(out).toMatchObject({ state: "unreadable", checks: [], head_sha: null });
    expect(seen).toEqual([]);
  });
});

describe("dashboardChecks: キャッシュ（8 秒）と束ね", () => {
  it("TTL は 8 秒。内は GitHub を呼ばず、過ぎたら取り直す。大文字小文字の違うリポジトリ名は同じキー", async () => {
    expect(CHECKS_CACHE_TTL_MS).toBe(8 * SEC);
    const { uid, stub, c, seen } = await setup();
    await stub.dashboardChecks(uid, ref());
    expect(seen).toHaveLength(3);
    c.advance(CHECKS_CACHE_TTL_MS - 1);
    await stub.dashboardChecks(uid, ref(7, "ACME/Widgets"));
    expect(seen).toHaveLength(3);
    c.advance(1);
    await stub.dashboardChecks(uid, ref());
    expect(seen).toHaveLength(6);
  });

  it("同じ PR の同時の呼び出しは進行中の問い合わせ 1 本に束ねる", async () => {
    const { uid, stub, seen, routes } = await setup();
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const orig = routes.pull;
    routes.pull = async () => {
      await gate;
      return orig();
    };
    const running = Promise.all([1, 2, 3].map(() => stub.dashboardChecks(uid, ref())));
    await new Promise((r) => setTimeout(r, 20));
    release();
    for (const out of await running) expect(out.state).toBe("passing");
    expect(seen.filter((s) => s.path.endsWith("/pulls/7"))).toHaveLength(1);
  });

  it("PR ごとに別のキー。件数に上限があり、あふれたら古いものから捨てる", async () => {
    const { uid, stub, seen } = await setup();
    await runInDurableObject(stub, (i) => {
      (i as unknown as { maxChecksCacheEntries: number }).maxChecksCacheEntries = 2;
    });
    await stub.dashboardChecks(uid, ref(1));
    await stub.dashboardChecks(uid, ref(2));
    await stub.dashboardChecks(uid, ref(3));
    const before = seen.length;
    await stub.dashboardChecks(uid, ref(3)); // 新しいものは残っている
    expect(seen.length).toBe(before);
    await stub.dashboardChecks(uid, ref(1)); // 古いものは捨てられた
    expect(seen.length).toBe(before + 3);
  });

  it("再ログイン（saveCredential）でキャッシュは捨てる", async () => {
    const { uid, gh, stub, seen } = await setup();
    await stub.dashboardChecks(uid, ref());
    await stub.saveCredential(gh.issue());
    await stub.dashboardChecks(uid, ref());
    expect(seen).toHaveLength(6);
  });
});

describe("dashboardChecks: fail-soft（失敗は unreadable。例外にしない）", () => {
  it.each([401, 403, 404, 429, 500, 502])(
    "pulls が %i でも、unreadable（checks は空）で成功する",
    async (status) => {
      const { uid, stub, routes } = await setup();
      routes.pull = () => jsonRes({ message: "x" }, status);
      expect(await stub.dashboardChecks(uid, ref())).toEqual({
        head_sha: null,
        state: "unreadable",
        checks: [],
        truncated: false,
        partial: false,
      });
    },
  );

  it("check-runs と status の両方が 403（App に権限が無い）なら unreadable（head_sha も返さない）", async () => {
    const { uid, stub, routes } = await setup();
    routes.runs = () => jsonRes({ message: "Resource not accessible by integration" }, 403);
    routes.status = () => jsonRes({ message: "Resource not accessible by integration" }, 403);
    expect(await stub.dashboardChecks(uid, ref())).toEqual({
      head_sha: null,
      state: "unreadable",
      checks: [],
      truncated: false,
      partial: false,
    });
  });

  it("片方だけ読めたら、読めた分を返して partial", async () => {
    const { uid, stub, routes } = await setup();
    routes.runs = () => jsonRes({ message: "no" }, 403);
    const out = await stub.dashboardChecks(uid, ref());
    expect(out.partial).toBe(true);
    expect(out.state).toBe("passing");
    expect(out.checks.map((x) => x.name)).toEqual(["ci/x"]);
  });

  it("接続の失敗・非 JSON も unreadable", async () => {
    const { uid, stub, routes, c } = await setup();
    routes.pull = () => {
      throw new TypeError("network");
    };
    expect((await stub.dashboardChecks(uid, ref())).state).toBe("unreadable");
    c.advance(CHECKS_CACHE_TTL_MS);
    routes.pull = () => new Response("<html>", { status: 200 });
    expect((await stub.dashboardChecks(uid, ref())).state).toBe("unreadable");
  });

  it("失敗も 8 秒は取り直しに行かず（障害中に叩き続けない）、過ぎたら取り直して直る", async () => {
    const { uid, stub, routes, c, seen } = await setup();
    routes.pull = () => jsonRes({ message: "down" }, 500);
    expect((await stub.dashboardChecks(uid, ref())).state).toBe("unreadable");
    const n = seen.length;
    c.advance(3 * SEC);
    expect((await stub.dashboardChecks(uid, ref())).state).toBe("unreadable");
    expect(seen.length).toBe(n);
    routes.pull = () => jsonRes({ number: 7, head: { sha: SHA, ref: "x" } });
    c.advance(CHECKS_CACHE_TTL_MS);
    expect((await stub.dashboardChecks(uid, ref())).state).toBe("passing");
  });

  it("不正な repository / 番号は GitHub を呼ばず unreadable", async () => {
    const { uid, stub, seen } = await setup();
    expect((await stub.dashboardChecks(uid, { repository: "../x", number: 7 })).state).toBe(
      "unreadable",
    );
    expect((await stub.dashboardChecks(uid, { repository: "acme/widgets", number: 0 })).state).toBe(
      "unreadable",
    );
    expect(seen).toEqual([]);
  });
});
