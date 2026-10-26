import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { MEMBERSHIP_CACHE_TTL_MS, type UserDO } from "../../src/tasks/user-do";
import { FakeGitHubFetch, installFakeGitHub } from "./fake-github-fetch";
import { newUserId } from "./helpers";

const MIN = 60_000;

function clock(start = Date.now()) {
  let t = start;
  return {
    now: () => t,
    advance: (ms: number) => {
      t += ms;
    },
  };
}

function sql<T>(stub: Awaited<ReturnType<typeof installFakeGitHub>>, q: string) {
  return runInDurableObject(stub, (_i, state) => state.storage.sql.exec(q).toArray() as T[]);
}

/** DO の中で解決した Promise を await すると呼び出し元が DO の I/O 文脈に入るので、タイマーで見に行く。 */
async function waitUntil(cond: () => boolean) {
  for (let i = 0; i < 200 && !cond(); i++) await new Promise((r) => setTimeout(r, 5));
  if (!cond()) throw new Error("timeout waiting for condition");
}

describe("UserDO.saveCredential", () => {
  it("DO には暗号文しか残らない（平文のトークンが無い）", async () => {
    const gh = new FakeGitHubFetch();
    const stub = await installFakeGitHub(newUserId(), gh, { login: false });
    await stub.saveCredential({
      accessToken: "ghu_PLAIN_ACCESS",
      refreshToken: "ghr_PLAIN_REFRESH",
      accessExpiresAt: Date.now() + 3600_000,
      refreshExpiresAt: Date.now() + 9e9,
    });
    const rows = await sql(stub, "SELECT * FROM github_credential");
    const raw = JSON.stringify(rows);
    expect(raw).not.toContain("PLAIN_ACCESS");
    expect(raw).not.toContain("PLAIN_REFRESH");
    expect(rows[0]).toMatchObject({ generation: 1, version: 1 });
  });

  it("再ログインは資格を上書きし、世代が進む", async () => {
    const gh = new FakeGitHubFetch();
    const stub = await installFakeGitHub(newUserId(), gh); // 1 回目
    await stub.saveCredential(gh.issue());
    const [row] = await sql<{ generation: number }>(
      stub,
      "SELECT generation FROM github_credential",
    );
    expect(row?.generation).toBe(2);
  });

  it("再ログインで team 所属のキャッシュは捨てられる", async () => {
    const gh = new FakeGitHubFetch();
    const stub = await installFakeGitHub(newUserId(), gh);
    expect(await stub.ensureMember(1)).toEqual({ ok: true });
    gh.team = "none";
    await stub.saveCredential(gh.issue());
    expect(await stub.ensureMember(1)).toMatchObject({ ok: false, code: "forbidden" });
  });
});

