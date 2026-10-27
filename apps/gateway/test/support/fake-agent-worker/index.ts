// E2E 用の偽の agent Worker。gateway の AGENT_DO（script_name: rovo-agent, class_name: AgentDO）の相手になる。
// 本物の apps/agent は Docker（コンテナ）が要る。gateway 単体の E2E では、台本で制御できる偽物で足りる
// （既定は start を受理し、cancel は即座に stopped:true）。実物との通しは agent と gateway を同時に起動する E2E で行う。
export { FakeAgentDO as AgentDO } from "../fake-agent-do";
// gateway の AI バインディング（Workers AI）の代わり。E2E 用の設定で service binding に差し替える
export { FakeAI } from "./fake-ai";
// gateway の WEB（Web Research Service）の代わり。E2E 用の設定で service binding に差し替える
export { FakeWebResearch } from "./fake-web";

export default {
  fetch(): Response {
    return new Response("fake rovo-agent", { status: 404 });
  },
} satisfies ExportedHandler;
