import { DurableObject } from "cloudflare:workers";
import { createModels, Type } from "@earendil-works/pi-ai";
import { createRegistry, defineTool, Harness, section } from "@earendil-works/pi-durable";
import { PiHarness } from "agents/harness/pi";
import { Lifecycle } from "agents/lifecycle";
import {
  createScriptedProvider,
  SCRIPTED_MODEL_ID,
  SCRIPTED_PROVIDER_ID,
  type ScriptStep,
} from "./pi/scripted-provider";

const echoTool = defineTool({
  name: "echo",
  description: "Echo the given text back.",
  parameters: Type.Object({ text: Type.String() }),
  replay: "safe",
  async execute(args) {
    return { output: [{ type: "text", text: `echo: ${args.text}` }] };
  },
});

export class AgentDO extends DurableObject<Env> {
  private readonly registry = createRegistry();

  private readonly harness = new PiHarness({
    harness: async ({ storage, context }) => {
      const models = createModels();
      // M1 スパイク: 台本付き fake provider を差し込めることの確認。本物のモデル（AI Gateway）は後続で切り替える。
      models.setProvider(createScriptedProvider(() => this.readScript()));
      this.registry.install({
        name: "rovo",
        tools: [echoTool],
        sections: [section("task", () => "You are a test agent. Use the tools you are given.")],
      });
      return Harness.open(storage, { models, registry: this.registry }, context);
    },
    defaults: { model: { provider: SCRIPTED_PROVIDER_ID, id: SCRIPTED_MODEL_ID } },
  });

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    // 復旧（heartbeat と checkpoint）は PiHarness の Lifecycle ジョブに任せる
    Lifecycle.install(this).use(this.harness);
  }

  private readScript(): ScriptStep[] {
    return this.ctx.storage.kv.get<ScriptStep[]>("script") ?? [];
  }

  /** Gateway → Agent の RPC 疎通確認用（M1 スパイク）。 */
  ping(message: string): string {
    return `agent:${message}`;
  }

  /** M1 スパイク: 台本どおりに応答する fake モデルで 1 回実行する。ENVIRONMENT=test のときだけ使える。 */
  async runScripted(script: ScriptStep[], prompt: string, operationId: string) {
    if (this.env.ENVIRONMENT !== "test") throw new Error("runScripted is only available in test");
    this.ctx.storage.kv.put("script", script);
    const res = await this.harness.prompt(prompt, { operationId });
    // RPC の型が深くなりすぎるため、transcript は JSON 文字列で返す
    return {
      status: res.status,
      text: res.text,
      reason: res.reason,
      transcript: JSON.stringify(res.messages),
    };
  }
}
