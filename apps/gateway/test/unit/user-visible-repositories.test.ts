import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { VISIBLE_CACHE_TTL_MS } from "../../src/tasks/user-do";
import { FakeGitHubFetch, installFakeGitHub } from "./fake-github-fetch";
import { newUserId } from "./helpers";

// 閲覧者が見られる repository id の集合（docs/specs/dashboard.md D5・D6）。認可の核なので fail closed を厚く確かめる。

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

const repo = (id: number) => ({ id, full_name: `acme/r${id}`, push: true });

/** 自分の id を持つ偽 GitHub と、ログイン済みの UserDO を用意する。 */
async function setup(opts: { clock?: ReturnType<typeof clock> } = {}) {
  const uid = newUserId();
  const gh = new FakeGitHubFetch();
  gh.user = { id: uid, login: "alice" };
  const stub = await installFakeGitHub(uid, gh, opts.clock ? { now: opts.clock.now } : {});
  return { uid, gh, stub };
}

const listingCalls = (gh: FakeGitHubFetch) =>
  gh.calls.filter((c) => c.path.startsWith("/user/installations")).length;

async function patchEnv(stub: Awaited<ReturnType<typeof setup>>["stub"], over: object) {
  await runInDurableObject(stub, (i) => {
    const o = i as unknown as { env: Record<string, unknown> };
    o.env = { ...o.env, ...over };
  });
}

describe("visibleRepositoryIds: 列挙", () => {
  it("複数の installation・複数ページの和集合を、昇順の id の配列で返す（repository が 0 件の installation があってもよい）", async () => {
    const { uid, gh, stub } = await setup();
    gh.pageSize = 2;
    gh.installations = [
      { id: 1, repos: [5, 3, 1, 2, 4].map(repo) }, // 3 ページ
      { id: 2, repos: [11, 10].map(repo) }, // ちょうど 1 ページ（次のページは取りに行かない）
      { id: 3, repos: [] },
      { id: 4, repos: [3, 20, 21].map(repo) }, // 3 は別 installation と重複
    ];
    const r = await stub.visibleRepositoryIds(uid);
    expect(r).toEqual({ ok: true, ids: [1, 2, 3, 4, 5, 10, 11, 20, 21] });
    expect(gh.calls.filter((c) => c.path === "/user/installations")).toHaveLength(2);
    expect(gh.calls.filter((c) => c.path === "/user/installations/1/repositories")).toHaveLength(3);
    expect(gh.calls.filter((c) => c.path === "/user/installations/2/repositories")).toHaveLength(1);
  });

  it("installation が 0 件なら空の集合（成功）", async () => {
    const { uid, gh, stub } = await setup();
    gh.installations = [];
    expect(await stub.visibleRepositoryIds(uid)).toEqual({ ok: true, ids: [] });
  });

  it("push 権限が無いリポジトリも「見える」に含める（閲覧は読み取り）", async () => {
    const { uid, gh, stub } = await setup();
    gh.repos = [{ id: 7, full_name: "acme/ro", push: false }];
    expect(await stub.visibleRepositoryIds(uid)).toEqual({ ok: true, ids: [7] });
  });

  it("戻り値にトークンを含めない", async () => {
    const { uid, stub } = await setup();
    const raw = JSON.stringify(await stub.visibleRepositoryIds(uid));
    expect(raw).not.toMatch(/ghu_|ghr_|token/i);
  });
});

