import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import {
  MAX_PR_STATE_REFS,
  PR_STATE_FAILURE_TTL_MS,
  PR_STATE_FINAL_TTL_MS,
  PR_STATE_OPEN_TTL_MS,
} from "../../src/tasks/user-do";
import { FakeGitHubFetch, installFakeGitHub } from "./fake-github-fetch";
import { newUserId } from "./helpers";

// ダッシュボードが閲覧者のトークンで PR の状態を取る UserDO の入口（dashboardPullStates）。
// 呼び出しの数を抑える（GraphQL で束ねる・キャッシュ・同時呼び出しの束ね）ことと、失敗は fail-soft（unknown）であることを確かめる。

const SEC = 1000;

function clock(start = Date.now()) {
  let t = start;
  return {
    now: () => t,
    advance: (ms: number) => {
      t += ms;
    },
  };
}

async function setup() {
  const uid = newUserId();
  const c = clock();
  const gh = new FakeGitHubFetch();
  gh.user = { id: uid, login: "alice" };
  const stub = await installFakeGitHub(uid, gh, { now: c.now });
  return { uid, gh, stub, c };
}

const ref = (n: number, repository = "acme/widgets") => ({ repository, number: n });
const graphqlCalls = (gh: FakeGitHubFetch) => gh.calls.filter((c) => c.path === "/graphql").length;

describe("dashboardPullStates: 取得と解釈", () => {
  it("複数の PR を GraphQL 1 回にまとめ、入力と同じ並びで open / merged / closed を返す。見えない PR は unknown", async () => {
    const { uid, gh, stub } = await setup();
    gh.pulls.set("acme/widgets#1", { state: "OPEN" });
    gh.pulls.set("acme/widgets#2", { state: "MERGED" });
    gh.pulls.set("acme/other#3", { state: "CLOSED" });
    const states = await stub.dashboardPullStates(uid, [
      ref(1),
      ref(2),
      ref(3, "acme/other"),
      ref(4),
    ]);
    expect(states).toEqual(["open", "merged", "closed", "unknown"]);
    expect(graphqlCalls(gh)).toBe(1);
  });

  it("閲覧者のユーザートークンで呼び、owner / name / 番号は変数で渡す", async () => {
    const { uid, gh, stub } = await setup();
    gh.pulls.set("acme/widgets#1", { state: "OPEN" });
    await stub.dashboardPullStates(uid, [ref(1)]);
    const seen = gh.graphqlSeen[0];
    expect(seen?.auth).toMatch(/^Bearer ghu_/);
    expect(seen?.variables).toEqual({ o0: "acme", n0: "widgets", p0: 1 });
    expect(seen?.query).not.toContain("widgets");
  });

  it("同じ PR の重複は 1 件分だけ問い合わせる。大文字小文字の違うリポジトリ名も同じキー", async () => {
    const { uid, gh, stub } = await setup();
    gh.pulls.set("acme/widgets#1", { state: "OPEN" });
    const states = await stub.dashboardPullStates(uid, [ref(1), ref(1), ref(1, "ACME/Widgets")]);
    expect(states).toEqual(["open", "open", "open"]);
    expect(gh.graphqlBatches).toEqual([1]);
  });

  it("0 件なら GitHub を呼ばない。戻り値にトークンを含めない", async () => {
    const { uid, gh, stub } = await setup();
    expect(await stub.dashboardPullStates(uid, [])).toEqual([]);
    expect(graphqlCalls(gh)).toBe(0);
    gh.pulls.set("acme/widgets#1", { state: "OPEN" });
    expect(JSON.stringify(await stub.dashboardPullStates(uid, [ref(1)]))).not.toMatch(
      /ghu_|token/i,
    );
  });
});

