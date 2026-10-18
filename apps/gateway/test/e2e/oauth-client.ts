import {
  type OAuthClientProvider,
  UnauthorizedError,
} from "@modelcontextprotocol/sdk/client/auth.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type {
  OAuthClientInformationMixed,
  OAuthClientMetadata,
  OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";

const REDIRECT_URL = "http://127.0.0.1:9/callback"; // 実際には誰も待ち受けない（Location を読むだけ）

/** テスト用のメモリ上 OAuthClientProvider。redirectToAuthorization で認可 URL を捕まえる。 */
export class MemoryOAuthProvider implements OAuthClientProvider {
  authorizationUrl: URL | undefined;
  private info: OAuthClientInformationMixed | undefined;
  private stored: OAuthTokens | undefined;
  private verifier = "";

  get redirectUrl() {
    return REDIRECT_URL;
  }
  get clientMetadata(): OAuthClientMetadata {
    return {
      client_name: "rovo-e2e",
      redirect_uris: [REDIRECT_URL],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    };
  }
  clientInformation() {
    return this.info;
  }
  saveClientInformation(info: OAuthClientInformationMixed) {
    this.info = info;
  }
  tokens() {
    return this.stored;
  }
  saveTokens(tokens: OAuthTokens) {
    this.stored = tokens;
  }
  redirectToAuthorization(url: URL) {
    this.authorizationUrl = url;
  }
  saveCodeVerifier(v: string) {
    this.verifier = v;
  }
  codeVerifier() {
    return this.verifier;
  }
}

/**
 * DCR -> /authorize（スタブ）-> token（PKCE）を SDK の OAuth サポートで通し、認証済みの Client を返す。
 */
export async function connectAuthenticated(baseUrl: string): Promise<Client> {
  const provider = new MemoryOAuthProvider();
  const url = new URL(`${baseUrl}/mcp`);

  const first = new StreamableHTTPClientTransport(url, { authProvider: provider });
  const firstClient = new Client({ name: "e2e", version: "0.0.0" });
  await firstClient.connect(first).then(
    () => {
      throw new Error("未認証なのに接続できてしまった");
    },
    (error: unknown) => {
      if (!(error instanceof UnauthorizedError)) throw error;
    },
  );
  if (!provider.authorizationUrl) throw new Error("認可 URL が得られなかった");

  // ブラウザの代わりに /authorize を直接叩き、Location から code を取り出す
  const res = await fetch(provider.authorizationUrl, { redirect: "manual" });
  const location = res.headers.get("location");
  if (res.status !== 302 || !location) {
    throw new Error(`/authorize が redirect しなかった: ${res.status} ${await res.text()}`);
  }
  const code = new URL(location).searchParams.get("code");
  if (!code) throw new Error(`code が無い: ${location}`);

  await first.finishAuth(code);

  const second = new StreamableHTTPClientTransport(url, { authProvider: provider });
  const client = new Client({ name: "e2e", version: "0.0.0" });
  await client.connect(second);
  return client;
}
