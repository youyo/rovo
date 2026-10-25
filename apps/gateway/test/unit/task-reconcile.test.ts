import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FP, fakeAgent, newUserId, sampleInput, taskStub, userStub } from "./helpers";

const MIN = 60_000;
type Result = { state: "confirmed"; micro: number } | { state: "pending" };

async function finished(configured: boolean) {
  const uid = newUserId();
  const user = userStub(uid);
  const r = await user.reserve("k", FP);
  if (!r.ok) throw new Error("reserve");
  const stub = taskStub(r.task_id);
  const c = await stub.ensureCreated(sampleInput(r.task_id, uid));
  if (!c.ok) throw new Error("create");
  const agent = fakeAgent(r.task_id);
  const calls: [string, number][] = [];
  const results: Result[] = [];
  const clock = { t: Date.now() };
  await stub.advance();
  await agent.setUsage(3, { modelCalls: 4 } as never);
  await runInDurableObject(stub, (i) => {
    const t = i as unknown as {
      now: () => number;
      env: Record<string, string | undefined>;
      gatewayCost: (id: string, n: number) => Promise<Result>;
    };
    t.now = () => clock.t;
    if (configured) {
      t.env.CLOUDFLARE_API_TOKEN = "token-example";
      t.env.CLOUDFLARE_ACCOUNT_ID = "acct-example";
      t.env.AI_GATEWAY_ID = "gw-example";
    } else {
      t.env.CLOUDFLARE_API_TOKEN = undefined;
    }
    t.gatewayCost = async (id, n) => {
      calls.push([id, n]);
      return results.shift() ?? { state: "pending" };
    };
  });
  await agent.setPhase("completed");
  await stub.advance();
  return { user, id: r.task_id, stub, calls, results, clock };
}

const budget = (user: ReturnType<typeof userStub>, id: string) =>
  runInDurableObject(
    user,
    (_i, s) =>
      s.storage.sql
        .exec("SELECT settled_micro, cost_source FROM task_budget WHERE task_id = ?", id)
        .toArray()[0],
  );
const alarm = (stub: ReturnType<typeof taskStub>) =>
  runInDurableObject(stub, (_i, s) => s.storage.getAlarm());

afterEach(() => vi.restoreAllMocks());

describe("TaskDO: 終端後の費用の確定（AI Gateway のログ）", () => {
  it("2 分後に確定できれば UserDO を gateway の額で 1 回だけ上書きして終わる", async () => {
    const { user, id, stub, calls, results, clock } = await finished(true);
    expect(await budget(user, id)).toEqual({ settled_micro: 3_000_000, cost_source: "estimate" });
    // 2 分たつまでは問い合わせない
    await runDurableObjectAlarm(stub);
    expect(calls).toHaveLength(0);
    clock.t += 2 * MIN;
    results.push({ state: "confirmed", micro: 2_500_000 });
    await runDurableObjectAlarm(stub);
    expect(calls).toEqual([[id, 4]]);
    expect(await budget(user, id)).toEqual({ settled_micro: 2_500_000, cost_source: "gateway" });
    // 終わったら、アラームも問い合わせも残らない
    expect(await alarm(stub)).toBeNull();
    clock.t += 7 * 60 * MIN;
    await runDurableObjectAlarm(stub);
    expect(calls).toHaveLength(1);
  });

  it("確定できなければ 2分/10分/1時間/6時間 の 4 回で打ち切り、見積もりのまま", async () => {
    const { user, id, stub, calls, clock } = await finished(true);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    for (const at of [2 * MIN, 10 * MIN, 60 * MIN, 360 * MIN]) {
      // 予定の 1 分前には問い合わせない
      const base = (await baseOf(stub)) ?? 0;
      clock.t = base + at - MIN;
      await runDurableObjectAlarm(stub);
      const n = calls.length;
      clock.t = base + at;
      await runDurableObjectAlarm(stub);
      expect(calls.length).toBe(n + 1);
    }
    expect(calls).toHaveLength(4);
    expect(await budget(user, id)).toEqual({ settled_micro: 3_000_000, cost_source: "estimate" });
    expect(await alarm(stub)).toBeNull();
    clock.t += 24 * 60 * MIN;
    await runDurableObjectAlarm(stub);
    expect(calls).toHaveLength(4);
    expect(warn).not.toHaveBeenCalled();
  });

  it("確定額が見積もりと 20% を超えてずれたら console.warn で構造化ログを出す", async () => {
    const { id, stub, results, clock } = await finished(true);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    clock.t += 2 * MIN;
    results.push({ state: "confirmed", micro: 1_000_000 });
    await runDurableObjectAlarm(stub);
    const logged = warn.mock.calls.map((c) => String(c[0])).join("\n");
    expect(logged).toContain(id);
    expect(logged).toContain("3000000");
    expect(logged).toContain("1000000");
  });

  it("20% 以内のずれでは警告しない", async () => {
    const { stub, results, clock } = await finished(true);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    clock.t += 2 * MIN;
    results.push({ state: "confirmed", micro: 3_300_000 });
    await runDurableObjectAlarm(stub);
    expect(warn).not.toHaveBeenCalled();
  });

  it("設定が無い環境では何もしない", async () => {
    const { user, id, stub, calls, clock } = await finished(false);
    clock.t += 7 * 60 * MIN;
    await runDurableObjectAlarm(stub);
    expect(calls).toHaveLength(0);
    expect(await budget(user, id)).toEqual({ settled_micro: 3_000_000, cost_source: "estimate" });
    expect(await alarm(stub)).toBeNull();
  });

  it("task_result の usage に cost_source と estimate_usd。確定後の cost_usd は確定額", async () => {
    const { stub, id, results, clock } = await finished(true);
    const owner = await runInDurableObject(
      stub,
      (_i, s) => s.storage.sql.exec("SELECT owner_id FROM task").one().owner_id as number,
    );
    const before = await stub.result(owner);
    expect(before).toMatchObject({
      ok: true,
      result: { usage: { cost_usd: 3, cost_source: "estimate", estimate_usd: 3 } },
    });
    clock.t += 2 * MIN;
    results.push({ state: "confirmed", micro: 2_500_000 });
    await runDurableObjectAlarm(stub);
    const after = await stub.result(owner);
    expect(after).toMatchObject({
      ok: true,
      result: { usage: { cost_usd: 2.5, cost_source: "gateway", estimate_usd: 3 } },
    });
    expect(id).toBeTruthy();
  });
});

function baseOf(stub: ReturnType<typeof taskStub>) {
  return runInDurableObject(
    stub,
    (_i, s) =>
      s.storage.sql.exec("SELECT reconcile_base FROM agent_link").one().reconcile_base as
        | number
        | null,
  );
}
