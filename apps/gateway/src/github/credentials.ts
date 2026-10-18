import { GitHubError, type TokenSet } from "./client";
import { decryptString, encryptString, importEncryptionKey } from "./crypto";

/** UserDO の github_credential 1 行に対応する。トークンは暗号文のみ。 */
export interface StoredCredential {
  accessTokenEnc: string;
  refreshTokenEnc: string | null;
  accessExpiresAt: number | null;
  refreshExpiresAt: number | null;
  version: number;
  updatedAt: number;
}

type MaybePromise<T> = T | Promise<T>;

export interface CredentialStorage {
  get(): MaybePromise<StoredCredential | null>;
  put(value: StoredCredential): MaybePromise<void>;
  delete(): MaybePromise<void>;
}

export interface RefreshClient {
  refreshToken(refreshToken: string): Promise<TokenSet>;
}

export interface CredentialManagerOptions {
  storage: CredentialStorage;
  /** TOKEN_ENC_KEY（base64 の 32 バイト） */
  encryptionKey: string;
  client: RefreshClient;
  now?: () => number;
  /** 残りがこれ未満なら更新する（既定 5 分） */
  refreshSkewMs?: number;
}

const DEFAULT_SKEW_MS = 5 * 60_000;

export class CredentialManager {
  private readonly storage: CredentialStorage;
  private readonly client: RefreshClient;
  private readonly now: () => number;
  private readonly skew: number;
  private readonly keyPromise: Promise<CryptoKey>;
  private inflight: Promise<string> | null = null;

  constructor(opts: CredentialManagerOptions) {
    this.storage = opts.storage;
    this.client = opts.client;
    this.now = opts.now ?? Date.now;
    this.skew = opts.refreshSkewMs ?? DEFAULT_SKEW_MS;
    this.keyPromise = importEncryptionKey(opts.encryptionKey);
    // 鍵が不正でも、使われるまで unhandled rejection にしない
    this.keyPromise.catch(() => {});
  }

  /** ログイン（または再ログイン）で得た資格を保存する。既存を上書きし version を進める。 */
  async save(tokens: TokenSet): Promise<void> {
    const current = await this.storage.get();
    await this.write(tokens, (current?.version ?? 0) + 1);
  }

  async clear(): Promise<void> {
    await this.storage.delete();
  }

  /** 有効な access token を返す。期限切れ・残り 5 分未満ならリフレッシュする。 */
  async getToken(): Promise<string> {
    const cred = await this.storage.get();
    if (!cred) throw new GitHubError("reauth_required", "no GitHub credential");
    if (cred.accessExpiresAt === null || cred.accessExpiresAt - this.now() >= this.skew) {
      return this.decrypt(cred.accessTokenEnc, "access");
    }
    return this.refresh();
  }

  /**
   * fn に access token を渡して実行する。fn が reauth_required（GitHub の 401）を投げたら、
   * 1 回だけ強制リフレッシュして再試行する。
   */
  async withToken<T>(fn: (accessToken: string) => Promise<T>): Promise<T> {
    const token = await this.getToken();
    try {
      return await fn(token);
    } catch (e) {
      if (!(e instanceof GitHubError) || e.code !== "reauth_required") throw e;
      const fresh = await this.forceRefresh(token);
      return fn(fresh);
    }
  }

  // ---- 内部 ----

  /** 401 を受けたトークンが既に入れ替わっていれば、それを使う。そうでなければ強制リフレッシュ。 */
  private async forceRefresh(failedToken: string): Promise<string> {
    if (this.inflight) return this.inflight;
    const cred = await this.storage.get();
    if (!cred) throw new GitHubError("reauth_required", "no GitHub credential");
    const stored = await this.decrypt(cred.accessTokenEnc, "access");
    if (stored !== failedToken) return stored;
    return this.refresh();
  }

  private refresh(): Promise<string> {
    if (this.inflight) return this.inflight;
    const p = this.doRefresh().finally(() => {
      if (this.inflight === p) this.inflight = null;
    });
    this.inflight = p;
    return p;
  }

  private async doRefresh(): Promise<string> {
    const cred = await this.storage.get();
    if (!cred) throw new GitHubError("reauth_required", "no GitHub credential");
    const startVersion = cred.version;

    const refreshExpired = cred.refreshExpiresAt !== null && cred.refreshExpiresAt <= this.now();
    if (cred.refreshTokenEnc === null || refreshExpired) {
      await this.deleteIfVersion(startVersion);
      throw new GitHubError("reauth_required", "GitHub refresh token unavailable or expired");
    }
    const refreshToken = await this.decrypt(cred.refreshTokenEnc, "refresh");

    let next: TokenSet;
    try {
      next = await this.client.refreshToken(refreshToken);
    } catch (e) {
      if (e instanceof GitHubError && e.code === "reauth_required") {
        const latest = await this.storage.get();
        // 更新中に再ログインされていたら、新しい資格を守って、それを返す
        if (latest && latest.version !== startVersion) {
          return this.decrypt(latest.accessTokenEnc, "access");
        }
        await this.storage.delete();
      }
      throw e;
    }

    // 旧 refresh token は使用済み。新しい資格を最優先で保存する。
    // ただし更新中に再ログインされていたら（version が変わっていたら）そちらが勝つ。
    const latest = await this.storage.get();
    if (latest && latest.version !== startVersion) {
      return this.decrypt(latest.accessTokenEnc, "access");
    }
    await this.write(next, startVersion + 1);
    return next.accessToken;
  }

  private async deleteIfVersion(version: number): Promise<void> {
    const latest = await this.storage.get();
    if (latest && latest.version === version) await this.storage.delete();
  }

  private async write(tokens: TokenSet, version: number): Promise<void> {
    const key = await this.keyPromise;
    await this.storage.put({
      accessTokenEnc: await encryptString(key, tokens.accessToken, "access"),
      refreshTokenEnc:
        tokens.refreshToken === null
          ? null
          : await encryptString(key, tokens.refreshToken, "refresh"),
      accessExpiresAt: tokens.accessExpiresAt,
      refreshExpiresAt: tokens.refreshExpiresAt,
      version,
      updatedAt: this.now(),
    });
  }

  private async decrypt(enc: string, aad: "access" | "refresh"): Promise<string> {
    return decryptString(await this.keyPromise, enc, aad);
  }
}