describe("visibleRepositoryIds: fail closed", () => {
  it("途中のページが 500 なら、部分的な集合を返さず unavailable", async () => {
    const { uid, gh, stub } = await setup();
    gh.pageSize = 2;
    gh.installations = [{ id: 1, repos: [1, 2, 3, 4, 5].map(repo) }];
    gh.pathFaults.set("/user/installations/1/repositories#2", 500);
    expect(await stub.visibleRepositoryIds(uid)).toEqual({ ok: false, code: "unavailable" });
  });

  it("2 つ目の installation の列挙が失敗しても unavailable（1 つ目の分だけで通さない）", async () => {
    const { uid, gh, stub } = await setup();
    gh.installations = [
      { id: 1, repos: [1].map(repo) },
      { id: 2, repos: [2].map(repo) },
    ];
    gh.pathFaults.set("/user/installations/2/repositories", 502);
    expect(await stub.visibleRepositoryIds(uid)).toEqual({ ok: false, code: "unavailable" });
  });

  it("installation の一覧そのものが失敗しても unavailable。失敗はキャッシュされず、直れば次の呼び出しで成功する", async () => {
    const { uid, gh, stub } = await setup();
    gh.pathFaults.set("/user/installations", 503);
    expect(await stub.visibleRepositoryIds(uid)).toEqual({ ok: false, code: "unavailable" });
    gh.pathFaults.clear();
    expect(await stub.visibleRepositoryIds(uid)).toEqual({ ok: true, ids: [4242] });
  });

  it("GitHub のレート制限（403 + remaining 0）は unavailable", async () => {
    const { uid, gh, stub } = await setup();
    const orig = gh.fetch;
    gh.fetch = async (input, init) => {
      const url = new URL(new Request(input, init).url);
      if (url.pathname === "/user/installations") {
        return new Response("{}", { status: 403, headers: { "x-ratelimit-remaining": "0" } });
      }
      return orig(input, init);
    };
    await runInDurableObject(stub, (i) => {
      (i as unknown as { githubFetch: typeof fetch }).githubFetch = gh.fetch;
    });
    expect(await stub.visibleRepositoryIds(uid)).toEqual({ ok: false, code: "unavailable" });
  });

  it("応答が JSON でないときも unavailable", async () => {
    const { uid, gh, stub } = await setup();
    const orig = gh.fetch;
    gh.fetch = async (input, init) => {
      const url = new URL(new Request(input, init).url);
      if (url.pathname === "/user/installations") return new Response("<html>", { status: 200 });
      return orig(input, init);
    };
    await runInDurableObject(stub, (i) => {
      (i as unknown as { githubFetch: typeof fetch }).githubFetch = gh.fetch;
    });
    expect(await stub.visibleRepositoryIds(uid)).toEqual({ ok: false, code: "unavailable" });
  });

  it("repository の id が数値でない項目があれば、その応答全体を信用せず unavailable", async () => {
    const { uid, gh, stub } = await setup();
    const orig = gh.fetch;
    gh.fetch = async (input, init) => {
      const url = new URL(new Request(input, init).url);
      if (url.pathname === "/user/installations/77/repositories") {
        return new Response(
          JSON.stringify({ total_count: 2, repositories: [{ id: 1 }, { id: "2" }] }),
          { status: 200 },
        );
      }
      return orig(input, init);
    };
    await runInDurableObject(stub, (i) => {
      (i as unknown as { githubFetch: typeof fetch }).githubFetch = gh.fetch;
    });
    expect(await stub.visibleRepositoryIds(uid)).toEqual({ ok: false, code: "unavailable" });
  });

  it("401 は unauthenticated（再ログインが必要）。キャッシュは捨てる", async () => {
    const { uid, gh, stub } = await setup();
    expect(await stub.visibleRepositoryIds(uid)).toEqual({ ok: true, ids: [4242] });
    gh.apiFault = 401;
    expect(await stub.visibleRepositoryIds(uid, { fresh: true })).toEqual({
      ok: false,
      code: "unauthenticated",
    });
    gh.apiFault = null;
    const before = listingCalls(gh);
    expect(await stub.visibleRepositoryIds(uid)).toEqual({ ok: true, ids: [4242] });
    expect(listingCalls(gh)).toBeGreaterThan(before); // キャッシュではなく取り直した
  });

  it("403 は denied。キャッシュは捨てる（古い集合で通さない）", async () => {
    const { uid, gh, stub } = await setup();
    expect(await stub.visibleRepositoryIds(uid)).toEqual({ ok: true, ids: [4242] });
    gh.pathFaults.set("/user/installations", 403);
    expect(await stub.visibleRepositoryIds(uid, { fresh: true })).toEqual({
      ok: false,
      code: "denied",
    });
    // キャッシュの TTL 内でも、古い集合は使わない
    expect(await stub.visibleRepositoryIds(uid)).toEqual({ ok: false, code: "denied" });
  });

  it("取得に失敗したあと、TTL 内でも古い集合を使わない（stale を延ばさない）", async () => {
    const c = clock();
    const { uid, gh, stub } = await setup({ clock: c });
    expect(await stub.visibleRepositoryIds(uid)).toEqual({ ok: true, ids: [4242] });
    gh.pathFaults.set("/user/installations", 500);
    expect(await stub.visibleRepositoryIds(uid, { fresh: true })).toEqual({
      ok: false,
      code: "unavailable",
    });
    // まだ TTL 内だが、失敗で破棄されているので取り直しに行って失敗する
    c.advance(1 * SEC);
    expect(await stub.visibleRepositoryIds(uid)).toEqual({ ok: false, code: "unavailable" });
  });

  it("TTL が切れたあとの取得の失敗も、古い集合を返さない", async () => {
    const c = clock();
    const { uid, gh, stub } = await setup({ clock: c });
    expect(await stub.visibleRepositoryIds(uid)).toEqual({ ok: true, ids: [4242] });
    c.advance(VISIBLE_CACHE_TTL_MS + SEC);
    gh.pathFaults.set("/user/installations", 500);
    expect(await stub.visibleRepositoryIds(uid)).toEqual({ ok: false, code: "unavailable" });
  });

  it("資格が無い（ログインしていない）なら unauthenticated。列挙は呼ばない", async () => {
    const uid = newUserId();
    const gh = new FakeGitHubFetch();
    gh.user = { id: uid, login: "alice" };
    const stub = await installFakeGitHub(uid, gh, { login: false });
    expect(await stub.visibleRepositoryIds(uid)).toEqual({ ok: false, code: "unauthenticated" });
    expect(listingCalls(gh)).toBe(0);
  });

  it("集合が上限を超えたら too_large（部分的な集合を返さない）", async () => {
    const { uid, gh, stub } = await setup();
    await runInDurableObject(stub, (i) => {
      (i as unknown as { maxVisibleRepositories: number }).maxVisibleRepositories = 3;
    });
    gh.installations = [
      { id: 1, repos: [1, 2].map(repo) },
      { id: 2, repos: [3, 4].map(repo) },
    ];
    expect(await stub.visibleRepositoryIds(uid)).toEqual({ ok: false, code: "too_large" });
    // 上限ちょうどは通る
    gh.installations = [{ id: 1, repos: [1, 2, 3].map(repo) }];
    expect(await stub.visibleRepositoryIds(uid, { fresh: true })).toEqual({
      ok: true,
      ids: [1, 2, 3],
    });
  });

  it("上限は重複を除いた件数で数える", async () => {
    const { uid, gh, stub } = await setup();
    await runInDurableObject(stub, (i) => {
      (i as unknown as { maxVisibleRepositories: number }).maxVisibleRepositories = 2;
    });
    gh.installations = [
      { id: 1, repos: [1, 2].map(repo) },
      { id: 2, repos: [1, 2].map(repo) },
    ];
    expect(await stub.visibleRepositoryIds(uid)).toEqual({ ok: true, ids: [1, 2] });
  });
});

