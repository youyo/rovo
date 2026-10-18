import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  StreamableHTTPClientTransport,
  StreamableHTTPError,
} from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { describe, expect, inject, it } from "vitest";
import { connectAuthenticated } from "./oauth-client";

const baseUrl = inject("baseUrl");

describe("未認証", () => {
  it("POST /mcp は 401 と resource_metadata 付きの WWW-Authenticate を返す", async () => {
    const res = await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toContain("resource_metadata=");
  });

  it("MCP SDK Client は認証なしでは接続できない（UnauthorizedError）", async () => {
    const client = new Client({ name: "e2e", version: "0.0.0" });
    const transport = new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`));
    const error = await client.connect(transport).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(StreamableHTTPError);
    expect((error as StreamableHTTPError).code).toBe(401);
  });

  it("保護リソースのメタデータが公開される", async () => {
    const res = await fetch(`${baseUrl}/.well-known/oauth-protected-resource/mcp`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { resource: string; authorization_servers: string[] };
    expect(body.resource).toBe(`${baseUrl}/mcp`);
  });
});

describe("認証後（DCR -> /authorize スタブ -> token(PKCE)）", () => {
  it("ping ツールが一覧にあり、呼び出すと pong と認証済みユーザーが返る", async () => {
    const client = await connectAuthenticated(baseUrl);
    try {
      const { tools } = await client.listTools();
      expect(tools.map((t) => t.name)).toContain("ping");

      const result = await client.callTool({ name: "ping", arguments: {} });
      expect(result.isError).toBeFalsy();
      const text = (result.content as { type: string; text: string }[])[0]?.text ?? "";
      expect(JSON.parse(text)).toEqual({ pong: true, login: "e2e-user", githubUserId: 1001 });
    } finally {
      await client.close();
    }
  });

  it("不正なアクセストークンは 401", async () => {
    const res = await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        authorization: "Bearer not-a-real-token",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    expect(res.status).toBe(401);
  });
});