describe("UserDO.ensureMember", () => {
  it("active なら ok。結果は TTL 内ならキャッシュされ GitHub を呼ばない", async () => {
    const gh = new FakeGitHubFetch();
    const stub = await installFakeGitHub(newUserId(), gh);
    expect(await stub.ensureMember(1)).toEqual({ ok: true });
    const calls = gh.calls.length;
    expect(await stub.ensureMember(1)).toEqual({ ok: true });
    expect(gh.calls.length).toBe(calls);
  });

  it.each(["pending", "none"] as const)("team の状態が %s なら forbidden", async (state) => {
    const gh = new FakeGitHubFetch();
    gh.team = state;
    const stub = await installFakeGitHub(newUserId(), gh);
    expect(await stub.ensureMember(1)).toMatchObject({ ok: false, code: "forbidden" });
  });

  it("ログイン後に team から外されたら、TTL が切れた後の呼び出しで拒否される", async () => {
    const gh = new FakeGitHubFetch();
    const c = clock();
    const stub = await installFakeGitHub(newUserId(), gh, { now: c.now });
    expect(await stub.ensureMember(1)).toEqual({ ok: true });
    gh.team = "none";
    c.advance(MEMBERSHIP_CACHE_TTL_MS - 1000);
    expect(await stub.ensureMember(1)).toEqual({ ok: true }); // まだキャッシュ内（最大 5 分の遅れ）
    c.advance(2000);
    expect(await stub.ensureMember(1)).toMatchObject({ ok: false, code: "forbidden" });
  });

  it("拒否の結果も TTL 内はキャッシュされ、TTL 後に再確認する", async () => {
    const gh = new FakeGitHubFetch();
    gh.team = "none";
    const c = clock();
    const stub = await installFakeGitHub(newUserId(), gh, { now: c.now });
    await stub.ensureMember(1);
    const n = gh.calls.length;
    await stub.ensureMember(1);
    expect(gh.calls.length).toBe(n);
    gh.team = "active";
    c.advance(MEMBERSHIP_CACHE_TTL_MS + 1);
    expect(await stub.ensureMember(1)).toEqual({ ok: true });
  });

  it("同時の呼び出しは 1 回の確認を共有する", async () => {
    const gh = new FakeGitHubFetch();
    const stub = await installFakeGitHub(newUserId(), gh);
    const rs = await Promise.all(Array.from({ length: 5 }, () => stub.ensureMember(1)));
    expect(rs.every((r) => r.ok)).toBe(true);
    expect(gh.count("/user")).toBe(1);
  });

  it("資格が別人のもの（user id 不一致）なら forbidden", async () => {
    const gh = new FakeGitHubFetch();
    const stub = await installFakeGitHub(newUserId(), gh);
    expect(await stub.ensureMember(999)).toMatchObject({ ok: false, code: "forbidden" });
  });

  it.each([
    [500, "upstream_unavailable"],
    [429, "upstream_unavailable"],
    [403, "forbidden"],
  ])("GitHub が %s なら %s（fail-closed。失敗はキャッシュしない）", async (status, code) => {
    const gh = new FakeGitHubFetch();
    const stub = await installFakeGitHub(newUserId(), gh);
    gh.apiFault = status;
    expect(await stub.ensureMember(1)).toMatchObject({ ok: false, code });
    gh.apiFault = null;
    expect(await stub.ensureMember(1)).toEqual({ ok: true }); // 失敗後に復旧すれば通る
  });

  it("資格が無ければ reauth_required", async () => {
    const gh = new FakeGitHubFetch();
    const stub = await installFakeGitHub(newUserId(), gh, { login: false });
    expect(await stub.ensureMember(1)).toMatchObject({ ok: false, code: "reauth_required" });
  });

  it("access token の期限切れ: refresh token が有効なら自動でリフレッシュして成功する", async () => {
    const gh = new FakeGitHubFetch();
    const c = clock();
    const stub = await installFakeGitHub(newUserId(), gh, { now: c.now });
    c.advance(9 * 3600_000);
    expect(await stub.ensureMember(1)).toEqual({ ok: true });
    expect(gh.calls.filter((x) => x.path === "/login/oauth/access_token")).toHaveLength(1);
  });

  it("GitHub が 401 を返したら 1 回だけ強制リフレッシュして再試行する（旧トークンは使われない）", async () => {
    const gh = new FakeGitHubFetch();
    const stub = await installFakeGitHub(newUserId(), gh);
    gh.validTokens.clear(); // 手元の期限は未来だが GitHub 側では失効
    expect(await stub.ensureMember(1)).toEqual({ ok: true });
    expect(gh.count("/login/oauth/access_token")).toBe(1);
  });

  it("refresh token も無効なら reauth_required。資格は消える", async () => {
    const gh = new FakeGitHubFetch();
    const stub = await installFakeGitHub(newUserId(), gh);
    gh.validTokens.clear();
    gh.refreshTokens.clear();
    expect(await stub.ensureMember(1)).toMatchObject({ ok: false, code: "reauth_required" });
    const [row] = await sql<{ access_token_enc: string | null }>(
      stub,
      "SELECT access_token_enc FROM github_credential",
    );
    expect(row?.access_token_enc).toBeNull();
    expect(await stub.ensureMember(1)).toMatchObject({ ok: false, code: "reauth_required" });
  });

  it("リフレッシュ時に GitHub が 5xx なら資格を残して upstream_unavailable", async () => {
    const gh = new FakeGitHubFetch();
    const c = clock();
    const stub = await installFakeGitHub(newUserId(), gh, { now: c.now });
    c.advance(9 * 3600_000);
    gh.tokenFault = 503;
    expect(await stub.ensureMember(1)).toMatchObject({ ok: false, code: "upstream_unavailable" });
    gh.tokenFault = null;
    expect(await stub.ensureMember(1)).toEqual({ ok: true });
  });

  it("同時に呼んでもリフレッシュは 1 回（single-flight）", async () => {
    const gh = new FakeGitHubFetch();
    const c = clock();
    const stub = await installFakeGitHub(newUserId(), gh, { now: c.now });
    c.advance(9 * 3600_000);
    // ensureMember 自体も共有されるので、キャッシュの無い authorizeStart も混ぜて並列に呼ぶ
    await Promise.all([
      stub.ensureMember(1),
      stub.authorizeStart(1, "acme/widgets"),
      stub.authorizeStart(1, "acme/widgets"),
    ]);
    expect(gh.count("/login/oauth/access_token")).toBe(1);
  });

  it("設定が足りない（ENC 鍵など）場合は internal を返し、詳細を漏らさない", async () => {
    const gh = new FakeGitHubFetch();
    const stub = await installFakeGitHub(newUserId(), gh);
    await runInDurableObject(stub, (instance) => {
      const i = instance as unknown as { env: Record<string, unknown>; credentials: null };
      // team だけ（org なし）は設定の誤り
      i.env = { ...i.env, ALLOWED_ORG: "" };
      i.credentials = null;
    });
    const r = await stub.ensureMember(1);
    expect(r).toEqual({ ok: false, code: "internal", message: "internal error" });
  });
});