describe("visibleRepositoryIds: 許可ルール", () => {
  it("team から外れた利用者は、資格があっても何も列挙されない（GitHub の列挙を呼ばない）", async () => {
    const { uid, gh, stub } = await setup();
    gh.team = "none";
    expect(await stub.visibleRepositoryIds(uid)).toEqual({ ok: false, code: "unauthenticated" });
    expect(listingCalls(gh)).toBe(0);
  });

  it("許可ルールが不正・未設定なら、キャッシュがあっても返さない", async () => {
    const { uid, stub } = await setup();
    expect(await stub.visibleRepositoryIds(uid)).toEqual({ ok: true, ids: [4242] });
    await patchEnv(stub, { ALLOWED_ORG: "", ALLOWED_TEAM: "", ALLOWED_USER_IDS: "" });
    expect(await stub.visibleRepositoryIds(uid)).toEqual({ ok: false, code: "unauthenticated" });
  });

  it("user ID のルールだけの構成で、ID が外れたらキャッシュがあっても返さない", async () => {
    const { uid, stub } = await setup();
    await patchEnv(stub, { ALLOWED_ORG: "", ALLOWED_TEAM: "", ALLOWED_USER_IDS: String(uid) });
    expect(await stub.visibleRepositoryIds(uid)).toEqual({ ok: true, ids: [4242] });
    await patchEnv(stub, { ALLOWED_USER_IDS: String(uid + 1) });
    expect(await stub.visibleRepositoryIds(uid)).toEqual({ ok: false, code: "unauthenticated" });
  });
});

