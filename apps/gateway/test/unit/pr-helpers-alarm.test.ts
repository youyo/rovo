import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { clearTaskAlarms, createTask } from "./pr-helpers";

// createTask が作った TaskDO は、作成の 10 秒後に alarm を置く。alarm が残ったまま Unit のファイルが終わると、
// 共有の workerd の中で後から発火して console に監査ログを出し、閉じかけの vitest の RPC に当たって
// 「Closing rpc while "onUserConsoleLog" was pending」の Unhandled Rejection になる（dashboard-api.test.ts で CI がまれに落ちた）。
// 後始末の clearTaskAlarms が、createTask / runToCompleted が作ったタスクの alarm を消すことを確かめる。
const alarmOf = (stub: Awaited<ReturnType<typeof createTask>>["stub"]) =>
  runInDurableObject(stub, (_i, state) => state.storage.getAlarm());

describe("pr-helpers: タスクの alarm の後始末", () => {
  it("clearTaskAlarms は createTask が作ったタスクの alarm を消す", async () => {
    const a = await createTask();
    const b = await createTask({}, 802);
    expect(await alarmOf(a.stub)).not.toBeNull();
    expect(await alarmOf(b.stub)).not.toBeNull();
    await clearTaskAlarms();
    expect(await alarmOf(a.stub)).toBeNull();
    expect(await alarmOf(b.stub)).toBeNull();
  });
});
