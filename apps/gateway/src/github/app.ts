import { DEFAULT_GITHUB_API_BASE } from "./config";

/** GitHub REST API のエラー。メッセージ・フィールドにトークンや JWT は入れない。 */
export class GitHubApiError extends Error {
  /** 0 はネットワーク障害（応答なし） */
  readonly status: number;
  readonly retryAfterMs: number | undefined;
  /** 429、または 403 の rate limit / secondary rate limit */
  readonly rateLimited: boolean;
  /** 応答本文の message と errors をつないだ文字列（分類用。長さは切ってある） */
  readonly detail: string;
  constructor(args: {
    status: number;
    retryAfterMs?: number | undefined;
    rateLimited?: boolean;
    detail?: string;
    what: string;
  }) {
    super(`GitHub API ${args.what} failed: ${args.status === 0 ? "network error" : args.status}`);
    this.name = "GitHubApiError";
    this.status = args.status;
    this.retryAfterMs = args.retryAfterMs;
    this.rateLimited = args.rateLimited ?? false;
    this.detail = args.detail ?? "";
  }
}

const MAX_DETAIL = 500;

/** 応答がエラーなら GitHubApiError を投げる。 */
export async function throwApiError(res: Response, what: string): Promise<never> {
  let detail = "";
  try {
    const text = await res.text();
    try {
      const body = JSON.parse(text) as { message?: unknown; errors?: unknown };
      detail = [
        typeof body.message === "string" ? body.message : "",
        body.errors === undefined ? "" : JSON.stringify(body.errors),
      ]
        .filter((s) => s !== "")
        .join(" ");
    } catch {
      detail = text;
    }
  } catch {
    // 本文なし
  }
  detail = detail.slice(0, MAX_DETAIL);
  const ra = Number(res.headers.get("retry-after"));
  const retryAfterMs = Number.isFinite(ra) && ra > 0 ? Math.ceil(ra * 1000) : undefined;
  const rateLimited =
    res.status === 429 ||
    (res.status === 403 &&
      (res.headers.get("x-ratelimit-remaining") === "0" ||
        res.headers.get("retry-after") !== null ||
        /rate limit/i.test(detail)));
  throw new GitHubApiError({ status: res.status, retryAfterMs, rateLimited, detail, what });
}

