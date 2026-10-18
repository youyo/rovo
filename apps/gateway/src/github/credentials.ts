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

/** 資格の現在値と世代。世代は単調増加で、削除（tombstone）でも進む。 */
export interface CredentialState {
  generation: number;
  credential: StoredCredential | null;
}

/**
 * 資格の保存先。書き込みはすべて世代の compare-and-set で行う。
 * compareAndPut は「世代が expectedGeneration と一致するときだけ」値（null なら削除）を書き、
 * 世代を 1 進めて true を返す。不一致なら何もせず false。比較と書き込みは原子的でなければならない
 * （UserDO では transactionSync の中で行う）。
 */
export interface CredentialStorage {
  get(): MaybePromise<CredentialState>;
  compareAndPut(expectedGeneration: number, value: StoredCredential | null): MaybePromise<boolean>;
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
const MAX_CAS_ATTEMPTS = 8;

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

  /**
   * ログイン（または再ログイン）で得た資格を保存する。既存を上書きし、世代を進める（新しいものが勝つ）。
   * 暗号化は先に済ませ、比較と書き込みは storage の原子的な compareAndPut に任せる。
   */
  async save(tokens: TokenSet): Promise<void> {
    const sealed = await this.seal(tokens);
    for (let i = 0; i < MAX_CAS_ATTEMPTS; i++) {
      const state = await this.storage.get();
      if (
        await this.storage.compareAndPut(state.generation, this.stamp(sealed, state.generation + 1))
      ) {
        return;
      }
    }
    throw new Error("could not store GitHub credential");
  }

  async clear(): Promise<void> {
    for (let i = 0; i < MAX_CAS_ATTEMPTS; i++) {
      const state = await this.storage.get();
      if (state.credential === null) return;
      if (await this.storage.compareAndPut(state.generation, null)) return;
    }
    throw new Error("could not clear GitHub credential");
  }

  /** 有効な access token を返す。期限切れ・残り 5 分未満ならリフレッシュする。 */
  async getToken(): Promise<string> {
    const { credential: cred } = await this.storage.get();
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
    const { credential: cred } = await this.storage.get();
    if (!cred) throw new GitHubError("reauth_required", "no GitHub credential");
    const stored = await this.decrypt(cred.accessTokenEnc, "access");
    if (stored !== failedToken) return stored;
    return this.refresh(failedToken);
  }

  private refresh(failedToken?: string): Promise<string> {
    if (this.inflight) return this.inflight;
    const p = this.doRefresh(failedToken).finally(() => {
      if (this.inflight === p) this.inflight = null;
    });
    this.inflight = p;
    return p;
  }

  /**
   * failedToken: GitHub に 401 とされたトークン（強制リフレッシュのとき）。
   * 冒頭で資格を読み直し、他の呼び出しが既に更新済みならそれを返す（二重リフレッシュの防止）。
   */
  private async doRefresh(failedToken?: string): Promise<string> {
    const start = await this.storage.get();
    const cred = start.credential;
    if (!cred) throw new GitHubError("reauth_required", "no GitHub credential");

    if (failedToken !== undefined) {
      const stored = await this.decrypt(cred.accessTokenEnc, "access");
      if (stored !== failedToken) return stored;
    } else if (cred.accessExpiresAt === null || cred.accessExpiresAt - this.now() >= this.skew) {
      return this.decrypt(cred.accessTokenEnc, "access");
    }

    const refreshExpired = cred.refreshExpiresAt !== null && cred.refreshExpiresAt <= this.now();
    if (cred.refreshTokenEnc === null || refreshExpired) {
      await this.storage.compareAndPut(start.generation, null);
      throw new GitHubError("reauth_required", "GitHub refresh token unavailable or expired");
    }
    const refreshToken = await this.decrypt(cred.refreshTokenEnc, "refresh");

    let next: TokenSet;
    try {
      next = await this.client.refreshToken(refreshToken);
    } catch (e) {
      if (e instanceof GitHubError && e.code === "reauth_required") {
        // 開始時の世代のままのときだけ消す。更新中に再ログイン / clear されていたら触らない。
        if (!(await this.storage.compareAndPut(start.generation, null))) {
          return this.currentAccessTokenOrReauth();
        }
      }
      throw e;
    }

    // 旧 refresh token は使用済み。暗号化を先に済ませ、開始時の世代に対する CAS で保存する。
    // 更新中に再ログイン・clear・別の更新があって世代が進んでいたら、この結果は捨てる。
    const sealed = await this.seal(next);
    if (
      await this.storage.compareAndPut(start.generation, this.stamp(sealed, start.generation + 1))
    ) {
      return next.accessToken;
    }
    return this.currentAccessTokenOrReauth();
  }

  /** CAS に負けたとき: 勝った側の資格を使う。資格が無ければ（clear された）再ログインが必要。 */
  private async currentAccessTokenOrReauth(): Promise<string> {
    const { credential } = await this.storage.get();
    if (!credential) throw new GitHubError("reauth_required", "no GitHub credential");
    return this.decrypt(credential.accessTokenEnc, "access");
  }

  private async seal(tokens: TokenSet): Promise<Omit<StoredCredential, "version" | "updatedAt">> {
    const key = await this.keyPromise;
    return {
      accessTokenEnc: await encryptString(key, tokens.accessToken, "access"),
      refreshTokenEnc:
        tokens.refreshToken === null
          ? null
          : await encryptString(key, tokens.refreshToken, "refresh"),
      accessExpiresAt: tokens.accessExpiresAt,
      refreshExpiresAt: tokens.refreshExpiresAt,
    };
  }

  private stamp(
    sealed: Omit<StoredCredential, "version" | "updatedAt">,
    version: number,
  ): StoredCredential {
    return { ...sealed, version, updatedAt: this.now() };
  }

  private async decrypt(enc: string, aad: "access" | "refresh"): Promise<string> {
    return decryptString(await this.keyPromise, enc, aad);
  }
}
