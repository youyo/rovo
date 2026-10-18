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
  /** 承認後に /authorize が返した GitHub の authorize URL（state を含む） */
  githubAuthorizeUrl: string;
  /** 承認後に発行された、開始ブラウザに紐付く Cookie（/callback に必要） */
  cookie: string;
}

/** 同意画面まで進んだ状態（まだ承認していない）。 */
export interface ConsentStep {
  provider: MemoryOAuthProvider;
  transport: StreamableHTTPClientTransport;
  /** 同意画面の HTML */
  html: string;
  /** 同意フォームの handle（ワンタイムの CSRF トークン） */
  handle: string;
  /** 同意画面と一緒に発行された、開始ブラウザに紐付く Cookie */
  cookie: string;
  /** 同意画面のレスポンス */
  response: Response;
}

/** 未認証で /mcp に接続して 401 を受け、DCR して /authorize の同意画面を開くところまで進める。 */
export async function openConsent(baseUrl: string): Promise<ConsentStep> {
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

  // ブラウザの代わりに /authorize を開く。同意画面（HTML）と Cookie が返る。GitHub へはまだ行かない
  const response = await fetch(provider.authorizationUrl, { redirect: "manual" });
  if (response.status !== 200) throw new Error(`同意画面が出なかった: ${response.status}`);
  const html = await response.text();
  const handle = /name="handle" value="([^"]+)"/.exec(html)?.[1];
  if (!handle) throw new Error("同意画面に handle が無い");
  return { provider, transport, html, handle, cookie: cookieHeader(response), response };
}

/** 同意フォームを POST する（ブラウザのフォーム送信の代わり）。 */
export async function submitConsent(
  baseUrl: string,
  fields: { handle: string; decision: string },
  cookie: string,
): Promise<Response> {
  return fetch(`${baseUrl}/authorize`, {
    method: "POST",
    redirect: "manual",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      ...(cookie ? { cookie } : {}),
    },
    body: new URLSearchParams(fields).toString(),
  });
}

/** 同意画面を承認して GitHub の authorize URL に進む。 */
export async function beginLogin(baseUrl: string): Promise<LoginFlow> {
  const consent = await openConsent(baseUrl);
  const res = await submitConsent(
    baseUrl,
    { handle: consent.handle, decision: "approve" },
    consent.cookie,
  );
  return {
    provider: consent.provider,
    transport: consent.transport,
    githubAuthorizeUrl: location(res, "承認 POST"),
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
