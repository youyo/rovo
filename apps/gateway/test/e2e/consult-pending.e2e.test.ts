import { afterAll, beforeEach, describe, expect, it } from "vitest";
import {
  addMember,
  admin,
  auditRecords,
  bodyOf,
  installApp,
  login,
  newUser,
  setConsultScript,
  setConsultTiming,
  waitForAudit,
} from "./helpers";

// consult の pending と consult_result（docs/specs/consult-pending.md）。実 Worker（wrangler dev）と偽の agent Worker で通しに確かめる。
// 待ち時間は /__test/consult/timing で縮め（50 秒 → 1 秒、5 分 → 1.5 秒）、実時間では待たない。

beforeEach(async () => {
  await admin.reset();
  await setConsultTiming({ wait_ms: 1_000, background_timeout_ms: 60_000 });
});

afterAll(async () => {
  await setConsultTiming(null);
  await admin.reset();
});

async function memberClient(prefix = "cp") {
  const user = newUser(prefix);
  await addMember(user);
  await installApp();
  return { user, client: await login(user) };
}

type Client = Awaited<ReturnType<typeof login>>;

const ask = (client: Client, question: string, extra: Record<string, unknown> = {}) =>
  client.callTool({
    name: "consult",
    arguments: { messages: [{ role: "user", content: question }], ...extra },
  });

const result = (client: Client, consultId: string, timeoutSeconds = 20) =>
  client.callTool({
    name: "consult_result",
    arguments: { consult_id: consultId, timeout_seconds: timeoutSeconds },
  });

const budget = async (client: Client) =>
  bodyOf(await client.callTool({ name: "budget_status", arguments: {} }));

