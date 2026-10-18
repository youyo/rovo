// Unit 用の Worker エントリ。本物のエントリに、台本で制御できる偽の AgentDO を足す。
// wrangler.jsonc の AGENT_DO は別 Worker（script_name）を指すので、vitest.config.ts でこのクラスに差し替える。
export * from "../../src/index";
export { default } from "../../src/index";
export { FakeAgentDO } from "../support/fake-agent-do";
