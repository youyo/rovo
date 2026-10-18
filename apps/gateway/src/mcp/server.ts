import { McpServer } from "@modelcontextprotocol/server";
import { getMcpAuthContext } from "agents/mcp/server";
import { z } from "zod";
import { isAuthProps } from "../auth/props";

/**
 * リクエストごとに新しい McpServer を作る（agents の createMcpHandler の factory）。
 * ユーザー情報はモジュール変数や共有インスタンスに持たず、ツール実行時に
 * getMcpAuthContext()（= OAuthProvider が ctx.props に入れた値）から読む。
 */
export function createRovoServer(): McpServer {
  const server = new McpServer({ name: "rovo-gateway", version: "0.1.0" });

  server.registerTool(
    "ping",
    {
      description: "疎通確認用。pong と、認証済みユーザーの login を返す。",
      inputSchema: z.object({}),
    },
    async () => {
      const props = getMcpAuthContext()?.props;
      const user = isAuthProps(props) ? props : undefined;
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              pong: true,
              login: user?.login ?? null,
              githubUserId: user?.githubUserId ?? null,
            }),
          },
        ],
      };
    },
  );

  return server;
}