describe("visibleRepositoryIds: キャッシュ（D6）", () => {
  it("一覧は 30 秒キャッシュする。TTL を過ぎたら取り直す", async () => {
    const c = clock();
    const { uid, gh, stub } = await setup({ clock: c });
    expect(VISIBLE_CACHE_TTL_MS).toBe(30 * SEC);
    await stub.visibleRepositoryIds(uid);
    const n = listingCalls(gh);
    c.advance(VISIBLE_CACHE_TTL_MS - 1);
    await stub.visibleRepositoryIds(uid);
    expect(listingCalls(gh)).toBe(n); // キャッシュ
    c.advance(1);
    gh.repos = [repo(1), repo(2)];
    expect(await stub.visibleRepositoryIds(uid)).toEqual({ ok: true, ids: [1, 2] });
    expect(listingCalls(gh)).toBeGreaterThan(n);
  });

  it("fresh: true（詳細を開いた最初）は、キャッシュがあっても必ず GitHub で取り直し、キャッシュも更新する", async () => {
    const c = clock();
    const { uid, gh, stub } = await setup({ clock: c });
    await stub.visibleRepositoryIds(uid);
    gh.repos = [repo(9)]; // 権限が変わった
    c.advance(1 * SEC);
    // 通常の呼び出しは古い集合（30 秒以内の遅れは許容）
    expect(await stub.visibleRepositoryIds(uid)).toEqual({ ok: true, ids: [4242] });
    expect(await stub.visibleRepositoryIds(uid, { fresh: true })).toEqual({ ok: true, ids: [9] });
    // 取り直した結果が以降のキャッシュになる
    expect(await stub.visibleRepositoryIds(uid)).toEqual({ ok: true, ids: [9] });
  });

  it("同時の呼び出しは進行中の取得 1 本に束ねる", async () => {
    const { uid, gh, stub } = await setup();
    const rs = await Promise.all([1, 2, 3, 4].map(() => stub.visibleRepositoryIds(uid)));
    for (const r of rs) expect(r).toEqual({ ok: true, ids: [4242] });
    expect(gh.calls.filter((c) => c.path === "/user/installations")).toHaveLength(1);
  });

  it("再ログイン（saveCredential）でキャッシュは捨てる", async () => {
    const { uid, gh, stub } = await setup();
    await stub.visibleRepositoryIds(uid);
    gh.repos = [repo(5)];
    await stub.saveCredential(gh.issue());
    expect(await stub.visibleRepositoryIds(uid)).toEqual({ ok: true, ids: [5] });
  });

  it("キャッシュはメモリだけ（DO の SQLite に権限を残さない）", async () => {
    const { uid, stub } = await setup();
    await stub.visibleRepositoryIds(uid);
    const tables = await runInDurableObject(stub, (_i, s) =>
      s.storage.sql
        .exec<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table'")
        .toArray()
        .map((r) => r.name),
    );
    expect(tables.filter((n) => /visible|repositor/i.test(n))).toEqual([]);
  });
});
