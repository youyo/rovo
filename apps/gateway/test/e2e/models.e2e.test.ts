import { afterAll, beforeEach, describe, expect, it } from "vitest";
import {
  addMember,
  admin,
  auditRecords,
  bodyOf,
  completedResult,
  directoryConsults,
  finishAgent,
  installApp,
  login,
  newUser,
  providerConfigsCalls,
  resetProviderKeysCache,
  setConsultScript,
  startArgs,
  waitForAudit,
  waitForResult,
} from "./helpers";

beforeEach(async () => {
  await admin.reset();
  await resetProviderKeysCache();
});

// 後続のファイルにキャッシュ・失敗の記録・偽 API の状態を残さない
afterAll(async () => {
  await admin.reset();
  await resetProviderKeysCache();
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
        ["workers-ai/@cf/openai/gpt-oss-120b", "low"],
      ]);
      expect(models.map((m) => m.id)).toEqual([
        "anthropic/claude-haiku-5-5",
        "anthropic/claude-sonnet-5-5",
        "openai/gpt-6-sol",
        "workers-ai/@cf/openai/gpt-oss-120b",
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

  it("索引: consult の精算の後、UserDO の alarm で Directory にモデル・費用つきの行が出る（本文は入らない）。budget_status は変わらない", async () => {
    const { user, client } = await memberClient("consult-index");
    try {
      const q1 = `consult index first ${user.id} SECRET-QUESTION`;
      const q2 = `consult index second ${user.id}`;
      await setConsultScript(q1, {
        text: "SECRET-ANSWER",
        usage: { input: 20_000, output: 1_000, cacheRead: 0, cacheWrite: 0 },
      });
      await setConsultScript(q2, {
        text: "ok",
        usage: { input: 5_000, output: 1_000, cacheRead: 0, cacheWrite: 0 },
      });
      const first = bodyOf(
        await client.callTool({
          name: "consult",
          arguments: { system: "SECRET-SYSTEM", messages: [{ role: "user", content: q1 }] },
        }),
      );
      const second = bodyOf(
        await client.callTool({
          name: "consult",
          arguments: {
            model: "anthropic/claude-haiku-5-5",
            messages: [{ role: "user", content: q2 }],
          },
        }),
      );
      // alarm は 10 秒間隔。行が出るまで待つ
      const deadline = Date.now() + 60_000;
      let rows = await directoryConsults(user.id);
      while (rows.length < 2 && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 500));
        rows = await directoryConsults(user.id);
      }
      expect(rows).toHaveLength(2);
      const byModel = new Map(rows.map((r) => [r.model, r]));
      expect(byModel.get("anthropic/claude-sonnet-5-5")).toMatchObject({
        owner_id: user.id,
        owner_login: user.login,
        cost_micro: Math.round((first.cost_usd as number) * 1_000_000),
        estimated: false,
      });
      expect(byModel.get("anthropic/claude-haiku-5-5")).toMatchObject({
        cost_micro: Math.round((second.cost_usd as number) * 1_000_000),
      });
      expect(JSON.stringify(rows)).not.toContain("SECRET");
      const spent = (first.cost_usd as number) + (second.cost_usd as number);
      const after = bodyOf(await client.callTool({ name: "budget_status", arguments: {} }));
      expect(after.spent_usd).toBeCloseTo(spent, 6);
      expect(after.reserved_usd).toBe(0);
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

const OSS = "workers-ai/@cf/openai/gpt-oss-120b";
const SOL = "openai/gpt-6-sol";
const SONNET = "anthropic/claude-sonnet-5-5";

type Listing = { id: string; available: boolean; unavailable_reason?: string; default: boolean };
async function listing(client: Awaited<ReturnType<typeof memberClient>>["client"]) {
  const out = bodyOf(await client.callTool({ name: "models_list", arguments: {} }));
  return out.models as Listing[];
}

describe("D10b: プロバイダーキー（provider_configs）で使えるモデルが決まる", () => {
  it("両方のキーがある（偽の既定）: 全モデルが available。既定は sonnet", async () => {
    const { client } = await memberClient();
    try {
      const models = await listing(client);
      expect(models.every((m) => m.available)).toBe(true);
      expect(models.filter((m) => m.default).map((m) => m.id)).toEqual([SONNET]);
    } finally {
      await client.close();
    }
  });

  it("OpenAI のキーが無い: gpt-6-sol は available: false（no_provider_key）。task_start と consult は model_unavailable で拒否する", async () => {
    await admin.setProviderKeys([{ provider_slug: "anthropic", alias: "default" }]);
    const { client } = await memberClient();
    try {
      const models = await listing(client);
      expect(models.find((m) => m.id === SOL)).toMatchObject({
        available: false,
        unavailable_reason: "no_provider_key",
      });
      expect(models.find((m) => m.id === OSS)).toMatchObject({ available: true });
      expect(models.find((m) => m.id === SONNET)).toMatchObject({ available: true });
      // consult の tools（#135）を渡せるか。Workers AI は実機で確かめるまで false（fail closed）
      expect(models.find((m) => m.id === SONNET)).toMatchObject({ tool_calling: true });
      expect(models.find((m) => m.id === SOL)).toMatchObject({ tool_calling: true });
      expect(models.find((m) => m.id === OSS)).toMatchObject({ tool_calling: false });

      const task = await client.callTool({
        name: "task_start",
        arguments: startArgs("t", { model: SOL }),
      });
      expect(task.isError).toBe(true);
      const err = bodyOf(task);
      expect(err.code).toBe("model_unavailable");
      expect(String(err.message)).toContain("models_list");

      const consult = await client.callTool({
        name: "consult",
        arguments: { model: SOL, messages: [{ role: "user", content: "hi" }] },
      });
      expect(consult.isError).toBe(true);
      expect(bodyOf(consult).code).toBe("model_unavailable");
    } finally {
      await client.close();
    }
  });

  it("alias が default でないキーは数えない（work という alias の Anthropic のキーだけ → Anthropic は使えない）", async () => {
    await admin.setProviderKeys([{ provider_slug: "anthropic", alias: "work" }]);
    const { client } = await memberClient();
    try {
      const models = await listing(client);
      expect(models.find((m) => m.id === SONNET)?.available).toBe(false);
    } finally {
      await client.close();
    }
  });

  it("どちらのキーも無い: Workers AI だけ。既定は gpt-oss-120b で、省略した task_start・consult はそれを使う（task_status・task_result に出る）", async () => {
    await admin.setProviderKeys([]);
    const { user, client } = await memberClient("nokeys");
    try {
      const models = await listing(client);
      expect(models.filter((m) => m.available).map((m) => m.id)).toEqual([OSS]);
      expect(models.filter((m) => m.default).map((m) => m.id)).toEqual([OSS]);

      const started = bodyOf(
        await client.callTool({ name: "task_start", arguments: startArgs("t") }),
      );
      const taskId = started.task_id as string;
      const status = bodyOf(
        await client.callTool({ name: "task_status", arguments: { task_id: taskId } }),
      );
      expect(status.model).toBe(OSS);
      expect(status.effort).toBe("low");
      await finishAgent(taskId, "completed", completedResult("a".repeat(40)));
      const result = await waitForResult(client, taskId, { needHead: false });
      expect(result.model).toBe(OSS);

      const q = `consult e2e nokeys ${user.id}`;
      await setConsultScript(q, { text: "from workers ai", usage: { input: 100, output: 50 } });
      const consult = bodyOf(
        await client.callTool({
          name: "consult",
          arguments: { messages: [{ role: "user", content: q }] },
        }),
      );
      expect(consult.model).toBe(OSS);
      expect(consult.text).toBe("from workers ai");
    } finally {
      await client.close();
    }
  }, 90_000);

  it("結果は 5 分キャッシュされる: キーを足しても、キャッシュを消すまで API は 1 回だけ。消すと反映される", async () => {
    await admin.setProviderKeys([]);
    const { client } = await memberClient("cache");
    try {
      const before = await providerConfigsCalls();
      expect((await listing(client)).find((m) => m.id === SONNET)?.available).toBe(false);
      await admin.setProviderKeys([{ provider_slug: "anthropic", alias: "default" }]);
      expect((await listing(client)).find((m) => m.id === SONNET)?.available).toBe(false);
      expect((await providerConfigsCalls()) - before).toBe(1);
      await resetProviderKeysCache();
      expect((await listing(client)).find((m) => m.id === SONNET)?.available).toBe(true);
    } finally {
      await client.close();
    }
  });

  it("API が失敗し、キャッシュも無いとき: 判定できないので従来どおり AGENT_MODELS の全部が available（既定は sonnet）", async () => {
    await admin.setFault("cloudflare", 500);
    const { client } = await memberClient("fail");
    try {
      const models = await listing(client);
      expect(models.every((m) => m.available)).toBe(true);
      expect(models.filter((m) => m.default).map((m) => m.id)).toEqual([SONNET]);
    } finally {
      await admin.setFault("cloudflare", null);
      await client.close();
    }
  });
});