function b64urlBytes(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

const b64urlText = (s: string) => b64urlBytes(new TextEncoder().encode(s));

/**
 * GITHUB_APP_PRIVATE_KEY（PKCS#8 の PEM）を署名用の鍵にする。
 * 改行が "\n" の文字列になっていても、ヘッダーなしの base64 でも読める。
 * GitHub がダウンロードさせる PKCS#1 は拒否し、変換手順を示す。
 */
export async function parsePrivateKey(raw: string): Promise<CryptoKey> {
  const text = raw.replace(/\\n/g, "\n").trim();
  if (text.includes("BEGIN RSA PRIVATE KEY")) {
    throw new Error(
      "GITHUB_APP_PRIVATE_KEY is PKCS#1; convert it to PKCS#8: openssl pkcs8 -topk8 -nocrypt -in key.pem",
    );
  }
  const b64 = text.replace(/-----[^-]+-----/g, "").replace(/\s+/g, "");
  let der: Uint8Array;
  try {
    der = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  } catch {
    throw new Error("GITHUB_APP_PRIVATE_KEY is not valid PEM/base64");
  }
  try {
    return await crypto.subtle.importKey(
      "pkcs8",
      der as BufferSource,
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
      false,
      ["sign"],
    );
  } catch {
    throw new Error("GITHUB_APP_PRIVATE_KEY is not a valid PKCS#8 RSA private key");
  }
}

/** App の JWT（RS256）。iat は時計ずれ対策で 60 秒前、exp は 9 分後（上限 10 分）。 */
export async function createAppJwt(args: {
  appId: string;
  key: CryptoKey;
  nowMs: number;
}): Promise<string> {
  const nowSec = Math.floor(args.nowMs / 1000);
  const header = b64urlText(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const payload = b64urlText(
    JSON.stringify({ iat: nowSec - 60, exp: nowSec + 540, iss: args.appId }),
  );
  const sig = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    args.key,
    new TextEncoder().encode(`${header}.${payload}`),
  );
  return `${header}.${payload}.${b64urlBytes(new Uint8Array(sig))}`;
}

/** commit の作者（name / email） */
export interface BotAuthor {
  name: string;
  email: string;
}

/**
 * bot の id が引けなかったときの作者。`.invalid` は RFC 2606 の予約で、GitHub のどのアカウントにも結び付かない。
 * users.noreply.github.com の、名前だけで bot の id が付かない形は、その名前の他人のアカウントの commit とみなされるので使わない。
 */
export const FALLBACK_COMMIT_IDENTITY: BotAuthor = {
  name: "rovo",
  email: "rovo@noreply.invalid",
};

/** GitHub App の bot の正式な作者: name `<slug>[bot]`、email `<bot_user_id>+<slug>[bot]@users.noreply.github.com`。 */
export function botIdentity(slug: string, botUserId: number): BotAuthor {
  return {
    name: `${slug}[bot]`,
    email: `${botUserId}+${slug}[bot]@users.noreply.github.com`,
  };
}

export interface InstallationToken {
  token: string;
  /** epoch ms */
  expiresAt: number;
}

export interface GitHubAppClientOptions {
  appId: string;
  /** PKCS#8 の PEM */
  privateKey: string;
  apiBase?: string;
  fetch?: typeof fetch;
  now?: () => number;
}

/** App 自身（JWT）としての呼び出し: Installation Token の発行と失効。 */
export class GitHubAppClient {
  private readonly appId: string;
  private readonly privateKey: string;
  private readonly apiBase: string;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private key: Promise<CryptoKey> | undefined;

  constructor(opts: GitHubAppClientOptions) {
    this.appId = opts.appId;
    this.privateKey = opts.privateKey;
    this.apiBase = (opts.apiBase ?? DEFAULT_GITHUB_API_BASE).replace(/\/+$/, "");
    this.fetchImpl = opts.fetch ?? ((...a) => fetch(...a));
    this.now = opts.now ?? Date.now;
  }

  private async send(what: string, url: string, init: RequestInit): Promise<Response> {
    try {
      return await this.fetchImpl(url, init);
    } catch {
      throw new GitHubApiError({ status: 0, what });
    }
  }

  /** repository_ids を 1 件に絞り、contents:write / pull_requests:write / metadata:read だけの token を発行する。 */
  async createInstallationToken(
    installationId: number,
    repositoryId: number,
  ): Promise<InstallationToken> {
    this.key ??= parsePrivateKey(this.privateKey);
    const jwt = await createAppJwt({
      appId: this.appId,
      key: await this.key,
      nowMs: this.now(),
    });
    const what = "create installation token";
    const res = await this.send(
      what,
      `${this.apiBase}/app/installations/${installationId}/access_tokens`,
      {
        method: "POST",
        headers: {
          accept: "application/vnd.github+json",
          authorization: `Bearer ${jwt}`,
          "content-type": "application/json",
          "x-github-api-version": "2022-11-28",
          "user-agent": "rovo-gateway",
        },
        body: JSON.stringify({
          repository_ids: [repositoryId],
          permissions: { contents: "write", pull_requests: "write", metadata: "read" },
        }),
      },
    );
    if (!res.ok) return throwApiError(res, what);
    let body: { token?: unknown; expires_at?: unknown };
    try {
      body = (await res.json()) as typeof body;
    } catch {
      throw new GitHubApiError({ status: res.status, what, detail: "non-JSON response" });
    }
    const expiresAt =
      typeof body.expires_at === "string" ? Date.parse(body.expires_at) : Number.NaN;
    if (typeof body.token !== "string" || body.token === "" || !Number.isFinite(expiresAt)) {
      throw new GitHubApiError({ status: res.status, what, detail: "unexpected response" });
    }
    return { token: body.token, expiresAt };
  }

  /**
   * この App の bot の作者。GET /app（App の JWT）で slug を、GET /users/<slug>[bot] で bot ユーザーの id を引く。
   * 引けない・形が不正なら例外（呼び出し側が FALLBACK_COMMIT_IDENTITY にする）。
   */
  async getBotIdentity(): Promise<BotAuthor> {
    this.key ??= parsePrivateKey(this.privateKey);
    const jwt = await createAppJwt({
      appId: this.appId,
      key: await this.key,
      nowMs: this.now(),
    });
    const headers = {
      accept: "application/vnd.github+json",
      "x-github-api-version": "2022-11-28",
      "user-agent": "rovo-gateway",
    };
    const readJson = async (res: Response, what: string): Promise<Record<string, unknown>> => {
      if (!res.ok) return throwApiError(res, what);
      try {
        return (await res.json()) as Record<string, unknown>;
      } catch {
        throw new GitHubApiError({ status: res.status, what, detail: "non-JSON response" });
      }
    };
    const appWhat = "get app";
    const app = await readJson(
      await this.send(appWhat, `${this.apiBase}/app`, {
        headers: { ...headers, authorization: `Bearer ${jwt}` },
      }),
      appWhat,
    );
    const slug = app.slug;
    // slug は URL とメールに入るので、GitHub の slug の形（英数字とハイフン）だけを通す
    if (typeof slug !== "string" || !/^[A-Za-z0-9][A-Za-z0-9-]{0,99}$/.test(slug)) {
      throw new GitHubApiError({ status: 200, what: appWhat, detail: "unexpected slug" });
    }
    const userWhat = "get bot user";
    const user = await readJson(
      await this.send(userWhat, `${this.apiBase}/users/${encodeURIComponent(`${slug}[bot]`)}`, {
        headers,
      }),
      userWhat,
    );
    const id = user.id;
    if (typeof id !== "number" || !Number.isSafeInteger(id) || id <= 0) {
      throw new GitHubApiError({ status: 200, what: userWhat, detail: "unexpected id" });
    }
    return botIdentity(slug, id);
  }

  /** DELETE /installation/token。既に無効（401）も成功として扱う（冪等）。 */
  async revokeInstallationToken(token: string): Promise<void> {
    const what = "revoke installation token";
    const res = await this.send(what, `${this.apiBase}/installation/token`, {
      method: "DELETE",
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${token}`,
        "x-github-api-version": "2022-11-28",
        "user-agent": "rovo-gateway",
      },
    });
    if (res.ok || res.status === 401) {
      await res.body?.cancel();
      return;
    }
    return throwApiError(res, what);
  }
}