describe("consult: pending と consult_result（E2E）", () => {
  it("速い台本: consult が 1 回で今と同じ形（status なし）で答える", async () => {
    const { client } = await memberClient();
    try {
      const q = `pending e2e fast ${Date.now()}`;
      await setConsultScript(q, { text: "quick", usage: { input: 1000, output: 100 } });
      const r = await ask(client, q);
      expect(r.isError).toBeFalsy();
      const out = bodyOf(r);
      expect(out).toMatchObject({ text: "quick", model: "anthropic/claude-sonnet-5-5" });
      expect(Object.keys(out).sort()).toEqual(["cost_usd", "model", "text", "usage"]);
      expect(await budget(client)).toMatchObject({ reserved_usd: 0, pending_consults: 0 });
    } finally {
      await client.close();
    }
  });

  it("遅い台本: consult は pending → consult_result で done。pending 中は reserved と pending_consults に出て、done の後に spent に実費が入る。二重に数えない", async () => {
    const { user, client } = await memberClient("slow");
    try {
      const q = `pending e2e slow ${user.id}`;
      await setConsultScript(q, {
        text: "a long thought",
        usage: { input: 20_000, output: 1_000 },
        delayMs: 2_500,
      });
      const pending = bodyOf(await ask(client, q));
      expect(pending).toEqual({
        consult_id: expect.stringMatching(/^consult-[0-9A-HJKMNP-TV-Z]{26}$/),
        status: "pending",
      });
      const consultId = String(pending.consult_id);
      expect(await budget(client)).toMatchObject({
        reserved_usd: 0.5,
        spent_usd: 0,
        pending_consults: 1,
      });
      // 取りに行く（long polling。モデルが終わるまで待つ）
      const done = bodyOf(await result(client, consultId));
      expect(done).toMatchObject({
        consult_id: consultId,
        status: "done",
        text: "a long thought",
        model: "anthropic/claude-sonnet-5-5",
        usage: { input: 20_000, output: 1_000, cache_read: 0, cache_write: 0 },
      });
      // (20000 + 1000) × $1/M
      expect(done.cost_usd).toBeCloseTo(0.021, 9);
      const after = await budget(client);
      expect(after).toMatchObject({ reserved_usd: 0, pending_consults: 0, estimated_usd: 0 });
      expect(after.spent_usd).toBeCloseTo(0.021, 9);
      // 取り直しは同じ答え（冪等）で、精算は 1 回だけ
      expect(bodyOf(await result(client, consultId, 0))).toEqual(done);
      expect((await budget(client)).spent_usd).toBeCloseTo(0.021, 9);
      const finished = (await auditRecords()).filter(
        (r) => r.event === "consult_finished" && r.consult_id === consultId,
      );
      expect(finished).toHaveLength(1);
      expect(finished[0]).toMatchObject({ userId: user.id, model: "anthropic/claude-sonnet-5-5" });
      expect(JSON.stringify(await auditRecords())).not.toContain("a long thought");
    } finally {
      await client.close();
    }
  });

  it("クライアントが consult の途中で切れても、精算される（別の接続から consult_result で done が取れる）。待っている間、DO は生き続ける", async () => {
    const { user, client } = await memberClient("drop");
    let second: Client | undefined;
    try {
      // consult は答えを待ち続ける設定（50 秒相当）。その最中にクライアントが切れる
      await setConsultTiming({ wait_ms: 30_000, background_timeout_ms: 60_000 });
      const q = `pending e2e disconnect ${user.id}`;
      await setConsultScript(q, {
        text: "survived",
        usage: { input: 10_000, output: 1_000 },
        // wrangler dev が idle な DO を捨てる長さ（数秒）を超えて、未完了の RPC を待たせる
        delayMs: 12_000,
      });
      const abort = new AbortController();
      const call = client
        .callTool(
          { name: "consult", arguments: { messages: [{ role: "user", content: q }] } },
          undefined,
          { signal: abort.signal },
        )
        .then(() => "returned")
        .catch(() => "aborted");
      // consult_id は監査（consult_started）から分かる
      const started = await waitForAudit(
        (r) => r.event === "consult_started" && r.userId === user.id,
      );
      const consultId = String(started.consult_id);
      abort.abort();
      expect(await call).toBe("aborted");
      await client.close();

      second = await login(user);
      const done = bodyOf(await result(second, consultId, 50));
      expect(done).toMatchObject({ consult_id: consultId, status: "done", text: "survived" });
      const after = await budget(second);
      expect(after).toMatchObject({ reserved_usd: 0, pending_consults: 0 });
      expect(after.spent_usd).toBeCloseTo(0.011, 9);
    } finally {
      await second?.close().catch(() => {});
      await client.close().catch(() => {});
    }
  }, 60_000);

  it("台本が失敗: pending の後、consult_result が failed（error は 50 秒以内の失敗と同じ）。費用は 0 で精算される", async () => {
    const { user, client } = await memberClient("fail");
    try {
      const q = `pending e2e fail ${user.id}`;
      await setConsultScript(q, { fail: { code: "model_error" }, delayMs: 2_000 });
      const pending = bodyOf(await ask(client, q));
      expect(pending.status).toBe("pending");
      const failed = bodyOf(await result(client, String(pending.consult_id)));
      expect(failed).toEqual({
        consult_id: pending.consult_id,
        status: "failed",
        error: {
          code: "upstream_unavailable",
          message: "the model call failed; retry later",
          retry_after_seconds: 30,
        },
        cost_usd: 0,
      });
      expect(await budget(client)).toMatchObject({
        reserved_usd: 0,
        spent_usd: 0,
        pending_consults: 0,
      });
    } finally {
      await client.close();
    }
  });

  it("台本が上限を超えて返らない: 予約額で精算された failed（estimated）。遅れて返った答えは無視する", async () => {
    const { user, client } = await memberClient("hang");
    try {
      await setConsultTiming({ wait_ms: 500, background_timeout_ms: 1_500 });
      const q = `pending e2e hang ${user.id}`;
      await setConsultScript(q, { text: "too late", delayMs: 6_000 });
      const pending = bodyOf(await ask(client, q));
      expect(pending.status).toBe("pending");
      const failed = bodyOf(await result(client, String(pending.consult_id)));
      expect(failed).toMatchObject({
        status: "failed",
        error: { code: "upstream_unavailable", retry_after_seconds: 30 },
        cost_usd: 0.5,
      });
      expect(await budget(client)).toMatchObject({
        reserved_usd: 0,
        spent_usd: 0.5,
        estimated_usd: 0.5,
        pending_consults: 0,
      });
      // 台本の遅い答えが後から届いても、二重に数えない
      await new Promise((r) => setTimeout(r, 6_500));
      expect(await budget(client)).toMatchObject({ spent_usd: 0.5, estimated_usd: 0.5 });
      expect(bodyOf(await result(client, String(pending.consult_id), 0))).toMatchObject({
        status: "failed",
      });
    } finally {
      await client.close();
    }
  }, 40_000);

  it("同時 pending は 4 まで。5 件目は concurrency_limit（予約しない）。budget_status の pending_consults は 4", async () => {
    const { user, client } = await memberClient("limit");
    try {
      await setConsultTiming({ wait_ms: 300, background_timeout_ms: 60_000 });
      const ids: string[] = [];
      for (let i = 0; i < 4; i++) {
        const q = `pending e2e limit ${i} ${user.id}`;
        await setConsultScript(q, { text: `r${i}`, delayMs: 4_000 });
        const out = bodyOf(await ask(client, q));
        expect(out.status).toBe("pending");
        ids.push(String(out.consult_id));
      }
      const fifthQ = `pending e2e limit 4 ${user.id}`;
      const fifth = await ask(client, fifthQ);
      expect(fifth.isError).toBe(true);
      expect(bodyOf(fifth)).toMatchObject({ code: "concurrency_limit" });
      expect(await budget(client)).toMatchObject({ pending_consults: 4, reserved_usd: 2 });
      // 終わった分は取れて、また開ける
      const done = bodyOf(await result(client, ids[0] as string));
      expect(done.status).toBe("done");
      const again = await ask(client, fifthQ);
      expect(again.isError).toBeFalsy();
      for (const id of ids.slice(1)) {
        expect(bodyOf(await result(client, id)).status).toBe("done");
      }
    } finally {
      await client.close();
    }
  }, 40_000);

  it("別ユーザーの consult_id・存在しない ID・形が不正な ID は、同じ not_found", async () => {
    const alice = await memberClient("alice");
    const bob = await memberClient("bob");
    try {
      const q = `pending e2e owner ${alice.user.id}`;
      await setConsultScript(q, { text: "mine", delayMs: 2_000 });
      // alice の client は bob の login で切り替わるので、alice の consult は alice として呼び直す
      const aliceClient = await login(alice.user);
      try {
        const pending = bodyOf(await ask(aliceClient, q));
        const id = String(pending.consult_id);
        const bobClient = await login(bob.user);
        try {
          const others = await result(bobClient, id, 0);
          const unknown = await result(bobClient, "consult-00000000000000000000000000", 0);
          const malformed = await result(bobClient, "nope", 0);
          for (const r of [others, unknown, malformed]) {
            expect(r.isError).toBe(true);
          }
          expect(bodyOf(others)).toMatchObject({ code: "not_found" });
          expect(bodyOf(unknown)).toEqual(bodyOf(others));
          expect(bodyOf(malformed)).toEqual(bodyOf(others));
        } finally {
          await bobClient.close();
        }
        // 本人は取れる
        expect(bodyOf(await result(aliceClient, id)).status).toBe("done");
      } finally {
        await aliceClient.close();
      }
    } finally {
      await alice.client.close();
      await bob.client.close();
    }
  });
});
