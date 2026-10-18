import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";

describe("AgentDO + PiHarness + 台本付き fake モデル", () => {
  it("fake モデルが echo ツールを呼び、結果を受けて終了する", async () => {
    const stub = env.AGENT_DO.getByName("scripted-1");
    const res = await stub.runScripted(
      [
        { text: "echo します", toolCall: { name: "echo", arguments: { text: "hello" } } },
        { text: "完了: echo は hello を返した" },
      ],
      "echo ツールで hello を返して",
      "op-1",
    );
    expect(res.status).toBe("done");
    expect(res.text).toBe("完了: echo は hello を返した");
    // transcript にツール結果（echo: hello）が入っている
    expect(res.transcript).toContain("echo: hello");
  });
});
