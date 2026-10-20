import { beforeEach, describe, expect, it } from "vitest";
import {
  addMember,
  admin,
  auditRecords,
  bodyOf,
  completedResult,
  finishAgent,
  installApp,
  login,
  newUser,
  setConsultScript,
  startArgs,
  waitForAudit,
  waitForResult,
} from "./helpers";

beforeEach(async () => {
  await admin.reset();
});

async function memberClient(prefix = "user") {
  const user = newUser(prefix);
  await addMember(user);
  await installApp();
  return { user, client: await login(user) };
}

describe("D10: models_list（実 Worker・MCP SDK Client）", () => {
  it("AGENT_MODELS のモデルを単価つきで返し、既定のモデルに default: true を付ける", async () => {
    const { client } = await memberClient();
    try {
      const out = bodyOf(await client.callTool({ name: "models_list", arguments: {} }));
      const models = out.models as {
        id: string;
        default: boolean;
        input_per_mtok: number;
        effort: string;
      }[];
      // 思考レベル（effort）: 初期値に、E2E の MODEL_EFFORTS（haiku=off、sol=xhigh）を重ねた最終の値
      expect(models.map((m) => [m.id, m.effort])).toEqual([
        ["anthropic/claude-haiku-5-5", "off"],
        ["anthropic/claude-sonnet-5-5", "high"],
        ["openai/gpt-6-sol", "xhigh"],
      ]);
      expect(models.map((m) => m.id)).toEqual([
        "anthropic/claude-haiku-5-5",
        "anthropic/claude-sonnet-5-5",
        "openai/gpt-6-sol",
      ]);
      expect(models.filter((m) => m.default).map((m) => m.id)).toEqual([
        "anthropic/claude-sonnet-5-5",
      ]);
      expect(models.find((m) => m.id === "anthropic/claude-haiku-5-5")).toMatchObject({
        provider: "anthropic",
        api: "anthropic-messages",
        input_per_mtok: 0.1,
        output_per_mtok: 0.5,
        cache_read_per_mtok: 0.01,
        cache_write_per_mtok: 0.125,
        tiers: [
          {
            input_tokens_above: 100_000,
            input_per_mtok: 0.5,
            output_per_mtok: 2.5,
            cache_read_per_mtok: 0.05,
            cache_write_per_mtok: 0.625,
          },
        ],
      });
      expect(models.find((m) => m.id === "openai/gpt-6-sol")).toMatchObject({
        provider: "openai",
        api: "openai-responses",
      });
    } finally {
      await client.close();
    }
  });
});

describe("D10: task_start の model", () => {
  it("haiku を指定すると task_status・task_result に返る。AGENT_MODELS の外は invalid_input", async () => {
    const { client } = await memberClient();
    try {
      const ng = await client.callTool({
        name: "task_start",
        arguments: startArgs("t", { model: "anthropic/claude-opus-5-5" }),
      });
      expect(ng.isError).toBe(true);
      expect(bodyOf(ng)).toMatchObject({ code: "invalid_input" });

      const started = bodyOf(
        await client.callTool({
          name: "task_start",
          arguments: startArgs("t", { model: "anthropic/claude-haiku-5-5" }),
        }),
      );
      const taskId = started.task_id as string;
      const status = bodyOf(
        await client.callTool({ name: "task_status", arguments: { task_id: taskId } }),
      );
      expect(status.model).toBe("anthropic/claude-haiku-5-5");
      expect(status.effort).toBe("off");

      await finishAgent(taskId, "completed", completedResult("a".repeat(40)));
      const result = await waitForResult(client, taskId, { needHead: false });
      expect(result.model).toBe("anthropic/claude-haiku-5-5");
      expect(result.effort).toBe("off");
    } finally {
      await client.close();
    }
  });

  it("省略すると既定のモデル", async () => {
    const { client } = await memberClient();
    try {
      const started = bodyOf(
        await client.callTool({ name: "task_start", arguments: startArgs("t") }),
      );
      const status = bodyOf(
        await client.callTool({ name: "task_status", arguments: { task_id: started.task_id } }),
      );
      expect(status.model).toBe("anthropic/claude-sonnet-5-5");
      expect(status.effort).toBe("high");
    } finally {
      await client.close();
    }
  });
});

describe("D10: consult のモデルの 4xx", () => {
  it("モデルが 4xx（リクエストの中身の問題）なら model_rejected（retry_after_seconds なし）。5xx は upstream_unavailable。どちらも費用は精算される", async () => {
    const { user, client } = await memberClient("rejected");
    try {
      const q1 = `consult e2e rejected ${user.id}`;
      await setConsultScript(q1, { fail: { code: "model_rejected" } });
      const rejected = await client.callTool({
        name: "consult",
        arguments: { messages: [{ role: "user", content: q1 }] },
      });
      expect(rejected.isError).toBe(true);
      const body1 = bodyOf(rejected);
      expect(body1).toMatchObject({ code: "model_rejected" });
      expect(body1.retry_after_seconds).toBeUndefined();

      const q2 = `consult e2e server error ${user.id}`;
      await setConsultScript(q2, { fail: { code: "model_error" } });
      const failed = await client.callTool({
        name: "consult",
        arguments: { messages: [{ role: "user", content: q2 }] },
      });
      expect(failed.isError).toBe(true);
      expect(bodyOf(failed)).toMatchObject({
        code: "upstream_unavailable",
        retry_after_seconds: 30,
      });

      // 予約は閉じている
      const after = bodyOf(await client.callTool({ name: "budget_status", arguments: {} }));
      expect(after.reserved_usd).toBe(0);
    } finally {
      await client.close();
    }
  });
});

