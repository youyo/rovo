// Unit 用の Worker エントリ。本物のエントリに、台本で制御できる偽の AgentDO を足す。
// wrangler.jsonc の AGENT_DO は別 Worker（script_name）を指すので、vitest.config.ts でこのクラスに差し替える。
import { TaskDO as RealTaskDO } from "../../src/tasks/task-do";
import { fakeAppFetch, type UnitGitHubEnv } from "../support/unit-github";

export * from "../../src/index";
export { default } from "../../src/index";
export { FakeAgentDO } from "../support/fake-agent-do";

/** 本物の TaskDO に、偽の GitHub App（インメモリ）を差し込んだもの。 */
export class TaskDO extends RealTaskDO {
  constructor(ctx: DurableObjectState, env: Env) {
    // ダッシュボードの索引（DIRECTORY_DO）は、既定では束縛しない。未配送の索引は alarm を残す（D10）ので、
    // 「終端で仕事が済んだら alarm が消える」を確かめる既存のテストと切り離す。索引のテスト（task-index.test.ts）が
    // 自分で DIRECTORY_DO を差し込む。束縛が無い環境で従来どおり動くこと自体も、そのテストで確かめている。
    super(ctx, { ...env, DIRECTORY_DO: undefined } as unknown as Env);
    this.githubFetch = fakeAppFetch(env as unknown as UnitGitHubEnv);
  }
}