describe("UserDO.ensureMember: 再ログインとの競合", () => {
  it("再ログイン前に始まった確認の古い denied は、キャッシュにも呼び出し元にも使われない", async () => {
    const gh = new FakeGitHubFetch();
    gh.team = "none";
    const stub = await installFakeGitHub(newUserId(), gh);

    // 最初の team 確認だけ、応答を作ったあと解放まで保留する
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    let isHeld = false;
    const held = () => {
      isHeld = true;
    };
    let first = true;
    await runInDurableObject(stub, (instance: UserDO) => {
      instance.githubFetch = async (input, init) => {
        const res = await gh.fetch(input, init);
        if (first && new URL(new Request(input, init).url).pathname.includes("/memberships/")) {
          first = false;
          held();
          await gate;
        }
        return res;
      };
    });

    const old = stub.ensureMember(1); // 旧資格 + denied の応答が保留される
    await waitUntil(() => isHeld);
    gh.team = "active"; // team に追加された
    await stub.saveCredential(gh.issue()); // 再ログイン成功
    release(); // 旧 denied の応答が到着
    expect(await old).toEqual({ ok: true }); // 古い結果は捨てられ、新しい資格で確認し直される
    const rows = await sql<{ result: string }>(stub, "SELECT result FROM membership_cache");
    expect(rows.map((r) => r.result)).toEqual(["active"]);
    expect(await stub.ensureMember(1)).toEqual({ ok: true });
  });

  it("再ログイン後の呼び出しは、旧世代の進行中の確認に合流しない", async () => {
    const gh = new FakeGitHubFetch();
    gh.team = "none";
    const stub = await installFakeGitHub(newUserId(), gh);
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    let isHeld = false;
    const held = () => {
      isHeld = true;
    };
    let first = true;
    await runInDurableObject(stub, (instance: UserDO) => {
      instance.githubFetch = async (input, init) => {
        const res = await gh.fetch(input, init);
        if (first && new URL(new Request(input, init).url).pathname.includes("/memberships/")) {
          first = false;
          held();
          await gate;
        }
        return res;
      };
    });
    const old = stub.ensureMember(1);
    await waitUntil(() => isHeld);
    gh.team = "active";
    await stub.saveCredential(gh.issue());
    // 旧応答がまだ保留中でも、再ログイン後の呼び出しは新しい確認で ok になる
    expect(await stub.ensureMember(1)).toEqual({ ok: true });
    release();
    expect(await old).toEqual({ ok: true });
  });

  it("キャッシュ済みでも、確認済みと別の githubUserId の問い合わせは拒否される", async () => {
    const gh = new FakeGitHubFetch();
    const stub = await installFakeGitHub(newUserId(), gh);
    expect(await stub.ensureMember(1)).toEqual({ ok: true });
    expect(await stub.ensureMember(999)).toMatchObject({ ok: false, code: "forbidden" });
    expect(await stub.ensureMember(1)).toEqual({ ok: true });
  });

  it("並列の呼び出しでも、githubUserId が一致しないものは進行中の確認に相乗りできず拒否される", async () => {
    const gh = new FakeGitHubFetch();
    const stub = await installFakeGitHub(newUserId(), gh);
    const [a, b, c] = await Promise.all([
      stub.ensureMember(999),
      stub.ensureMember(1),
      stub.ensureMember(999),
    ]);
    expect(a).toMatchObject({ ok: false, code: "forbidden" });
    expect(b).toEqual({ ok: true });
    expect(c).toMatchObject({ ok: false, code: "forbidden" });
  });
});

