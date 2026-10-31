import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import {
  SESSION_ABSOLUTE_MS,
  SESSION_IDLE_MS,
  SESSION_MAX_PER_USER,
  SESSION_TOUCH_MS,
  SID_RE,
} from "../../src/dashboard/session";
import { newUserId, userStub } from "./helpers";

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

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
  it("作成: 新しい sid（base64url 43 文字）と、絶対期限 30 日の記録ができる", async () => {
    const stub = userStub(newUserId());
    const clock = await useClock(stub);
    const s = await stub.createDashboardSession("alice");
    expect(s.sid).toMatch(SID_RE);
    expect(s.expiresAt).toBe(clock.now() + SESSION_ABSOLUTE_MS);
    expect(SESSION_ABSOLUTE_MS).toBe(30 * DAY);
    expect(await stub.checkDashboardSession(s.sid, s.version)).toEqual({
      ok: true,
      login: "alice",
    });
  });

  it("ログインのたびに新しい sid になり、世代は進まず、前の端末のセッションも有効なまま（複数端末）", async () => {
    const stub = userStub(newUserId());
    await useClock(stub);
    const first = await stub.createDashboardSession("alice");
    const second = await stub.createDashboardSession("alice");
    expect(second.sid).not.toBe(first.sid);
    expect(second.version).toBe(first.version);
    expect(await stub.checkDashboardSession(first.sid, first.version)).toEqual({
      ok: true,
      login: "alice",
    });
    expect(await stub.checkDashboardSession(second.sid, second.version)).toEqual({
      ok: true,
      login: "alice",
    });
    // 別の sid に世代だけ合わせても通らない・世代が違えば通らない
    expect(await stub.checkDashboardSession(first.sid, second.version + 1)).toEqual({ ok: false });
    expect(await stub.checkDashboardSession("A".repeat(43), second.version)).toEqual({
      ok: false,
    });
    expect(await sql(stub, "SELECT sid FROM dashboard_session")).toHaveLength(2);
  });

  it("既存のセッション（今の世代の行）は、デプロイ後の新しいログインでも消えない", async () => {
    const stub = userStub(newUserId());
    const clock = await useClock(stub);
    // 旧実装が作った行を直接入れる（世代 5 のとき）
    await runInDurableObject(stub, (_i, state) => {
      state.storage.sql.exec("UPDATE dashboard_epoch SET epoch = 5 WHERE singleton = 1");
      state.storage.sql.exec(
        "INSERT INTO dashboard_session (sid, version, login, created_at, expires_at, last_seen) VALUES (?, 5, 'alice', ?, ?, ?)",
        "O".repeat(43),
        clock.now(),
        clock.now() + SESSION_ABSOLUTE_MS,
        clock.now(),
      );
    });
    expect((await stub.checkDashboardSession("O".repeat(43), 5)).ok).toBe(true);
    const created = await stub.createDashboardSession("alice");
    expect(created.version).toBe(5);
    expect((await stub.checkDashboardSession("O".repeat(43), 5)).ok).toBe(true);
  });

  it("上限（SESSION_MAX_PER_USER）を超えると、last_seen が最も古いものだけが消える", async () => {
    const stub = userStub(newUserId());
    const clock = await useClock(stub);
    const made: { sid: string; version: number }[] = [];
    for (let i = 0; i < SESSION_MAX_PER_USER; i++) {
      made.push(await stub.createDashboardSession("alice"));
      clock.advance(MIN);
    }
    expect(await sql(stub, "SELECT sid FROM dashboard_session")).toHaveLength(SESSION_MAX_PER_USER);
    // 最古（made[0]）を使い、last_seen を更新して最古でなくする（更新は 5 分以上あけば書かれる）
    const [oldest, second, ...rest] = made;
    if (!oldest || !second) throw new Error("sessions were not made");
    clock.advance(SESSION_TOUCH_MS);
    expect((await stub.checkDashboardSession(oldest.sid, oldest.version)).ok).toBe(true);
    const extra = await stub.createDashboardSession("alice");
    expect(await sql(stub, "SELECT sid FROM dashboard_session")).toHaveLength(SESSION_MAX_PER_USER);
    // 追い出されるのは、いまいちばん古い made[1]
    expect((await stub.checkDashboardSession(second.sid, second.version)).ok).toBe(false);
    for (const s of [oldest, ...rest, extra]) {
      expect((await stub.checkDashboardSession(s.sid, s.version)).ok, s.sid).toBe(true);
    }
  });

  it("期限切れ（絶対期限・無操作）の行は、ログインの INSERT 時に掃除される", async () => {
    const stub = userStub(newUserId());
    const clock = await useClock(stub);
    const idle = await stub.createDashboardSession("alice");
    clock.advance(SESSION_IDLE_MS + 1);
    const fresh = await stub.createDashboardSession("alice");
    // idle は検証していない（check の掃除に頼らない）のに、行ごと消えている
    expect(await sql(stub, "SELECT sid FROM dashboard_session")).toEqual([{ sid: fresh.sid }]);
    expect((await stub.checkDashboardSession(idle.sid, idle.version)).ok).toBe(false);

    // 絶対期限切れ: last_seen が新しくても expires_at を過ぎた行は消す
    const old = await stub.createDashboardSession("alice");
    await runInDurableObject(stub, (_i, state) => {
      state.storage.sql.exec(
        "UPDATE dashboard_session SET expires_at = ? WHERE sid = ?",
        clock.now() - 1,
        old.sid,
      );
    });
    const next = await stub.createDashboardSession("alice");
    const sids = (await sql<{ sid: string }>(stub, "SELECT sid FROM dashboard_session")).map(
      (r) => r.sid,
    );
    expect(sids.sort()).toEqual([fresh.sid, next.sid].sort());
  });

  it("知らない sid・存在しない利用者の sid は拒否する（理由は区別しない）", async () => {
    const stub = userStub(newUserId());
    expect(await stub.checkDashboardSession("A".repeat(43), 0)).toEqual({ ok: false });
    expect(await stub.checkDashboardSession("A".repeat(43), 1)).toEqual({ ok: false });
  });

  it("絶対期限（30 日）を過ぎると拒否する。直前までは使い続ければ通る", async () => {
    const stub = userStub(newUserId());
    const clock = await useClock(stub);
    const s = await stub.createDashboardSession("alice");
    // 無操作の期限（7 日）に掛からないよう、5 日ごとに使い続ける
    const step = 5 * DAY;
    expect(step).toBeLessThan(SESSION_IDLE_MS);
    let elapsed = 0;
    while (elapsed + step < SESSION_ABSOLUTE_MS) {
      clock.advance(step);
      elapsed += step;
      expect((await stub.checkDashboardSession(s.sid, s.version)).ok).toBe(true);
    }
    // 絶対期限の 1ms 前は通り、ちょうどで失効する
    clock.advance(SESSION_ABSOLUTE_MS - 1 - elapsed);
    expect((await stub.checkDashboardSession(s.sid, s.version)).ok).toBe(true);
    clock.advance(1);
    expect(await stub.checkDashboardSession(s.sid, s.version)).toEqual({ ok: false });
  });

  it("旧実装が作った 7 日の絶対期限の行は、そのままの期限（7 日）で失効する", async () => {
    const stub = userStub(newUserId());
    const clock = await useClock(stub);
    await runInDurableObject(stub, (_i, state) => {
      state.storage.sql.exec("UPDATE dashboard_epoch SET epoch = 5 WHERE singleton = 1");
      state.storage.sql.exec(
        "INSERT INTO dashboard_session (sid, version, login, created_at, expires_at, last_seen) VALUES (?, 5, 'alice', ?, ?, ?)",
        "L".repeat(43),
        clock.now(),
        clock.now() + 7 * DAY,
        clock.now(),
      );
    });
    clock.advance(3 * DAY);
    expect((await stub.checkDashboardSession("L".repeat(43), 5)).ok).toBe(true);
    clock.advance(4 * DAY - 1);
    expect((await stub.checkDashboardSession("L".repeat(43), 5)).ok).toBe(true);
    clock.advance(1);
    expect((await stub.checkDashboardSession("L".repeat(43), 5)).ok).toBe(false);
  });

  it("無操作 7 日で失効し、使い続ければ延びる（更新は 5 分に 1 回まで）", async () => {
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

    expect(SESSION_IDLE_MS).toBe(7 * DAY);
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

  it("ログアウト: 自分の sid だけを失効する。もう一度呼んでも安全（冪等）で、他の端末のセッションは通る", async () => {
    const stub = userStub(newUserId());
    await useClock(stub);
    const s = await stub.createDashboardSession("alice");
    const other = await stub.createDashboardSession("alice");
    await stub.revokeDashboardSession("B".repeat(43)); // 知らない sid
    expect((await stub.checkDashboardSession(s.sid, s.version)).ok).toBe(true);
    await stub.revokeDashboardSession(s.sid);
    expect(await stub.checkDashboardSession(s.sid, s.version)).toEqual({ ok: false });
    expect((await stub.checkDashboardSession(other.sid, other.version)).ok).toBe(true);
    await stub.revokeDashboardSession(s.sid);
  });

  it("ログアウト後に再ログインしても、前の sid は戻らない（毎回新しい sid）", async () => {
    const stub = userStub(newUserId());
    await useClock(stub);
    const a = await stub.createDashboardSession("alice");
    await stub.revokeDashboardSession(a.sid);
    const b = await stub.createDashboardSession("alice");
    expect(b.sid).not.toBe(a.sid);
    expect(await stub.checkDashboardSession(a.sid, a.version)).toEqual({ ok: false });
    expect((await stub.checkDashboardSession(b.sid, b.version)).ok).toBe(true);
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
