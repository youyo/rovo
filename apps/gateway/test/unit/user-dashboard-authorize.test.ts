import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { MEMBERSHIP_CACHE_TTL_MS } from "../../src/tasks/user-do";
import { FakeGitHubFetch, installFakeGitHub } from "./fake-github-fetch";
import { newUserId } from "./helpers";

// セッションを使うたびに許可ルールを確かめ直す（M4 の verifier の指摘。M5a の完了条件）。

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
  const c = clock();
  const uid = newUserId();
  const gh = new FakeGitHubFetch();
  gh.user = { id: uid, login: "alice" };
  const stub = await installFakeGitHub(uid, gh, { now: c.now });
  const session = await stub.createDashboardSession("alice");
  return { c, uid, gh, stub, session };
}

async function patchEnv(stub: Awaited<ReturnType<typeof setup>>["stub"], over: object) {
  await runInDurableObject(stub, (i) => {
    const o = i as unknown as { env: Record<string, unknown> };
    o.env = { ...o.env, ...over };
  });
}

describe("authorizeDashboardSession（セッション + 許可ルールの確かめ直し）", () => {
  it("有効なセッションで、許可ルールを満たすなら ok（login を返す）", async () => {
    const { uid, stub, session } = await setup();
    expect(await stub.authorizeDashboardSession(uid, session.sid, session.version)).toEqual({
      ok: true,
      login: "alice",
    });
  });

  it("セッションが無効（知らない sid・世代違い）なら unauthenticated", async () => {
    const { uid, stub, session } = await setup();
    expect(await stub.authorizeDashboardSession(uid, "A".repeat(43), session.version)).toEqual({
      ok: false,
      kind: "unauthenticated",
    });
    expect(await stub.authorizeDashboardSession(uid, session.sid, session.version + 1)).toEqual({
      ok: false,
      kind: "unauthenticated",
    });
  });

  it("許可ルールが不正・未設定になったら、セッションが生きていても unauthenticated", async () => {
    const { uid, stub, session } = await setup();
    await patchEnv(stub, { ALLOWED_ORG: "", ALLOWED_TEAM: "", ALLOWED_USER_IDS: "" });
    expect(await stub.authorizeDashboardSession(uid, session.sid, session.version)).toEqual({
      ok: false,
      kind: "unauthenticated",
    });
  });

  it("team のキャッシュ（5 分）が切れたあとに team から外れていたら、セッションが生きていても unauthenticated", async () => {
    const { c, uid, gh, stub, session } = await setup();
    expect(await stub.authorizeDashboardSession(uid, session.sid, session.version)).toMatchObject({
      ok: true,
    });
    gh.team = "none";
    c.advance(MEMBERSHIP_CACHE_TTL_MS + 1000);
    expect(await stub.authorizeDashboardSession(uid, session.sid, session.version)).toEqual({
      ok: false,
      kind: "unauthenticated",
    });
    // 外れた利用者は、セッションの記録が残っていても読めない。戻れば（記録が生きていれば）また使える
    gh.team = "active";
    c.advance(MEMBERSHIP_CACHE_TTL_MS + 1000);
    expect(await stub.authorizeDashboardSession(uid, session.sid, session.version)).toMatchObject({
      ok: true,
    });
  });

  it("user ID のルールだけの構成で、ID が外れたら、team のキャッシュが残っていても即座に unauthenticated（GitHub を呼ばない）", async () => {
    const { uid, gh, stub, session } = await setup();
    await patchEnv(stub, { ALLOWED_ORG: "", ALLOWED_TEAM: "", ALLOWED_USER_IDS: String(uid) });
    expect(await stub.authorizeDashboardSession(uid, session.sid, session.version)).toMatchObject({
      ok: true,
    });
    const n = gh.calls.length;
    await patchEnv(stub, { ALLOWED_USER_IDS: String(uid + 1) });
    expect(await stub.authorizeDashboardSession(uid, session.sid, session.version)).toEqual({
      ok: false,
      kind: "unauthenticated",
    });
    expect(gh.calls.length).toBe(n);
  });

  it("user ID のルールに含まれていれば、GitHub を呼ばずに ok", async () => {
    const { uid, gh, stub, session } = await setup();
    await patchEnv(stub, { ALLOWED_USER_IDS: String(uid) });
    gh.team = "none"; // team には居ないが ID で許可される（OR）
    const n = gh.calls.length;
    expect(await stub.authorizeDashboardSession(uid, session.sid, session.version)).toMatchObject({
      ok: true,
    });
    expect(gh.calls.length).toBe(n);
  });

  it("team の確認が GitHub の障害で出来ないときは unavailable（通さない）。セッションは消さず、復旧すれば使える", async () => {
    const { c, uid, gh, stub, session } = await setup();
    c.advance(MEMBERSHIP_CACHE_TTL_MS + 1000); // キャッシュ切れ
    gh.apiFault = 500;
    expect(await stub.authorizeDashboardSession(uid, session.sid, session.version)).toEqual({
      ok: false,
      kind: "unavailable",
    });
    gh.apiFault = null;
    expect(await stub.authorizeDashboardSession(uid, session.sid, session.version)).toMatchObject({
      ok: true,
    });
  });

  it("資格が無い（失効した）team の利用者は unauthenticated", async () => {
    const uid = newUserId();
    const gh = new FakeGitHubFetch();
    gh.user = { id: uid, login: "alice" };
    const stub = await installFakeGitHub(uid, gh, { login: false });
    const session = await stub.createDashboardSession("alice");
    expect(await stub.authorizeDashboardSession(uid, session.sid, session.version)).toEqual({
      ok: false,
      kind: "unauthenticated",
    });
  });
});

describe("authorizeDashboardSession: uid の照合", () => {
  it("この DO の持ち主と違う uid で呼ぶと、許可ルールに通る id でも unauthenticated", async () => {
    const { uid, stub, session } = await setup();
    await patchEnv(stub, {
      ALLOWED_ORG: "",
      ALLOWED_TEAM: "",
      ALLOWED_USER_IDS: `${uid},${uid + 1}`,
    });
    expect(await stub.authorizeDashboardSession(uid + 1, session.sid, session.version)).toEqual({
      ok: false,
      kind: "unauthenticated",
    });
    expect(await stub.authorizeDashboardSession(uid, session.sid, session.version)).toMatchObject({
      ok: true,
    });
  });
});
