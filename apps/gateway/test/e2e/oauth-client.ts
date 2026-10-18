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

/** Set-Cookie を Cookie ヘッダに畳む（ブラウザの代わりに手で運ぶ）。 */
function cookieHeader(res: Response): string {
  return res.headers
    .getSetCookie()
    .map((c) => c.split(";")[0] ?? "")
    .filter((c) => c.includes("=") && !c.endsWith("="))
    .join("; ");
}

function location(res: Response, what: string): string {
  const loc = res.headers.get("location");
  if (res.status !== 302 || !loc) throw new Error(`${what} が redirect しなかった: ${res.status}`);
  return loc;
}

/** ログインの途中経過。各段階をテストから差し替えられるように分けてある。 */
export interface LoginFlow {
  provider: MemoryOAuthProvider;
  transport: StreamableHTTPClientTransport;
  /** /authorize が返した GitHub の authorize URL（state を含む） */
  githubAuthorizeUrl: string;
  /** /authorize が発行した、開始ブラウザに紐付く Cookie */
  cookie: string;
}

/** 未認証で /mcp に接続して 401 を受け、DCR して /authorize を叩くところまで進める。 */
export async function beginLogin(baseUrl: string): Promise<LoginFlow> {
  const provider = new MemoryOAuthProvider();
  const url = new URL(`${baseUrl}/mcp`);
  const transport = new StreamableHTTPClientTransport(url, { authProvider: provider });
  const firstClient = new Client({ name: "e2e", version: "0.0.0" });
  await firstClient.connect(transport).then(
    () => {
      throw new Error("未認証なのに接続できてしまった");
    },
    (error: unknown) => {
      if (!(error instanceof UnauthorizedError)) throw error;
    },
  );
  if (!provider.authorizationUrl) throw new Error("認可 URL が得られなかった");

  // ブラウザの代わりに /authorize を叩く。GitHub への redirect と Cookie が返る
  const res = await fetch(provider.authorizationUrl, { redirect: "manual" });
  return {
    provider,
    transport,
    githubAuthorizeUrl: location(res, "/authorize"),
    cookie: cookieHeader(res),
  };
}

/** （偽）GitHub の authorize を辿り、/callback の URL を得る。 */
export async function approveAtGitHub(githubAuthorizeUrl: string): Promise<string> {
  const res = await fetch(githubAuthorizeUrl, { redirect: "manual" });
  return location(res, "GitHub authorize");
}

/** /callback を叩く。Cookie は開始したブラウザのもの。 */
export async function callCallback(callbackUrl: string, cookie: string): Promise<Response> {
  return fetch(callbackUrl, { redirect: "manual", headers: cookie ? { cookie } : {} });
}

/** DCR -> /authorize -> 偽 GitHub -> /callback -> token（PKCE）を通し、認証済みの Client を返す。 */
export async function connectAuthenticated(baseUrl: string): Promise<Client> {
  const flow = await beginLogin(baseUrl);
  const callbackUrl = await approveAtGitHub(flow.githubAuthorizeUrl);
  const res = await callCallback(callbackUrl, flow.cookie);
  const back = location(res, "/callback");
  const params = new URL(back).searchParams;
  const code = params.get("code");
  if (!code) throw new Error(`ログインできなかった: ${params.get("error") ?? back}`);

  await flow.transport.finishAuth(code);
  const second = new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`), {
    authProvider: flow.provider,
  });
  const client = new Client({ name: "e2e", version: "0.0.0" });
  await client.connect(second);
  return client;
}
