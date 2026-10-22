import { beforeEach, describe, expect, it } from "vitest";
import {
  addMember,
  admin,
  bodyOf,
  installApp,
  login,
  newUser,
  startArgs,
  waitForResult,
} from "./helpers";

// task_start で model を省略したときの自動選択（実 Worker・MCP SDK Client）。
// gateway の AI バインディングは、E2E 用の設定で偽の Workers AI（test/support/fake-agent-worker/fake-ai.ts）に差し替えてある。
// 偽の AI は instructions の目印で答えを変える: 目印なし = 普通の実装（sonnet）、FAKE_AI_LIGHT = 軽い（haiku）、
// FAKE_AI_FAIL = 例外、FAKE_AI_HANG = 返らない（時間切れ）、FAKE_AI_INVALID = 想定外の形。

const HAIKU = "anthropic/claude-haiku-5-5";
const SONNET = "anthropic/claude-sonnet-5-5";

beforeEach(async () => {
  await admin.reset();
});

async function member() {
  const user = newUser("selector");
  await addMember(user);
  await installApp();
  return login(user);
}

describe("task_start の model を省略: Clef が選ぶ", () => {
  it("普通の実装は sonnet。task_start・task_status・task_result の応答に model と model_selection が出る", async () => {
    const client = await member();
    try {
      const started = bodyOf(
        await client.callTool({ name: "task_start", arguments: startArgs("ordinary") }),
      );
      expect(started).toMatchObject({
        status: "RUNNING",
        model: SONNET,
        model_selection: { mode: "auto", chosen: SONNET, reason: "clef_flash" },
      });
      const sel = started.model_selection as {
        latency_ms?: number;
        scores?: Record<string, number>;
      };
      expect(typeof sel.latency_ms).toBe("number");
      expect(sel.scores?.[SONNET]).toBeGreaterThan(0.5);
      const taskId = started.task_id as string;
      const status = bodyOf(
        await client.callTool({ name: "task_status", arguments: { task_id: taskId } }),
      );
      expect(status).toMatchObject({
        model: SONNET,
        model_selection: { mode: "auto", chosen: SONNET, reason: "clef_flash" },
      });
      await client.callTool({ name: "task_cancel", arguments: { task_id: taskId } });
      const result = await waitForResult(client, taskId, { needHead: false });
      expect(result).toMatchObject({
        model: SONNET,
        model_selection: { mode: "auto", chosen: SONNET, reason: "clef_flash" },
      });
    } finally {
      await client.close();
    }
  });

  it("軽い仕事は haiku で始まる（task_status の model・effort も haiku のもの）", async () => {
    const client = await member();
    try {
      const started = bodyOf(
        await client.callTool({
          name: "task_start",
          arguments: startArgs("light", { instructions: "FAKE_AI_LIGHT README に 1 行足す" }),
        }),
      );
      expect(started).toMatchObject({ model: HAIKU, model_selection: { chosen: HAIKU } });
      const status = bodyOf(
        await client.callTool({
          name: "task_status",
          arguments: { task_id: started.task_id as string },
        }),
      );
      expect(status).toMatchObject({ model: HAIKU, effort: "off" });
    } finally {
      await client.close();
    }
  });

  it("model を指定したら Clef を使わない（explicit）", async () => {
    const client = await member();
    try {
      // 偽の AI は FAKE_AI_FAIL なら例外を投げる。指定したモデルでは呼ばれないので影響しない
      const started = bodyOf(
        await client.callTool({
          name: "task_start",
          arguments: startArgs("explicit", { model: HAIKU, instructions: "FAKE_AI_FAIL" }),
        }),
      );
      expect(started).toMatchObject({
        model: HAIKU,
        model_selection: { mode: "explicit", chosen: HAIKU, reason: "explicit" },
      });
    } finally {
      await client.close();
    }
  });

  it("Clef が失敗・想定外・時間切れでも task_start は成功し、既定のモデル（sonnet）で始まる。時間は 3 秒台まで", async () => {
    const client = await member();
    try {
      for (const [marker, reason] of [
        ["FAKE_AI_FAIL", "fallback_error"],
        ["FAKE_AI_INVALID", "fallback_invalid"],
        ["FAKE_AI_HANG", "fallback_timeout"],
      ] as const) {
        const t0 = Date.now();
        const r = await client.callTool({
          name: "task_start",
          arguments: startArgs(marker, { instructions: marker }),
        });
        const elapsed = Date.now() - t0;
        expect(r.isError, marker).toBeFalsy();
        const started = bodyOf(r);
        expect(started, marker).toMatchObject({
          status: "RUNNING",
          model: SONNET,
          model_selection: { mode: "auto", chosen: SONNET, reason },
        });
        // 全体の上限は 3 秒（その他の処理を含めても余裕を見て 8 秒未満）
        expect(elapsed, marker).toBeLessThan(8_000);
        // 同時実行 1 件の構成なので、次のために止める
        await client.callTool({
          name: "task_cancel",
          arguments: { task_id: started.task_id as string },
        });
      }
    } finally {
      await client.close();
    }
  });

  it("同じ idempotency_key の再試行は同じタスクで、選び方も変わらない", async () => {
    const client = await member();
    try {
      const args = startArgs("idem", {
        idempotency_key: "sel-idem-1",
        instructions: "FAKE_AI_LIGHT",
      });
      const a = bodyOf(await client.callTool({ name: "task_start", arguments: args }));
      const b = bodyOf(await client.callTool({ name: "task_start", arguments: args }));
      expect(b.task_id).toBe(a.task_id);
      expect(b).toMatchObject({ model: HAIKU, model_selection: { chosen: HAIKU } });
    } finally {
      await client.close();
    }
  });
});