describe("dashboardPullStates: 呼び出しの数を抑える", () => {
  it("40 件ずつに分け、同時に進む問い合わせは 3 本まで。上限を超える分は unknown（問い合わせない）", async () => {
    const { uid, gh, stub } = await setup();
    const total = MAX_PR_STATE_REFS + 30;
    for (let i = 1; i <= total; i++) gh.pulls.set(`acme/widgets#${i}`, { state: "OPEN" });
    const refs = Array.from({ length: total }, (_, i) => ref(i + 1));
    const states = await stub.dashboardPullStates(uid, refs);
    expect(states.slice(0, MAX_PR_STATE_REFS).every((s) => s === "open")).toBe(true);
    expect(states.slice(MAX_PR_STATE_REFS)).toEqual(Array(30).fill("unknown"));
    expect(gh.graphqlBatches.reduce((a, b) => a + b, 0)).toBe(MAX_PR_STATE_REFS);
    expect(Math.max(...gh.graphqlBatches)).toBeLessThanOrEqual(40);
    expect(gh.graphqlMaxParallel).toBeLessThanOrEqual(3);
  });

  it("open は 30 秒、merged / closed は 10 分キャッシュする。切れたら取り直す", async () => {
    expect(PR_STATE_OPEN_TTL_MS).toBe(30 * SEC);
    expect(PR_STATE_FINAL_TTL_MS).toBe(10 * 60 * SEC);
    const { uid, gh, stub, c } = await setup();
    gh.pulls.set("acme/widgets#1", { state: "OPEN" });
    gh.pulls.set("acme/widgets#2", { state: "MERGED" });
    gh.pulls.set("acme/widgets#3", { state: "CLOSED" });
    const all = [ref(1), ref(2), ref(3)];
    await stub.dashboardPullStates(uid, all);
    expect(graphqlCalls(gh)).toBe(1);

    // 29 秒後: すべてキャッシュ
    c.advance(PR_STATE_OPEN_TTL_MS - 1);
    expect(await stub.dashboardPullStates(uid, all)).toEqual(["open", "merged", "closed"]);
    expect(graphqlCalls(gh)).toBe(1);

    // 30 秒後: open だけ取り直す（merged / closed はキャッシュのまま）。GitHub 側で open が merged に変わっていた
    c.advance(1);
    gh.pulls.set("acme/widgets#1", { state: "MERGED" });
    expect(await stub.dashboardPullStates(uid, all)).toEqual(["merged", "merged", "closed"]);
    expect(gh.graphqlBatches).toEqual([3, 1]);

    // 10 分後: merged / closed も取り直す
    c.advance(PR_STATE_FINAL_TTL_MS);
    await stub.dashboardPullStates(uid, all);
    expect(gh.graphqlBatches).toEqual([3, 1, 3]);
  });

  it("同時の呼び出しは進行中の問い合わせ 1 本に束ねる", async () => {
    const { uid, gh, stub } = await setup();
    gh.pulls.set("acme/widgets#1", { state: "OPEN" });
    let release = () => {};
    gh.graphqlGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const running = Promise.all([1, 2, 3].map(() => stub.dashboardPullStates(uid, [ref(1)])));
    await new Promise((r) => setTimeout(r, 20));
    release();
    for (const s of await running) expect(s).toEqual(["open"]);
    expect(graphqlCalls(gh)).toBe(1);
  });

  it("再ログイン（saveCredential）でキャッシュは捨てる", async () => {
    const { uid, gh, stub } = await setup();
    gh.pulls.set("acme/widgets#1", { state: "OPEN" });
    await stub.dashboardPullStates(uid, [ref(1)]);
    await stub.saveCredential(gh.issue());
    await stub.dashboardPullStates(uid, [ref(1)]);
    expect(graphqlCalls(gh)).toBe(2);
  });
});