describe("UserDO: 本番での GitHub URL 上書きの拒否", () => {
  it("ENVIRONMENT=production で URL を上書きすると、トークン付きの外部リクエストを送らずに失敗する", async () => {
    const gh = new FakeGitHubFetch();
    const stub = await installFakeGitHub(newUserId(), gh);
    const urls: string[] = [];
    await runInDurableObject(stub, (instance: UserDO) => {
      instance.githubFetch = async (input, init) => {
        urls.push(new Request(input, init).url);
        return gh.fetch(input, init);
      };
      const i = instance as unknown as {
        env: Record<string, unknown>;
        credentials: null;
        githubClientInstance: null;
      };
      i.env = {
        ...i.env,
        ENVIRONMENT: "production",
        GITHUB_API_BASE: "https://attacker.example/api",
        GITHUB_OAUTH_BASE: "https://attacker.example",
      };
      i.credentials = null;
      i.githubClientInstance = null;
    });
    const member = await stub.ensureMember(1);
    expect(member).toEqual({ ok: false, code: "internal", message: "internal error" });
    const start = await stub.authorizeStart(1, "acme/widgets");
    expect(start).toMatchObject({ ok: false, code: "internal" });
    expect(urls).toEqual([]);
  });
});

describe("UserDO.authorizeStart", () => {
  it("push 権限のある導入済みリポジトリなら repositoryId / installationId を返す", async () => {
    const gh = new FakeGitHubFetch();
    const stub = await installFakeGitHub(newUserId(), gh);
    expect(await stub.authorizeStart(1, "acme/widgets")).toEqual({
      ok: true,
      repositoryId: 4242,
      installationId: 77,
    });
  });

  it("公開リポジトリでも App が未導入（一覧に無い）なら forbidden", async () => {
    const gh = new FakeGitHubFetch();
    const stub = await installFakeGitHub(newUserId(), gh);
    expect(await stub.authorizeStart(1, "other/public")).toMatchObject({
      ok: false,
      code: "forbidden",
    });
  });

  it("push 権限が無ければ forbidden", async () => {
    const gh = new FakeGitHubFetch();
    gh.repos = [{ id: 1, full_name: "acme/ro", push: false }];
    const stub = await installFakeGitHub(newUserId(), gh);
    expect(await stub.authorizeStart(1, "acme/ro")).toMatchObject({ ok: false, code: "forbidden" });
  });

  it("team 非所属なら Installation の確認まで進まない", async () => {
    const gh = new FakeGitHubFetch();
    gh.team = "none";
    const stub = await installFakeGitHub(newUserId(), gh);
    expect(await stub.authorizeStart(1, "acme/widgets")).toMatchObject({
      ok: false,
      code: "forbidden",
    });
    expect(gh.count("/user/installations")).toBe(0);
  });

  it("返り値にトークンが含まれない", async () => {
    const gh = new FakeGitHubFetch();
    const stub = await installFakeGitHub(newUserId(), gh);
    const r = JSON.stringify(await stub.authorizeStart(1, "acme/widgets"));
    expect(r).not.toMatch(/ghu_|ghr_/);
  });
});

