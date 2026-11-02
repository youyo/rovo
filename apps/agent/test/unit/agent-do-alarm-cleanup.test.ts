import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { call, clearAgentFixtures, makeSpec, newFixture, report } from "./support/agent-fixture";

// タスクが終端を待たずに終わっても、後始末の clearAgentFixtures が alarm とタスクの動きを止める
// （残ると共有の workerd で後から動き、閉じかけの vitest の RPC に当たって EnvironmentTeardownError になる）。
const alarmOf = (stub: ReturnType<typeof newFixture>["stub"]) =>
  runInDurableObject(stub, (_i, state) => state.storage.getAlarm());

describe("agent-fixture: alarm とタスクの後始末", () => {
  it("clearAgentFixtures は fixture が作った AgentDO の alarm を消し、動いているタスクを止める", async () => {
    const a = newFixture("alarm-a", [call("gate"), report()]);
    const b = newFixture("alarm-b", [report()]);
    await a.stub.start(makeSpec("alarm-a", { verificationCommands: [] }));
    await a.gate.waitEntered();
    for (const fx of [a, b]) {
      await runInDurableObject(fx.stub, (_i, state) => state.storage.setAlarm(Date.now() + 60_000));
      expect(await alarmOf(fx.stub)).not.toBeNull();
    }
    await clearAgentFixtures();
    expect(await alarmOf(a.stub)).toBeNull();
    expect(await alarmOf(b.stub)).toBeNull();
    // 動いていたタスクは終端まで進んでいる（止めずに残さない）
    expect(["cancelled", "completed"]).toContain((await a.stub.getEvents(0, 1)).phase);
  });
});
