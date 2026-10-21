import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { getFakeApp, type UnitGitHubEnv } from "../support/unit-github";
import { newTaskId, newUserId, sampleInput, taskStub, warmUpTaskDo } from "./helpers";

const app = () => getFakeApp(env as unknown as UnitGitHubEnv);

// setup.ts の beforeAll は、DO の初期化を待つために使い捨てのタスクを作る（warmUpTaskDo）。TaskDO は作成の 10 秒後に
// alarm を置き、alarm は GitHub への準備（トークンの発行・初期コミット・ブランチ・Draft PR）を、全テストが共有する偽 GitHub に
// 対して行う。ウォームアップのタスクがその alarm を残すと、ファイルの開始から 10 秒後に、そのときに走っているテストの
// GitHub へのリクエストに混ざり、そのテストが張った「1 回だけ失敗させる障害」を先に消費してしまう
// （task-github.test.ts の "secondary rate limit" が、遅い環境で CREATING のはずが RUNNING になっていた）。
describe("setup のウォームアップのタスク", () => {
  it("alarm を残さない（10 秒後に GitHub を呼んで、他のテストの障害を消費しない）", async () => {
    const warmUpId = await warmUpTaskDo();
    const alarm = await runInDurableObject(taskStub(warmUpId), (_i, state) =>
      state.storage.getAlarm(),
    );
    expect(alarm).toBeNull();
  });

  it("alarm が発火しても、他のテストが張った 1 回だけの障害は残り、そのテストのタスクが受ける", async () => {
    const warmUpId = await warmUpTaskDo();
    app().setFault({
      pattern: "^POST /repos/.*/git/commits$",
      status: 403,
      count: 1,
      message: "You have exceeded a secondary rate limit.",
    });
    // 遅い環境では 10 秒後にテストの最中に発火する alarm を、ここで発火させて競合を明示する
    await runDurableObjectAlarm(taskStub(warmUpId));

    const owner = newUserId();
    const id = newTaskId();
    const stub = taskStub(id);
    const created = await stub.ensureCreated(sampleInput(id, owner));
    if (!created.ok) throw new Error(`ensureCreated failed: ${created.code}`);
    await stub.advance();
    const r = await stub.getStatus(owner);
    if (!r.ok) throw new Error("not found");
    expect(r.task.status).toBe("CREATING");
  });
});
