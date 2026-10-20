import { env } from "cloudflare:workers";
import { beforeAll, beforeEach } from "vitest";
import { resetFakeApp, type UnitGitHubEnv } from "../support/unit-github";
import { fakeAgent, newTaskId, newUserId, sampleInput, taskStub } from "./helpers";

// 全テストファイルは 1 つの workerd を共有する。最初に DO を呼ぶテストは、workerd のモジュール読み込みと
// DO の初期化（SQLite のスキーマ作成など）を待つので、CPU が少ない環境（1 vCPU の Sandbox）では
// 既定の 5 秒に迫る。その待ちを、テストの外（beforeAll。hookTimeout で待てる）に出しておく。
// 計測では、最初のテストだけが他の 10 倍以上（0.5 秒対 0.03 秒）かかっていた。
beforeAll(async () => {
  const id = newTaskId();
  const created = await taskStub(id).ensureCreated(sampleInput(id, newUserId()));
  if (!created.ok) throw new Error("warm-up: ensureCreated");
  await fakeAgent(id).getEvents(0, 1);
});

// 偽の GitHub App の設定（Draft 不可・障害・時計）は、テストごとに初期状態へ戻す。
beforeEach(() => {
  resetFakeApp(env as unknown as UnitGitHubEnv);
});
