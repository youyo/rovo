import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import {
  SESSION_ABSOLUTE_MS,
  SESSION_IDLE_MS,
  SESSION_TOUCH_MS,
  SID_RE,
} from "../../src/dashboard/session";
import { newUserId, userStub } from "./helpers";

const MIN = 60_000;
const HOUR = 60 * MIN;

type UserStub = ReturnType<typeof userStub>;

async function useClock(stub: UserStub, start = Date.now()) {
  let t = start;
  await runInDurableObject(stub, (instance) => {
    (instance as unknown as { now: () => number }).now = () => t;
  });
  return {
    advance(ms: number) {
      t += ms;
    },
    now: () => t,
  };
}

function sql<T>(stub: UserStub, query: string, ...bindings: unknown[]): Promise<T[]> {
  return runInDurableObject(
    stub,
    (_i, state) => state.storage.sql.exec(query, ...bindings).toArray() as T[],
  );
}

describe("UserDO のダッシュボードのセッション（D3）", () => {
  it("作成: 新しい sid（base64url 43 文字）と、絶対期限 7 日の記録ができる", async () => {
    const stub = userStub(newUserId());
    const clock = await useClock(stub);
    const s = await stub.createDashboardSession("alice");
    expect(s.sid).toMatch(SID_RE);
    expect(s.expiresAt).toBe(clock.now() + SESSION_ABSOLUTE_MS);
    expect(await stub.checkDashboardSession(s.sid, s.version)).toEqual({
      ok: true,
      login: "alice",
    });
  });

  it("ログインのたびに新しい sid・新しい世代になり、古い sid は全部失効する（セッション固定の対策）", async () => {
    const stub = userStub(newUserId());
    await useClock(stub);
    const first = await stub.createDashboardSession("alice");
    const second = await stub.createDashboardSession("alice");
    expect(second.sid).not.toBe(first.sid);
    expect(second.version).toBeGreaterThan(first.version);
    expect(await stub.checkDashboardSession(first.sid, first.version)).toEqual({ ok: false });
    // 古い sid に新しい世代を組み合わせても通らない（記録が無い）
    expect(await stub.checkDashboardSession(first.sid, second.version)).toEqual({ ok: false });
    // 新しい sid に古い世代を組み合わせても通らない
    expect(await stub.checkDashboardSession(second.sid, first.version)).toEqual({ ok: false });
    expect(await stub.checkDashboardSession(second.sid, second.version)).toEqual({
      ok: true,
      login: "alice",
    });
    expect(await sql(stub, "SELECT sid FROM dashboard_session")).toHaveLength(1);
  });

  it("知らない sid・存在しない利用者の sid は拒否する（理由は区別しない）", async () => {
    const stub = userStub(newUserId());
    expect(await stub.checkDashboardSession("A".repeat(43), 0)).toEqual({ ok: false });
    expect(await stub.checkDashboardSession("A".repeat(43), 1)).toEqual({ ok: false });
  });

  it("絶対期限（7 日）を過ぎると拒否する", async () => {
    const stub = userStub(newUserId());
    const clock = await useClock(stub);
    const s = await stub.createDashboardSession("alice");
    // 無操作の期限に掛からないよう、4 時間ごとに使い続ける
    for (let i = 0; i < (7 * 24) / 4 - 1; i++) {
      clock.advance(4 * HOUR);
      expect((await stub.checkDashboardSession(s.sid, s.version)).ok).toBe(true);
    }
    clock.advance(4 * HOUR);
    expect(await stub.checkDashboardSession(s.sid, s.version)).toEqual({ ok: false });
  });

  it("無操作 8 時間で失効し、使い続ければ延びる（更新は 5 分に 1 回まで）", async () => {
    const stub = userStub(newUserId());
    const clock = await useClock(stub);
    const s = await stub.createDashboardSession("alice");
    const lastSeen = async () =>
      (await sql<{ last_seen: number }>(stub, "SELECT last_seen FROM dashboard_session"))[0]
        ?.last_seen;
    const t0 = await lastSeen();
    clock.advance(SESSION_TOUCH_MS - 1);
    expect((await stub.checkDashboardSession(s.sid, s.version)).ok).toBe(true);
    expect(await lastSeen()).toBe(t0); // 5 分未満は書かない
    clock.advance(1);
    expect((await stub.checkDashboardSession(s.sid, s.version)).ok).toBe(true);
    expect(await lastSeen()).toBe(clock.now());

    clock.advance(SESSION_IDLE_MS - 1);
    expect((await stub.checkDashboardSession(s.sid, s.version)).ok).toBe(true);
    clock.advance(SESSION_IDLE_MS);
    expect(await stub.checkDashboardSession(s.sid, s.version)).toEqual({ ok: false });
  });

  it("失効した（無操作で切れた）sid は、その後で時刻が戻っても復活しない", async () => {
    const stub = userStub(newUserId());
    const clock = await useClock(stub);
    const s = await stub.createDashboardSession("alice");
    clock.advance(SESSION_IDLE_MS + 1);
    expect((await stub.checkDashboardSession(s.sid, s.version)).ok).toBe(false);
    expect(await sql(stub, "SELECT sid FROM dashboard_session")).toHaveLength(0);
  });

  it("ログアウト: sid を失効する。もう一度呼んでも安全（冪等）で、別の sid には影響しない", async () => {
    const stub = userStub(newUserId());
    await useClock(stub);
    const s = await stub.createDashboardSession("alice");
    await stub.revokeDashboardSession("B".repeat(43)); // 知らない sid
    expect((await stub.checkDashboardSession(s.sid, s.version)).ok).toBe(true);
    await stub.revokeDashboardSession(s.sid);
    expect(await stub.checkDashboardSession(s.sid, s.version)).toEqual({ ok: false });
    await stub.revokeDashboardSession(s.sid);
  });

  it("ログアウトしても世代は戻らない（同じ世代の sid を作り直せない）", async () => {
    const stub = userStub(newUserId());
    await useClock(stub);
    const a = await stub.createDashboardSession("alice");
    await stub.revokeDashboardSession(a.sid);
    const b = await stub.createDashboardSession("alice");
    expect(b.version).toBeGreaterThan(a.version);
    expect(await stub.checkDashboardSession(a.sid, a.version)).toEqual({ ok: false });
  });

  it("世代は DO の再起動（メモリの消去）をまたいで残る。MCP の loginEpoch とは別", async () => {
    const stub = userStub(newUserId());
    await useClock(stub);
    const a = await stub.createDashboardSession("alice");
    // MCP 側の再ログイン（saveCredential）ではダッシュボードのセッションは落ちない
    await stub.saveCredential({
      accessToken: "ghu_x",
      refreshToken: "ghr_x",
      accessExpiresAt: Date.now() + 8 * HOUR,
      refreshExpiresAt: Date.now() + 100 * HOUR,
    });
    expect((await stub.checkDashboardSession(a.sid, a.version)).ok).toBe(true);
    const rows = await sql<{ epoch: number }>(stub, "SELECT epoch FROM dashboard_epoch");
    expect(rows[0]?.epoch).toBe(a.version);
  });

  it("DO のテーブルに GitHub のトークンは入らない（sid・世代・login・時刻だけ）", async () => {
    const stub = userStub(newUserId());
    await useClock(stub);
    await stub.createDashboardSession("alice");
    const cols = await sql<{ name: string }>(stub, "PRAGMA table_info(dashboard_session)");
    expect(cols.map((c) => c.name).sort()).toEqual(
      ["created_at", "expires_at", "last_seen", "login", "sid", "version"].sort(),
    );
  });

  it("alarm を呼んでもセッションを壊さない", async () => {
    const stub = userStub(newUserId());
    await useClock(stub);
    const s = await stub.createDashboardSession("alice");
    await runDurableObjectAlarm(stub);
    expect((await stub.checkDashboardSession(s.sid, s.version)).ok).toBe(true);
  });
});
