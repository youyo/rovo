import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { ConsultRequest } from "../../src/agent/contract";
import { ulid } from "../../src/tasks/ulid";
import {
  CONSULT_ANSWER_TTL_MS,
  CONSULT_BACKGROUND_TIMEOUT_MS,
  CONSULT_STALE_AFTER_MS,
  MAX_PENDING_CONSULTS,
} from "../../src/tasks/user-do";
import { MAX_CONCURRENT_WAITERS, WAIT_RETRY_AFTER_SECONDS } from "../../src/tasks/validation";
import { controllableAgent, okResult, tuneUserDo } from "../support/consult-agent";
import { FP, newUserId, userStub } from "./helpers";

type UserStub = ReturnType<typeof userStub>;

const MIN = 60 * 1000;
const T0 = Date.UTC(2026, 0, 15, 12);

async function setup(stub: UserStub, start = T0) {
  let t = start;
  await runInDurableObject(stub, (i) => {
    const u = i as unknown as { now: () => number; monthlyLimitUsd: () => number };
    u.now = () => t;
    u.monthlyLimitUsd = () => 100;
  });
  return {
    advance(ms: number) {
      t += ms;
    },
  };
}

function sql<T>(stub: UserStub, q: string, ...b: unknown[]): Promise<T[]> {
  return runInDurableObject(stub, (_i, s) => s.storage.sql.exec(q, ...b).toArray() as T[]);
}

const newId = (at = T0) => `consult-${ulid(at)}`;

function request(id: string, uid: number, over: Partial<ConsultRequest> = {}): ConsultRequest {
  return {
    consultId: id,
    userId: String(uid),
    model: "anthropic/claude-sonnet-5-5",
    messages: [{ role: "user", content: "How should I design the cache?" }],
    budgetUsd: 0.5,
    ...over,
  };
}

/** ユーザー・DO・偽 AgentDO・時計を用意し、consult を 1 件予約する。 */
async function fixture({ backgroundTimeoutMs }: { backgroundTimeoutMs?: number } = {}) {
  const uid = newUserId();
  const stub = userStub(uid);
  const clock = await setup(stub);
  const agent = controllableAgent();
  await tuneUserDo(stub, {
    agent: agent.factory,
    ...(backgroundTimeoutMs !== undefined ? { backgroundTimeoutMs } : {}),
  });
  const owner = { id: uid, login: "alice" };
  async function begin(id = newId()) {
    const reserved = await stub.reserveConsult(id, "anthropic/claude-sonnet-5-5", owner);
    if (!reserved.ok) throw new Error(`reserve failed: ${reserved.code}`);
    const started = await stub.startConsult(request(id, uid));
    return { id, started };
  }
  return { uid, stub, clock, agent, owner, begin };
}

describe("UserDO.startConsult（裏でモデルを呼ぶ）", () => {
  it("すぐ返る（モデルの答えを待たない）。pending の行ができ、予約は開いたまま", async () => {
    const f = await fixture();
    const { id, started } = await f.begin();
    expect(started).toEqual({ ok: true });
    // AgentDO は consult ごとのインスタンス名で呼ばれている（agent の契約は変えない）
    expect(f.agent.calls.map((c) => c.consultId)).toEqual([id]);
    expect(f.agent.names).toEqual([id]);
    expect(
      await sql(f.stub, "SELECT consult_id, owner_id, status, result_json FROM consult_answer"),
    ).toEqual([{ consult_id: id, owner_id: f.uid, status: "pending", result_json: null }]);
    expect(await f.stub.budgetStatus()).toMatchObject({ reserved_usd: 0.5, pending_consults: 1 });
  });

  it("予約が無い・形が不正・閉じた consult は始めない（AgentDO を呼ばない）", async () => {
    const f = await fixture();
    expect(await f.stub.startConsult(request(newId(), f.uid))).toEqual({
      ok: false,
      code: "not_found",
    });
    expect(await f.stub.startConsult(request("task-x", f.uid))).toEqual({
      ok: false,
      code: "invalid_input",
    });
    const id = newId();
    await f.stub.reserveConsult(id);
    await f.stub.settleConsult(id, 0.1);
    expect(await f.stub.startConsult(request(id, f.uid))).toEqual({ ok: false, code: "not_found" });
    expect(f.agent.calls).toHaveLength(0);
  });

  it("同じ consult の開始の再送は、モデルを二重に呼ばない", async () => {
    const f = await fixture();
    const { id } = await f.begin();
    expect(await f.stub.startConsult(request(id, f.uid))).toEqual({ ok: true });
    expect(f.agent.calls).toHaveLength(1);
  });
});