describe("経過時間の確認", () => {
  it("5 分は MEMBERSHIP_CACHE_TTL_MS", () => {
    expect(MEMBERSHIP_CACHE_TTL_MS).toBe(5 * MIN);
  });
});

/**
 * DO インスタンスの env を一時的に差し替えて fn を実行し、必ず元に戻す（finally）。
 * 差し替えたら資格のキャッシュ（credentials）も作り直させる。
 */
async function withEnv<T>(
  stub: Awaited<ReturnType<typeof installFakeGitHub>>,
  over: Record<string, string>,
  fn: () => Promise<T>,
): Promise<T> {
  type Inst = { env: Record<string, unknown>; credentials: unknown; githubClientInstance: unknown };
  const original = await runInDurableObject(stub, (instance) => {
    const i = instance as unknown as Inst;
    const saved = i.env;
    i.env = { ...i.env, ...over };
    i.credentials = null;
    i.githubClientInstance = null;
    return saved;
  });
  try {
    return await fn();
  } finally {
    await runInDurableObject(stub, (instance) => {
      const i = instance as unknown as Inst;
      i.env = original;
      i.credentials = null;
      i.githubClientInstance = null;
    });
  }
}

const NO_TEAM = { ALLOWED_ORG: "", ALLOWED_TEAM: "" };

