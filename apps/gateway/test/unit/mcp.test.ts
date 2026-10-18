import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { describe, expect, it } from "vitest";
import { createApiApp } from "../../src/app";

// OAuthProvider が apiHandler に渡す ExecutionContext を模す（props はリクエスト単位）
function ctxWithProps(props: Record<string, unknown>): ExecutionContext {
  return {
    waitUntil() {},
    passThroughOnException() {},
    props,
  } as unknown as ExecutionContext;
}

async function connect(props: Record<string, unknown>) {
  const app = createApiApp();
  const env = { ENVIRONMENT: "production" } as Env;
  const ctx = ctxWithProps(props);
  const transport = new StreamableHTTPClientTransport(new URL("http://localhost/mcp"), {
    fetch: async (input, init) => {
      const request = new Request(input, init);
      // 実環境では workerd が Host を付ける。合成 Request には無いので補う（handler は Host を検証する）
      request.headers.set("host", new URL(request.url).host);
      return app.fetch(request, env, ctx);
    },
  });
  const client = new Client({ name: "unit", version: "0.0.0" });
  await client.connect(transport);
  return client;
}

describe("/mcp（Hono 上の createMcpHandler）", () => {
  it("ping ツールが一覧に出る", async () => {
    const client = await connect({ githubUserId: 1, login: "alice" });
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toContain("ping");
    await client.close();
  });

  it("ping は pong を返し、リクエスト単位の props（ctx.props）がツールまで届く", async () => {
    const client = await connect({ githubUserId: 42, login: "alice" });
    const result = await client.callTool({ name: "ping", arguments: {} });
    expect(result.isError).toBeFalsy();
    const text = (result.content as { type: string; text: string }[])[0]?.text ?? "";
    expect(JSON.parse(text)).toEqual({ pong: true, login: "alice", githubUserId: 42 });
    await client.close();
  });

  it("props が異なる同時リクエストで混ざらない", async () => {
    const [a, b] = await Promise.all([
      connect({ githubUserId: 1, login: "alice" }),
      connect({ githubUserId: 2, login: "bob" }),
    ]);
    const [ra, rb] = await Promise.all([
      a.callTool({ name: "ping", arguments: {} }),
      b.callTool({ name: "ping", arguments: {} }),
    ]);
    const login = (r: typeof ra) =>
      JSON.parse((r.content as { text: string }[])[0]?.text ?? "{}").login;
    expect(login(ra)).toBe("alice");
    expect(login(rb)).toBe("bob");
    await Promise.all([a.close(), b.close()]);
  });
});