describe("UserDO: 裏の完了（答えの保存・精算・索引を同じ同期区間で）", () => {
  it("成功: 答えを保存し、実費で精算し、consult_log を確定する。保持は完了から 1 時間", async () => {
    const f = await fixture();
    const { id } = await f.begin();
    f.agent.release(
      id,
      okResult({
        text: "Use a write-through cache.",
        usage: { input: 1000, output: 200, cacheRead: 5000, cacheWrite: 300 },
        costUsd: 0.00555,
      }),
    );
    expect(await f.stub.waitConsult(id, f.uid, 5000)).toEqual({
      ok: true,
      status: "done",
      value: {
        text: "Use a write-through cache.",
        model: "anthropic/claude-sonnet-5-5",
        usage: { input: 1000, output: 200, cache_read: 5000, cache_write: 300 },
        cost_usd: 0.00555,
      },
    });
    expect(
      await sql(f.stub, "SELECT settled_micro, settled_estimated, closed FROM task_budget"),
    ).toEqual([{ settled_micro: 5550, settled_estimated: 0, closed: 1 }]);
    expect(
      await sql(f.stub, "SELECT settled, cost_micro, estimated, index_dirty FROM consult_log"),
    ).toEqual([{ settled: 1, cost_micro: 5550, estimated: 0, index_dirty: 1 }]);
    expect(
      await sql(f.stub, "SELECT status, started_at, finished_at, expires_at FROM consult_answer"),
    ).toEqual([
      { status: "done", started_at: T0, finished_at: T0, expires_at: T0 + CONSULT_ANSWER_TTL_MS },
    ]);
    expect(CONSULT_ANSWER_TTL_MS).toBe(60 * MIN);
    expect(await f.stub.budgetStatus()).toMatchObject({
      reserved_usd: 0,
      spent_usd: 0.00555,
      pending_consults: 0,
    });
    // consult_log（索引）に本文は入らない
    expect(JSON.stringify(await sql(f.stub, "SELECT * FROM consult_log"))).not.toContain(
      "write-through",
    );
  });

  it("クライアントが誰も待っていなくても（切断を模す）、完了すれば精算される", async () => {
    const f = await fixture();
    const { id } = await f.begin();
    // waitConsult を一度も呼ばない = consult のリクエストが先に切れた
    f.agent.release(id, okResult({ costUsd: 0.02 }));
    for (let i = 0; i < 100; i++) {
      const rows = await sql<{ closed: number }>(f.stub, "SELECT closed FROM task_budget");
      if (rows[0]?.closed === 1) break;
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(await f.stub.budgetStatus()).toMatchObject({ spent_usd: 0.02, reserved_usd: 0 });
    // 後から取りに来れば done
    expect(await f.stub.waitConsult(id, f.uid, 0)).toMatchObject({
      ok: true,
      status: "done",
      value: { cost_usd: 0.02 },
    });
  });

  it("モデルの失敗: かかった費用で精算し、failed を保存する（固定の文言・retry_after_seconds の規則は consult と同じ）", async () => {
    const f = await fixture();
    const a = await f.begin();
    f.agent.release(a.id, {
      ok: false,
      code: "model_error",
      message: "SECRET upstream text",
      costUsd: 0.0004,
    });
    const failed = await f.stub.waitConsult(a.id, f.uid, 5000);
    expect(failed).toEqual({
      ok: true,
      status: "failed",
      error: {
        code: "upstream_unavailable",
        message: "the model call failed; retry later",
        retry_after_seconds: 30,
      },
      cost_usd: 0.0004,
    });
    const b = await f.begin();
    f.agent.release(b.id, { ok: false, code: "model_rejected", message: "x", costUsd: 0 });
    const rejected = await f.stub.waitConsult(b.id, f.uid, 5000);
    expect(rejected).toMatchObject({
      ok: true,
      status: "failed",
      error: { code: "model_rejected" },
      cost_usd: 0,
    });
    if (!rejected.ok || rejected.status !== "failed") throw new Error("expected failed");
    expect(rejected.error.retry_after_seconds).toBeUndefined();
    expect(await f.stub.budgetStatus()).toMatchObject({ spent_usd: 0.0004, reserved_usd: 0 });
  });

  it("例外・壊れた応答は、実費不明として予約額で精算し（estimated）、failed にする", async () => {
    const f = await fixture();
    const a = await f.begin();
    f.agent.release(a.id, new Error("agent down"));
    expect(await f.stub.waitConsult(a.id, f.uid, 5000)).toEqual({
      ok: true,
      status: "failed",
      error: {
        code: "upstream_unavailable",
        message: "the consult is temporarily unavailable; retry later",
        retry_after_seconds: 30,
      },
      cost_usd: 0.5,
    });
    const b = await f.begin();
    f.agent.release(b.id, { nonsense: true } as never);
    expect(await f.stub.waitConsult(b.id, f.uid, 5000)).toMatchObject({
      status: "failed",
      error: { code: "internal", message: "internal error" },
    });
    expect(await f.stub.budgetStatus()).toMatchObject({
      spent_usd: 1,
      estimated_usd: 1,
      reserved_usd: 0,
    });
  });

  it("答えの保存と精算は同じ同期区間: 保存に失敗したら精算も巻き戻る（片方だけが残らない）", async () => {
    const f = await fixture();
    const { id } = await f.begin();
    await sql(
      f.stub,
      "CREATE TRIGGER fail_answer BEFORE UPDATE ON consult_answer BEGIN SELECT RAISE(ABORT, 'boom'); END",
    );
    f.agent.release(id, okResult({ costUsd: 0.02 }));
    await new Promise((r) => setTimeout(r, 50));
    expect(await sql(f.stub, "SELECT closed, settled_micro FROM task_budget")).toEqual([
      { closed: 0, settled_micro: 0 },
    ]);
    expect(await sql(f.stub, "SELECT status FROM consult_answer")).toEqual([{ status: "pending" }]);
    expect(await sql(f.stub, "SELECT settled FROM consult_log")).toEqual([{ settled: 0 }]);
  });

  it("答えが 1 行の上限（2MB 未満）を超えるなら、切り詰めず failed にする。費用は実費で精算する", async () => {
    const f = await fixture();
    const big = await f.begin();
    f.agent.release(big.id, okResult({ text: "x".repeat(2_100_000), costUsd: 0.03 }));
    expect(await f.stub.waitConsult(big.id, f.uid, 5000)).toMatchObject({
      ok: true,
      status: "failed",
      error: { code: "internal" },
      cost_usd: 0.03,
    });
    expect(await sql(f.stub, "SELECT length(result_json) AS n FROM consult_answer")).toSatisfy(
      (rows: { n: number }[]) => (rows[0]?.n ?? 0) < 2 * 1024 * 1024,
    );
    expect(await f.stub.budgetStatus()).toMatchObject({ spent_usd: 0.03, reserved_usd: 0 });
    // 上限の内側（1MB）はそのまま保存する
    const ok = await f.begin();
    f.agent.release(ok.id, okResult({ text: "y".repeat(1_000_000) }));
    const done = await f.stub.waitConsult(ok.id, f.uid, 5000);
    expect(done).toMatchObject({ ok: true, status: "done" });
    if (!done.ok || done.status !== "done") throw new Error("expected done");
    expect(done.value.text).toHaveLength(1_000_000);
  });
});

describe("UserDO.waitConsult", () => {
  it("答えを待っている呼び出しは、完了で起きる（待ち時間を使い切らない）", async () => {
    const f = await fixture();
    const { id } = await f.begin();
    const t0 = Date.now();
    const waiting = f.stub.waitConsult(id, f.uid, 20_000);
    await new Promise((r) => setTimeout(r, 50));
    f.agent.release(id);
    expect(await waiting).toMatchObject({ ok: true, status: "done" });
    expect(Date.now() - t0).toBeLessThan(10_000);
  });

  it("待ち時間が尽きたら pending（retry_after_seconds は付かない）。0 は待たずに今の状態を返す", async () => {
    const f = await fixture();
    const { id } = await f.begin();
    expect(await f.stub.waitConsult(id, f.uid, 30)).toEqual({ ok: true, status: "pending" });
    expect(await f.stub.waitConsult(id, f.uid, 0)).toEqual({ ok: true, status: "pending" });
  });

  it("done / failed は保持期間内なら何度でも同じ答え（冪等）。本文は消えない", async () => {
    const f = await fixture();
    const a = await f.begin();
    f.agent.release(a.id, okResult({ text: "again" }));
    const first = await f.stub.waitConsult(a.id, f.uid, 5000);
    expect(await f.stub.waitConsult(a.id, f.uid, 0)).toEqual(first);
    expect(await f.stub.waitConsult(a.id, f.uid, 0)).toEqual(first);
    const b = await f.begin();
    f.agent.release(b.id, new Error("x"));
    const failed = await f.stub.waitConsult(b.id, f.uid, 5000);
    expect(await f.stub.waitConsult(b.id, f.uid, 0)).toEqual(failed);
    // 取り直しても精算は 1 回だけ
    expect(await f.stub.budgetStatus()).toMatchObject({ spent_usd: 0.0012 + 0.5 });
  });

  it("discardConsult: 受け取れた答えの行を消す（50 秒以内に返した答えを UserDO に残さない）。pending・他人・無い行は消さない。waitConsult は消さない", async () => {
    const f = await fixture();
    const { id } = await f.begin();
    expect(await f.stub.discardConsult(id, f.uid)).toEqual({ ok: true, discarded: false });
    expect(await sql(f.stub, "SELECT status FROM consult_answer")).toEqual([{ status: "pending" }]);
    f.agent.release(id, okResult({ text: "SECRET-ANSWER" }));
    // 待っただけでは消えない（待っている間に呼び出し側が切れても、答えは取り直せる）
    expect(await f.stub.waitConsult(id, f.uid, 5000)).toMatchObject({
      ok: true,
      status: "done",
      value: { text: "SECRET-ANSWER" },
    });
    expect(await sql(f.stub, "SELECT status FROM consult_answer")).toEqual([{ status: "done" }]);
    // 他人の owner_id では消えない
    expect(await f.stub.discardConsult(id, f.uid + 1)).toEqual({ ok: true, discarded: false });
    expect(await sql(f.stub, "SELECT status FROM consult_answer")).toEqual([{ status: "done" }]);
    expect(await f.stub.discardConsult(id, f.uid)).toEqual({ ok: true, discarded: true });
    expect(await sql(f.stub, "SELECT * FROM consult_answer")).toEqual([]);
    expect(await f.stub.waitConsult(id, f.uid, 0)).toEqual({ ok: false, code: "not_found" });
    expect(await f.stub.discardConsult("consult-x", f.uid)).toEqual({ ok: true, discarded: false });
    // 精算は済んでいる
    expect(await f.stub.budgetStatus()).toMatchObject({ spent_usd: 0.0012, reserved_usd: 0 });
  });

  it("effort: 依頼の effort が答えに入って保存され、取り直しでも同じ。agent が返した effort を優先する", async () => {
    const f = await fixture();
    const id = newId();
    await f.stub.reserveConsult(id, "anthropic/claude-sonnet-5-5", f.owner);
    await f.stub.startConsult(request(id, f.uid, { effort: "high" }));
    f.agent.release(id, okResult({ effort: "low" }));
    const first = await f.stub.waitConsult(id, f.uid, 5000);
    expect(first).toMatchObject({ ok: true, status: "done", value: { effort: "low" } });
    expect(await f.stub.waitConsult(id, f.uid, 0)).toEqual(first);

    const id2 = newId();
    await f.stub.reserveConsult(id2, "anthropic/claude-sonnet-5-5", f.owner);
    await f.stub.startConsult(request(id2, f.uid, { effort: "high" }));
    f.agent.release(id2);
    expect(await f.stub.waitConsult(id2, f.uid, 5000)).toMatchObject({
      value: { effort: "high" },
    });
  });

  it("古い保存データ（effort の無い答え）も consult_result で読める（effort は付かない）", async () => {
    const f = await fixture();
    const { id } = await f.begin();
    f.agent.release(id);
    await f.stub.waitConsult(id, f.uid, 5000);
    const legacy = {
      text: "old answer",
      model: "anthropic/claude-sonnet-5-5",
      usage: { input: 1, output: 2, cache_read: 0, cache_write: 0 },
      cost_usd: 0.001,
    };
    await sql(
      f.stub,
      "UPDATE consult_answer SET result_json = ? WHERE consult_id = ?",
      JSON.stringify(legacy),
      id,
    );
    const r = await f.stub.waitConsult(id, f.uid, 0);
    expect(r).toEqual({ ok: true, status: "done", value: legacy });
  });

  it("保持期間（完了から 1 時間）の内は取れ、過ぎたら not_found になって行も消える", async () => {
    const f = await fixture();
    const { id } = await f.begin();
    f.agent.release(id);
    await f.stub.waitConsult(id, f.uid, 5000);
    f.clock.advance(CONSULT_ANSWER_TTL_MS - MIN);
    expect(await f.stub.waitConsult(id, f.uid, 0)).toMatchObject({ ok: true, status: "done" });
    f.clock.advance(2 * MIN);
    expect(await f.stub.waitConsult(id, f.uid, 0)).toEqual({ ok: false, code: "not_found" });
    expect(await sql(f.stub, "SELECT * FROM consult_answer")).toEqual([]);
  });

  it("保持期間を過ぎた行は、取りに来なくても alarm で消える", async () => {
    const f = await fixture();
    const { id } = await f.begin();
    f.agent.release(id);
    await f.stub.waitConsult(id, f.uid, 5000);
    f.clock.advance(CONSULT_ANSWER_TTL_MS + MIN);
    await runInDurableObject(f.stub, async (i) => {
      await (i as unknown as { alarm(): Promise<void> }).alarm();
    });
    expect(await sql(f.stub, "SELECT * FROM consult_answer")).toEqual([]);
  });

  it("他人の consult_id・存在しない・形が不正・owner_id が違う、は同じ not_found", async () => {
    const f = await fixture();
    const { id } = await f.begin();
    f.agent.release(id);
    await f.stub.waitConsult(id, f.uid, 5000);
    const other = userStub(newUserId());
    const results = [
      await other.waitConsult(id, 12345, 0), // 他人の UserDO には行が無い
      await f.stub.waitConsult(id, f.uid + 1, 0), // 自分の DO でも owner_id が違う
      await f.stub.waitConsult(newId(), f.uid, 0),
      await f.stub.waitConsult("consult-x", f.uid, 0),
      await f.stub.waitConsult("", f.uid, 0),
      await f.stub.waitConsult(ulid(), f.uid, 0),
      await f.stub.waitConsult(123 as never, f.uid, 0),
    ];
    for (const r of results) expect(r).toEqual({ ok: false, code: "not_found" });
  });

  it("同時に待てる数には上限がある（MAX_CONCURRENT_WAITERS）。超えた呼び出しは pending と retry_after_seconds", async () => {
    const f = await fixture();
    const { id } = await f.begin();
    const calls = Array.from({ length: MAX_CONCURRENT_WAITERS + 1 }, () =>
      f.stub.waitConsult(id, f.uid, 400),
    );
    const results = await Promise.all(calls);
    expect(results.every((r) => r.ok && r.status === "pending")).toBe(true);
    const limited = results.filter((r) => r.ok && r.status === "pending" && r.retry_after_seconds);
    expect(limited).toHaveLength(1);
    expect(limited[0]).toEqual({
      ok: true,
      status: "pending",
      retry_after_seconds: WAIT_RETRY_AFTER_SECONDS,
    });
  });
});

describe("UserDO: 裏の上限と期限", () => {
  it("定数: 裏の上限 5 分、期限はそれに余裕を足した 10 分", () => {
    expect(CONSULT_BACKGROUND_TIMEOUT_MS).toBe(5 * MIN);
    expect(CONSULT_STALE_AFTER_MS).toBe(10 * MIN);
    expect(CONSULT_STALE_AFTER_MS).toBeGreaterThan(CONSULT_BACKGROUND_TIMEOUT_MS);
  });

  it("裏の上限を超えて返らなければ、予約額で精算（estimated）して failed（upstream_unavailable）にする", async () => {
    const f = await fixture({ backgroundTimeoutMs: 40 });
    const { id } = await f.begin();
    expect(await f.stub.waitConsult(id, f.uid, 5000)).toEqual({
      ok: true,
      status: "failed",
      error: {
        code: "upstream_unavailable",
        message: "the consult is temporarily unavailable; retry later",
        retry_after_seconds: 30,
      },
      cost_usd: 0.5,
    });
    expect(await f.stub.budgetStatus()).toMatchObject({
      spent_usd: 0.5,
      estimated_usd: 0.5,
      reserved_usd: 0,
      pending_consults: 0,
    });
    // 後から返った答えは無視する（二重に数えない）
    f.agent.release(id, okResult({ costUsd: 0.1 }));
    await new Promise((r) => setTimeout(r, 50));
    expect(await f.stub.budgetStatus()).toMatchObject({ spent_usd: 0.5 });
    expect(await f.stub.waitConsult(id, f.uid, 0)).toMatchObject({ status: "failed" });
  });

  it("期限（10 分）は pending を早く閉じない: 5 分を過ぎても、9 分でも pending のまま", async () => {
    const f = await fixture();
    const { id } = await f.begin();
    f.clock.advance(6 * MIN);
    expect(await f.stub.budgetStatus()).toMatchObject({ reserved_usd: 0.5, pending_consults: 1 });
    f.clock.advance(3 * MIN);
    expect(await f.stub.budgetStatus()).toMatchObject({ reserved_usd: 0.5, pending_consults: 1 });
    expect(await f.stub.waitConsult(id, f.uid, 0)).toEqual({ ok: true, status: "pending" });
  });

  it("失われた pending（UserDO が作り直されて裏の処理が消えた）は、期限で予約額で閉じて failed にする", async () => {
    const f = await fixture();
    const { id } = await f.begin();
    f.clock.advance(CONSULT_STALE_AFTER_MS + MIN);
    // consult_result（waitConsult）の時点で閉じる
    expect(await f.stub.waitConsult(id, f.uid, 0)).toMatchObject({
      ok: true,
      status: "failed",
      error: { code: "upstream_unavailable" },
      cost_usd: 0.5,
    });
    expect(await f.stub.budgetStatus()).toMatchObject({
      spent_usd: 0.5,
      estimated_usd: 0.5,
      reserved_usd: 0,
      pending_consults: 0,
    });
    // 閉じた後に遅れて届いた完了は無視し、答えも捨てる
    f.agent.release(id, okResult({ text: "LATE", costUsd: 0.1 }));
    await new Promise((r) => setTimeout(r, 50));
    expect(await f.stub.budgetStatus()).toMatchObject({ spent_usd: 0.5 });
    const rows = await sql<{ status: string; result_json: string }>(
      f.stub,
      "SELECT status, result_json FROM consult_answer",
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe("failed");
    expect(rows[0]?.result_json).not.toContain("LATE");
  });

  it("期限の閉じ（budget_status）は pending の行も failed にする。待っている呼び出しは起きる", async () => {
    const f = await fixture();
    const { id } = await f.begin();
    const waiting = f.stub.waitConsult(id, f.uid, 20_000);
    await new Promise((r) => setTimeout(r, 30));
    f.clock.advance(CONSULT_STALE_AFTER_MS + MIN);
    await f.stub.budgetStatus();
    expect(await waiting).toMatchObject({ ok: true, status: "failed", cost_usd: 0.5 });
    expect(await sql(f.stub, "SELECT status FROM consult_answer")).toEqual([{ status: "failed" }]);
  });

  it("pending の行があれば、期限に alarm を置く（早い alarm は後ろへ動かさない）", async () => {
    const f = await fixture();
    await f.begin();
    const alarm = await runInDurableObject(f.stub, (_i, s) => s.storage.getAlarm());
    expect(alarm).not.toBeNull();
    // 期限（予約から 10 分）の近く。実時計とは独立に、遠すぎる値にはならない
    expect((alarm ?? 0) - Date.now()).toBeLessThanOrEqual(CONSULT_STALE_AFTER_MS + MIN);
  });
});

describe("UserDO: 同時 pending の上限と budget_status", () => {
  it(`同時に開ける consult は ${MAX_PENDING_CONSULTS} まで。超えたら concurrency_limit で、予約も行も作らない`, async () => {
    expect(MAX_PENDING_CONSULTS).toBe(4);
    const f = await fixture();
    const ids: string[] = [];
    for (let i = 0; i < MAX_PENDING_CONSULTS; i++) ids.push((await f.begin()).id);
    expect(await f.stub.budgetStatus()).toMatchObject({
      pending_consults: 4,
      reserved_usd: 2,
    });
    const fifth = newId();
    expect(await f.stub.reserveConsult(fifth, "m", f.owner)).toEqual({
      ok: false,
      code: "concurrency_limit",
    });
    expect(await sql(f.stub, "SELECT 1 FROM task_budget WHERE task_id = ?", fifth)).toEqual([]);
    // 既に開いている consult の予約の再送は通る（冪等）
    expect(await f.stub.reserveConsult(ids[0] as string)).toEqual({ ok: true, reserved_usd: 0.5 });
    // 1 件終われば、また開ける
    f.agent.release(ids[0] as string);
    await f.stub.waitConsult(ids[0] as string, f.uid, 5000);
    expect(await f.stub.reserveConsult(fifth, "m", f.owner)).toMatchObject({ ok: true });
  });

  it("budget_status の pending_consults は、開いている consult の件数。タスクの予約は数えない", async () => {
    const f = await fixture();
    expect(await f.stub.budgetStatus()).toMatchObject({ pending_consults: 0 });
    const a = await f.begin();
    await f.begin();
    expect(await f.stub.budgetStatus()).toMatchObject({ pending_consults: 2, reserved_usd: 1 });
    f.agent.release(a.id);
    await f.stub.waitConsult(a.id, f.uid, 5000);
    expect(await f.stub.budgetStatus()).toMatchObject({ pending_consults: 1, reserved_usd: 0.5 });
    // 予約だけして始めていない consult も開いている（精算されるまで予約を持つ）
    await f.stub.reserveConsult(newId());
    expect(await f.stub.budgetStatus()).toMatchObject({ pending_consults: 2 });
    const task = await f.stub.reserve("k1", FP);
    expect(task.ok).toBe(true);
    expect((await f.stub.budgetStatus()).pending_consults).toBe(2);
    expect(await f.stub.dashboardBudget()).toMatchObject({ pending_consults: 2 });
  });
});