describe("UserDO.ensureMember: ALLOWED_USER_IDS（数値の user ID の許可リスト）", () => {
  it("ID が一致すれば active。team の確認は呼ばない（GET /user は呼ぶ）", async () => {
    const gh = new FakeGitHubFetch();
    gh.team = "none";
    const stub = await installFakeGitHub(newUserId(), gh);
    await withEnv(stub, { ...NO_TEAM, ALLOWED_USER_IDS: "7,1" }, async () => {
      expect(await stub.ensureMember(1)).toEqual({ ok: true });
    });
    expect(gh.count("/user")).toBe(1);
    expect(gh.calls.some((c) => c.path.includes("/memberships/"))).toBe(false);
  });

  it("org/team のメンバーでも、ID のルールで通れば team の確認は呼ばない", async () => {
    const gh = new FakeGitHubFetch();
    const stub = await installFakeGitHub(newUserId(), gh);
    await withEnv(stub, { ALLOWED_USER_IDS: "1" }, async () => {
      expect(await stub.ensureMember(1)).toEqual({ ok: true });
    });
    expect(gh.calls.some((c) => c.path.includes("/memberships/"))).toBe(false);
  });

  it("ID が無く、org/team も無ければ denied（forbidden）", async () => {
    const gh = new FakeGitHubFetch();
    const stub = await installFakeGitHub(newUserId(), gh);
    await withEnv(stub, { ...NO_TEAM, ALLOWED_USER_IDS: "7,8" }, async () => {
      expect(await stub.ensureMember(1)).toMatchObject({ ok: false, code: "forbidden" });
    });
    expect(gh.calls.some((c) => c.path.includes("/memberships/"))).toBe(false);
  });

  it("ID が無くても、org/team の active メンバーなら active", async () => {
    const gh = new FakeGitHubFetch();
    const stub = await installFakeGitHub(newUserId(), gh);
    await withEnv(stub, { ALLOWED_USER_IDS: "7,8" }, async () => {
      expect(await stub.ensureMember(1)).toEqual({ ok: true });
    });
    expect(gh.calls.some((c) => c.path.includes("/memberships/"))).toBe(true);
  });

  it("ID が無く、team にも居なければ denied（応答は team に無い場合と同じ）", async () => {
    const gh = new FakeGitHubFetch();
    gh.team = "none";
    const stub = await installFakeGitHub(newUserId(), gh);
    await withEnv(stub, { ALLOWED_USER_IDS: "7,8" }, async () => {
      expect(await stub.ensureMember(1)).toEqual({
        ok: false,
        code: "forbidden",
        message: "not an active member of the required team",
      });
    });
  });

  it("トークンの user と利用者が違えば、リストに載っていても mismatch で拒否する", async () => {
    const gh = new FakeGitHubFetch(); // トークンの持ち主は id=1
    const stub = await installFakeGitHub(newUserId(), gh);
    await withEnv(stub, { ...NO_TEAM, ALLOWED_USER_IDS: "1,999" }, async () => {
      // 利用者(999)はリストにあるが、トークンは id=1 のもの
      expect(await stub.ensureMember(999)).toMatchObject({ ok: false, code: "forbidden" });
    });
    expect(gh.count("/user")).toBe(1);
  });

  it("ID の判定は、引数ではなく GET /user で取得した id で行う", async () => {
    const gh = new FakeGitHubFetch();
    gh.user = { id: 55, login: "mallory" };
    const stub = await installFakeGitHub(newUserId(), gh);
    // 引数 1 だけがリストにある。トークンの持ち主は 55
    await withEnv(stub, { ...NO_TEAM, ALLOWED_USER_IDS: "1" }, async () => {
      expect(await stub.ensureMember(1)).toMatchObject({ ok: false, code: "forbidden" });
    });
  });

  it.each([
    ["ID が不正（空要素）", { ...NO_TEAM, ALLOWED_USER_IDS: "1,,2" }],
    ["ID が不正（重複）", { ...NO_TEAM, ALLOWED_USER_IDS: "1,1" }],
    ["team だけ + 一致する ID", { ALLOWED_ORG: "", ALLOWED_USER_IDS: "1" }],
    ["org/team も ID も無い", { ...NO_TEAM, ALLOWED_USER_IDS: "" }],
    ["org/team は完全だが ID が不正", { ALLOWED_USER_IDS: "1,x" }],
  ])("設定が不正なら internal で拒否（%s）", async (_name, over) => {
    const gh = new FakeGitHubFetch();
    const stub = await installFakeGitHub(newUserId(), gh);
    await withEnv(stub, over, async () => {
      expect(await stub.ensureMember(1)).toEqual({
        ok: false,
        code: "internal",
        message: "internal error",
      });
    });
  });

  it("env から ID を外しても、TTL が切れるまでは active のまま。TTL 後に拒否される", async () => {
    const gh = new FakeGitHubFetch();
    gh.team = "none";
    const c = clock();
    const stub = await installFakeGitHub(newUserId(), gh, { now: c.now });
    await withEnv(stub, { ALLOWED_USER_IDS: "1" }, async () => {
      expect(await stub.ensureMember(1)).toEqual({ ok: true });
    });
    await withEnv(stub, { ALLOWED_USER_IDS: "2" }, async () => {
      expect(await stub.ensureMember(1)).toEqual({ ok: true }); // キャッシュ内
      c.advance(MEMBERSHIP_CACHE_TTL_MS + 1);
      expect(await stub.ensureMember(1)).toMatchObject({ ok: false, code: "forbidden" });
    });
  });

  it("withEnv は env を必ず元に戻す（例外でも）", async () => {
    const gh = new FakeGitHubFetch();
    const stub = await installFakeGitHub(newUserId(), gh);
    await expect(
      withEnv(stub, { ALLOWED_USER_IDS: "9" }, async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    const restored = await runInDurableObject(
      stub,
      (i) => (i as unknown as { env: Record<string, string> }).env.ALLOWED_USER_IDS,
    );
    expect(restored ?? "").toBe("");
    expect(await stub.ensureMember(1)).toEqual({ ok: true }); // 元の org/team の構成で動く
  });
});

describe("UserDO.ensureMember: org だけの許可ルール（org の active メンバー全員）", () => {
  const ORG_ONLY = { ALLOWED_ORG: "acme", ALLOWED_TEAM: "" };
  const memberships = (gh: FakeGitHubFetch, kind: "org" | "team") =>
    gh.calls.filter((c) =>
      kind === "org"
        ? c.path === "/user/memberships/orgs/acme"
        : c.path.startsWith("/orgs/acme/teams/"),
    ).length;

  it("org の active メンバーは active。team の確認は呼ばない", async () => {
    const gh = new FakeGitHubFetch();
    gh.org = "active";
    gh.team = "none"; // team には居ない
    const stub = await installFakeGitHub(newUserId(), gh);
    await withEnv(stub, ORG_ONLY, async () => {
      expect(await stub.ensureMember(1)).toEqual({ ok: true });
    });
    expect(memberships(gh, "org")).toBe(1);
    expect(memberships(gh, "team")).toBe(0);
  });

  it("team の指定があれば従来どおり team を確認する（org の確認は呼ばない）", async () => {
    const gh = new FakeGitHubFetch();
    gh.org = "none";
    gh.team = "active";
    const stub = await installFakeGitHub(newUserId(), gh);
    expect(await stub.ensureMember(1)).toEqual({ ok: true });
    expect(memberships(gh, "team")).toBe(1);
    expect(memberships(gh, "org")).toBe(0);
  });

  it.each(["pending", "none"] as const)("org が %s なら denied", async (state) => {
    const gh = new FakeGitHubFetch();
    gh.org = state;
    const stub = await installFakeGitHub(newUserId(), gh);
    await withEnv(stub, ORG_ONLY, async () => {
      expect(await stub.ensureMember(1)).toMatchObject({ ok: false, code: "forbidden" });
    });
  });

  it("403（App に権限が無い・org が App を制限）は所属なしとして黙らず、forbidden で拒否", async () => {
    const gh = new FakeGitHubFetch();
    gh.org = "forbidden";
    const stub = await installFakeGitHub(newUserId(), gh);
    await withEnv(stub, ORG_ONLY, async () => {
      expect(await stub.ensureMember(1)).toMatchObject({ ok: false, code: "forbidden" });
    });
    // 403 は結果をキャッシュしない（権限を直したらすぐ通る）
    gh.org = "active";
    await withEnv(stub, ORG_ONLY, async () => {
      expect(await stub.ensureMember(1)).toEqual({ ok: true });
    });
  });

  it("5xx は upstream_unavailable（拒否だが所属なしとは区別）", async () => {
    const gh = new FakeGitHubFetch();
    gh.apiFault = 500;
    const stub = await installFakeGitHub(newUserId(), gh);
    await withEnv(stub, ORG_ONLY, async () => {
      expect(await stub.ensureMember(1)).toMatchObject({ ok: false, code: "upstream_unavailable" });
    });
  });

  it("org が active でなくても、ID のルールで通れば active（OR）。org の確認は呼ばない", async () => {
    const gh = new FakeGitHubFetch();
    gh.org = "none";
    const stub = await installFakeGitHub(newUserId(), gh);
    await withEnv(stub, { ...ORG_ONLY, ALLOWED_USER_IDS: "1" }, async () => {
      expect(await stub.ensureMember(1)).toEqual({ ok: true });
    });
    expect(memberships(gh, "org")).toBe(0);
  });

  it("team だけ（org なし）は org の確認に落ちず、internal で拒否する", async () => {
    const gh = new FakeGitHubFetch();
    gh.org = "active";
    const stub = await installFakeGitHub(newUserId(), gh);
    await withEnv(stub, { ALLOWED_ORG: "", ALLOWED_TEAM: "core" }, async () => {
      expect(await stub.ensureMember(1)).toMatchObject({ ok: false, code: "internal" });
    });
    expect(memberships(gh, "org")).toBe(0);
  });
});