describe("dashboardPullStates: fail-soft（失敗は unknown。例外にしない）", () => {
  it.each([401, 403, 404, 429, 500, 502])(
    "GitHub が %i を返しても、全部 unknown で成功する",
    async (status) => {
      const { uid, gh, stub } = await setup();
      gh.pulls.set("acme/widgets#1", { state: "OPEN" });
      gh.graphqlFault = status;
      expect(await stub.dashboardPullStates(uid, [ref(1), ref(2)])).toEqual(["unknown", "unknown"]);
    },
  );

  it("レート制限（403 + remaining 0）・接続の失敗・非 JSON も unknown", async () => {
    const { uid, gh, stub, c } = await setup();
    const orig = gh.fetch;
    let mode: "rate" | "net" | "html" = "rate";
    gh.fetch = async (input, init) => {
      const url = new URL(new Request(input, init).url);
      if (url.pathname === "/graphql") {
        if (mode === "net") throw new TypeError("network");
        if (mode === "html") return new Response("<html>", { status: 200 });
        return new Response("{}", { status: 403, headers: { "x-ratelimit-remaining": "0" } });
      }
      return orig(input, init);
    };
    await runInDurableObject(stub, (i) => {
      (i as unknown as { githubFetch: typeof fetch }).githubFetch = gh.fetch;
    });
    for (const m of ["rate", "net", "html"] as const) {
      mode = m;
      c.advance(PR_STATE_FAILURE_TTL_MS + SEC);
      expect(await stub.dashboardPullStates(uid, [ref(1)]), m).toEqual(["unknown"]);
    }
  });

  it("失敗はすぐ取り直しに行かない（短くキャッシュ）が、10 秒を過ぎたら取り直して直る。成功の値は失敗で消えない", async () => {
    expect(PR_STATE_FAILURE_TTL_MS).toBe(10 * SEC);
    const { uid, gh, stub, c } = await setup();
    gh.pulls.set("acme/widgets#1", { state: "OPEN" });
    gh.pulls.set("acme/widgets#2", { state: "MERGED" });
    await stub.dashboardPullStates(uid, [ref(2)]); // merged はキャッシュされる

    gh.graphqlFault = 500;
    expect(await stub.dashboardPullStates(uid, [ref(1), ref(2)])).toEqual(["unknown", "merged"]);
    const n = graphqlCalls(gh);
    c.advance(5 * SEC);
    expect(await stub.dashboardPullStates(uid, [ref(1)])).toEqual(["unknown"]);
    expect(graphqlCalls(gh)).toBe(n); // 失敗を短くキャッシュしているので、GitHub を叩き続けない

    gh.graphqlFault = null;
    c.advance(PR_STATE_FAILURE_TTL_MS);
    expect(await stub.dashboardPullStates(uid, [ref(1)])).toEqual(["open"]);
  });

  it("1 つの分割が失敗しても、ほかの分割の結果は使う", async () => {
    const { uid, gh, stub } = await setup();
    const n = 90;
    for (let i = 1; i <= n; i++) gh.pulls.set(`acme/widgets#${i}`, { state: "CLOSED" });
    // 2 回目の問い合わせだけ 500
    const orig = gh.fetch;
    let seen = 0;
    gh.fetch = async (input, init) => {
      const req = new Request(input, init);
      if (new URL(req.url).pathname === "/graphql" && ++seen === 2) {
        return new Response("{}", { status: 500 });
      }
      return orig(req);
    };
    await runInDurableObject(stub, (i) => {
      (i as unknown as { githubFetch: typeof fetch }).githubFetch = gh.fetch;
    });
    const states = await stub.dashboardPullStates(
      uid,
      Array.from({ length: n }, (_, i) => ref(i + 1)),
    );
    expect(states.filter((s) => s === "closed")).toHaveLength(n - 40);
    expect(states.filter((s) => s === "unknown")).toHaveLength(40);
  });
});

describe("dashboardPullStates: 権限", () => {
  it("許可ルールを満たさない利用者は、GitHub を呼ばず全部 unknown（キャッシュがあっても返さない）", async () => {
    const { uid, gh, stub } = await setup();
    gh.pulls.set("acme/widgets#1", { state: "OPEN" });
    expect(await stub.dashboardPullStates(uid, [ref(1)])).toEqual(["open"]);
    gh.team = "none";
    const before = graphqlCalls(gh);
    // 所属の確認は 5 分キャッシュ。ルールが外れた（user ID のルールだけの構成で ID が違う）ケースで確かめる
    await runInDurableObject(stub, (i) => {
      const o = i as unknown as { env: Record<string, unknown> };
      o.env = { ...o.env, ALLOWED_ORG: "", ALLOWED_TEAM: "", ALLOWED_USER_IDS: String(uid + 1) };
    });
    expect(await stub.dashboardPullStates(uid, [ref(1)])).toEqual(["unknown"]);
    expect(graphqlCalls(gh)).toBe(before);
  });

  it("別の利用者の uid では呼べない（DO の名前と違う uid は denied = unknown）", async () => {
    const { uid, gh, stub } = await setup();
    gh.pulls.set("acme/widgets#1", { state: "OPEN" });
    expect(await stub.dashboardPullStates(uid + 1, [ref(1)])).toEqual(["unknown"]);
    expect(graphqlCalls(gh)).toBe(0);
  });

  it("資格が無い（ログインしていない）なら unknown。GitHub を呼ばない", async () => {
    const uid = newUserId();
    const gh = new FakeGitHubFetch();
    gh.user = { id: uid, login: "alice" };
    const stub = await installFakeGitHub(uid, gh, { login: false });
    expect(await stub.dashboardPullStates(uid, [ref(1)])).toEqual(["unknown"]);
    expect(graphqlCalls(gh)).toBe(0);
  });

  it("キャッシュはメモリだけ（DO の SQLite に PR の状態を残さない）", async () => {
    const { uid, gh, stub } = await setup();
    gh.pulls.set("acme/widgets#1", { state: "OPEN" });
    await stub.dashboardPullStates(uid, [ref(1)]);
    const tables = await runInDurableObject(stub, (_i, s) =>
      s.storage.sql
        .exec<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table'")
        .toArray()
        .map((r) => r.name),
    );
    expect(tables.filter((n) => /pull|pr_state/i.test(n))).toEqual([]);
  });
});