describe("D10: budget_status と consult の予約・精算", () => {
  it("consult を 2 回呼ぶと、usage（cache_write → cache_read）と費用が返り、月の枠から実費で精算される。タスクの実行中でも使える", async () => {
    const { user, client } = await memberClient("consult");
    try {
      const before = bodyOf(await client.callTool({ name: "budget_status", arguments: {} }));
      expect(before).toMatchObject({
        monthly_budget_usd: 100,
        spent_usd: 0,
        reserved_usd: 0,
        remaining_usd: 100,
        task_budget_usd: 10,
        consult_budget_usd: 0.5,
        max_concurrent_tasks: 10,
      });

      // タスクを実行中にしておく（consult は同時実行の枠を使わない）
      await client.callTool({ name: "task_start", arguments: startArgs("running") });
      const during = bodyOf(await client.callTool({ name: "budget_status", arguments: {} }));
      expect(during).toMatchObject({
        reserved_usd: 10,
        remaining_usd: 90,
        max_concurrent_tasks: 9,
      });

      const q1 = `consult e2e first ${user.id}`;
      const q2 = `consult e2e second ${user.id}`;
      await setConsultScript(q1, {
        text: "Use a queue.",
        usage: { input: 20_000, output: 1_000, cacheRead: 0, cacheWrite: 15_000 },
      });
      await setConsultScript(q2, {
        text: "Still a queue.",
        usage: { input: 5_000, output: 1_000, cacheRead: 15_000, cacheWrite: 0 },
      });

      const first = bodyOf(
        await client.callTool({
          name: "consult",
          arguments: {
            system: "You are an architect.",
            messages: [{ role: "user", content: q1 }],
          },
        }),
      );
      expect(first).toMatchObject({
        text: "Use a queue.",
        model: "anthropic/claude-sonnet-5-5",
        usage: { input: 20_000, output: 1_000, cache_read: 0, cache_write: 15_000 },
      });
      // (20000 + 1000) × $1/M + 15000 × $1.25/M
      expect(first.cost_usd).toBeCloseTo(0.021 + 0.01875, 9);

      const second = bodyOf(
        await client.callTool({
          name: "consult",
          arguments: {
            model: "anthropic/claude-haiku-5-5",
            system: "You are an architect.",
            messages: [{ role: "user", content: q2 }],
          },
        }),
      );
      expect(second).toMatchObject({
        text: "Still a queue.",
        model: "anthropic/claude-haiku-5-5",
        usage: { cache_read: 15_000, cache_write: 0 },
      });
      // (5000 + 1000) × $1/M + 15000 × $0.1/M
      expect(second.cost_usd).toBeCloseTo(0.006 + 0.0015, 9);

      const spent = (first.cost_usd as number) + (second.cost_usd as number);
      const after = bodyOf(await client.callTool({ name: "budget_status", arguments: {} }));
      // 予約は閉じ、実費だけが spent に残る（タスクの予約 10 は実行中のまま）
      expect(after.reserved_usd).toBe(10);
      expect(after.spent_usd).toBeCloseTo(spent, 6);
      expect(after.remaining_usd).toBeCloseTo(90 - spent, 6);

      // 監査: userId・model・cost_usd（会話の内容は出ない）
      const records = (await auditRecords()).filter(
        (r) => r.userId === user.id && r.event.startsWith("consult_"),
      );
      expect(records.map((r) => r.event)).toEqual([
        "consult_started",
        "consult_finished",
        "consult_started",
        "consult_finished",
      ]);
      expect(records[1]).toMatchObject({ model: "anthropic/claude-sonnet-5-5" });
      expect(records[1]?.cost_usd).toBeCloseTo(first.cost_usd as number, 9);
      expect(JSON.stringify(records)).not.toContain("architect");
      await waitForAudit((r) => r.event === "consult_finished" && r.userId === user.id);
    } finally {
      await client.close();
    }
  });

  it("不正な入力・使えないモデルは invalid_input で、予約は残らない", async () => {
    const { client } = await memberClient("consult-bad");
    try {
      for (const args of [
        { messages: [] },
        { model: "openai/gpt-6-astra", messages: [{ role: "user", content: "x" }] },
        { messages: [{ role: "assistant", content: "x" }] },
      ]) {
        const r = await client.callTool({ name: "consult", arguments: args });
        expect(r.isError, JSON.stringify(args)).toBe(true);
        expect(bodyOf(r)).toMatchObject({ code: "invalid_input" });
      }
      expect(bodyOf(await client.callTool({ name: "budget_status", arguments: {} }))).toMatchObject(
        { reserved_usd: 0, spent_usd: 0 },
      );
    } finally {
      await client.close();
    }
  });
});
