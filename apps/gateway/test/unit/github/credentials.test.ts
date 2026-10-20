import { describe, expect, it, vi } from "vitest";
import { GitHubError, type TokenSet } from "../../../src/github/client";
import {
  CredentialManager,
  type CredentialStorage,
  type RefreshClient,
  type StoredCredential,
} from "../../../src/github/credentials";

const KEY_B64 = btoa(String.fromCharCode(...new Uint8Array(32).fill(3)));
const T0 = 1_700_000_000_000;
const MIN = 60_000;
const HOUR = 60 * MIN;

class MemoryStorage implements CredentialStorage {
  value: StoredCredential | null = null;
  generation = 0;
  async get() {
    return {
      generation: this.generation,
      credential: this.value ? structuredClone(this.value) : null,
    };
  }
  async compareAndPut(expected: number, v: StoredCredential | null) {
    if (expected !== this.generation) return false;
    this.value = v ? structuredClone(v) : null;
    this.generation += 1;
    return true;
  }
}

function tokens(over: Partial<TokenSet> = {}): TokenSet {
  return {
    accessToken: "acc-1",
    refreshToken: "ref-1",
    accessExpiresAt: T0 + 8 * HOUR,
    refreshExpiresAt: T0 + 180 * 24 * HOUR,
    ...over,
  };
}

function setup(opts: { refresh?: RefreshClient["refreshToken"] } = {}) {
  const storage = new MemoryStorage();
  let now = T0;
  const refreshToken = vi.fn(
    opts.refresh ??
      (async (rt: string): Promise<TokenSet> => ({
        accessToken: `acc-after-${rt}`,
        refreshToken: `ref-after-${rt}`,
        accessExpiresAt: now + 8 * HOUR,
        refreshExpiresAt: now + 180 * 24 * HOUR,
      })),
  );
  const mgr = new CredentialManager({
    storage,
    encryptionKey: KEY_B64,
    client: { refreshToken },
    now: () => now,
  });
  return {
    storage,
    mgr,
    refreshToken,
    advance(ms: number) {
      now += ms;
    },
  };
}

async function codeOf(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    if (e instanceof GitHubError) return e.code;
    throw e;
  }
  return "no-error";
}

describe("save / 暗号化", () => {
  it("保存されるのは暗号文のみで、平文のトークンが含まれない", async () => {
    const { mgr, storage } = setup();
    await mgr.save(tokens({ accessToken: "ghu_PLAINACCESS", refreshToken: "ghr_PLAINREFRESH" }));
    const raw = JSON.stringify(storage.value);
    expect(raw).not.toContain("PLAINACCESS");
    expect(raw).not.toContain("PLAINREFRESH");
    expect(storage.value?.version).toBe(1);
    expect(await mgr.getToken()).toBe("ghu_PLAINACCESS");
  });

  it("別の鍵のマネージャでは読めない", async () => {
    const { mgr, storage } = setup();
    await mgr.save(tokens());
    const other = new CredentialManager({
      storage,
      encryptionKey: btoa(String.fromCharCode(...new Uint8Array(32).fill(4))),
      client: { refreshToken: vi.fn() },
      now: () => T0,
    });
    await expect(other.getToken()).rejects.toThrow();
  });

  it("再ログインは既存の資格を上書きし、version が増える（新しいものが勝つ）", async () => {
    const { mgr, storage } = setup();
    await mgr.save(tokens({ accessToken: "old", refreshToken: "old-r" }));
    await mgr.save(tokens({ accessToken: "new", refreshToken: "new-r" }));
    expect(await mgr.getToken()).toBe("new");
    expect(storage.value?.version).toBe(2);
    expect(JSON.stringify(storage.value)).not.toContain("old");
  });

  it("資格が無ければ reauth_required", async () => {
    const { mgr } = setup();
    expect(await codeOf(mgr.getToken())).toBe("reauth_required");
  });

  it("clear() で資格を消せる", async () => {
    const { mgr, storage } = setup();
    await mgr.save(tokens());
    await mgr.clear();
    expect(storage.value).toBeNull();
  });
});

describe("getToken", () => {
  it("有効期限に余裕があればリフレッシュしない", async () => {
    const { mgr, refreshToken, advance } = setup();
    await mgr.save(tokens());
    advance(HOUR);
    expect(await mgr.getToken()).toBe("acc-1");
    expect(refreshToken).not.toHaveBeenCalled();
  });

  it("期限切れならリフレッシュして新しいトークンを返し、保存する", async () => {
    const { mgr, refreshToken, advance, storage } = setup();
    await mgr.save(tokens());
    advance(9 * HOUR);
    expect(await mgr.getToken()).toBe("acc-after-ref-1");
    expect(refreshToken).toHaveBeenCalledTimes(1);
    expect(refreshToken).toHaveBeenCalledWith("ref-1");
    expect(storage.value?.version).toBe(2);
    // 次回は新しい資格で動く（旧トークンは使われない）
    expect(await mgr.getToken()).toBe("acc-after-ref-1");
    expect(refreshToken).toHaveBeenCalledTimes(1);
  });

  it("残り 5 分未満でもリフレッシュする。ちょうど 5 分は更新しない", async () => {
    const a = setup();
    await a.mgr.save(tokens({ accessExpiresAt: T0 + 5 * MIN - 1 }));
    expect(await a.mgr.getToken()).toBe("acc-after-ref-1");
    const b = setup();
    await b.mgr.save(tokens({ accessExpiresAt: T0 + 5 * MIN }));
    expect(await b.mgr.getToken()).toBe("acc-1");
    expect(b.refreshToken).not.toHaveBeenCalled();
  });

  it("リフレッシュ後は旧 refresh token を二度と使わない", async () => {
    const { mgr, refreshToken, advance } = setup();
    await mgr.save(tokens());
    advance(9 * HOUR);
    await mgr.getToken();
    advance(9 * HOUR);
    await mgr.getToken();
    expect(refreshToken.mock.calls.map((c) => c[0])).toEqual(["ref-1", "ref-after-ref-1"]);
  });

  it("期限なしトークンはリフレッシュしない", async () => {
    const { mgr, refreshToken, advance } = setup();
    await mgr.save(tokens({ accessExpiresAt: null, refreshToken: null, refreshExpiresAt: null }));
    advance(1000 * HOUR);
    expect(await mgr.getToken()).toBe("acc-1");
    expect(refreshToken).not.toHaveBeenCalled();
  });

  it("single-flight: 同時に呼んでもリフレッシュは 1 回で、全員が同じ新トークンを得る", async () => {
    let release: (t: TokenSet) => void = () => {};
    const gate = new Promise<TokenSet>((r) => {
      release = r;
    });
    const { mgr, refreshToken, advance } = setup({ refresh: async () => gate });
    await mgr.save(tokens());
    advance(9 * HOUR);
    const calls = [mgr.getToken(), mgr.getToken(), mgr.getToken(), mgr.getToken()];
    await Promise.resolve();
    release(tokens({ accessToken: "fresh", refreshToken: "fresh-r" }));
    expect(await Promise.all(calls)).toEqual(["fresh", "fresh", "fresh", "fresh"]);
    expect(refreshToken).toHaveBeenCalledTimes(1);
  });

  it("リフレッシュ失敗後は in-flight が片付き、次の呼び出しで再試行できる", async () => {
    let n = 0;
    const { mgr, refreshToken, advance } = setup({
      refresh: async () => {
        n++;
        if (n === 1) throw new GitHubError("upstream_unavailable", "down", 503);
        return tokens({ accessToken: "recovered" });
      },
    });
    await mgr.save(tokens());
    advance(9 * HOUR);
    expect(await codeOf(mgr.getToken())).toBe("upstream_unavailable");
    expect(await mgr.getToken()).toBe("recovered");
    expect(refreshToken).toHaveBeenCalledTimes(2);
  });

  it("bad_refresh_token 相当（reauth_required）なら資格を消して reauth_required", async () => {
    const { mgr, storage, advance } = setup({
      refresh: async () => {
        throw new GitHubError("reauth_required", "bad_refresh_token");
      },
    });
    await mgr.save(tokens());
    advance(9 * HOUR);
    expect(await codeOf(mgr.getToken())).toBe("reauth_required");
    expect(storage.value).toBeNull();
    expect(await codeOf(mgr.getToken())).toBe("reauth_required");
  });

  it("5xx なら資格を残して upstream_unavailable", async () => {
    const { mgr, storage, advance } = setup({
      refresh: async () => {
        throw new GitHubError("upstream_unavailable", "503", 503);
      },
    });
    await mgr.save(tokens());
    const before = structuredClone(storage.value);
    advance(9 * HOUR);
    expect(await codeOf(mgr.getToken())).toBe("upstream_unavailable");
    expect(storage.value).toEqual(before);
  });

  it("refresh token の期限切れなら GitHub を呼ばずに資格を消して reauth_required", async () => {
    const { mgr, storage, refreshToken, advance } = setup();
    await mgr.save(tokens({ refreshExpiresAt: T0 + 9 * HOUR }));
    advance(10 * HOUR);
    expect(await codeOf(mgr.getToken())).toBe("reauth_required");
    expect(refreshToken).not.toHaveBeenCalled();
    expect(storage.value).toBeNull();
  });

  it("access が期限切れで refresh token が無ければ資格を消して reauth_required", async () => {
    const { mgr, storage, advance } = setup();
    await mgr.save(tokens({ refreshToken: null, refreshExpiresAt: null }));
    advance(9 * HOUR);
    expect(await codeOf(mgr.getToken())).toBe("reauth_required");
    expect(storage.value).toBeNull();
  });

  it("リフレッシュ中に再ログインされたら、新しいログインの資格が勝つ", async () => {
    let release: (t: TokenSet) => void = () => {};
    const gate = new Promise<TokenSet>((r) => {
      release = r;
    });
    const { mgr, advance } = setup({ refresh: async () => gate });
    await mgr.save(tokens());
    advance(9 * HOUR);
    const pending = mgr.getToken();
    await Promise.resolve();
    await mgr.save(
      tokens({
        accessToken: "relogin",
        refreshToken: "relogin-r",
        accessExpiresAt: T0 + 20 * HOUR,
      }),
    );
    release(tokens({ accessToken: "stale-refresh-result" }));
    expect(await pending).toBe("relogin");
    expect(await mgr.getToken()).toBe("relogin");
  });

  it("リフレッシュ中に再ログインされた後で旧リフレッシュが失効しても、新しい資格は消さない", async () => {
    let fail: (e: unknown) => void = () => {};
    const gate = new Promise<TokenSet>((_, rej) => {
      fail = rej;
    });
    const { mgr, storage, advance } = setup({ refresh: async () => gate });
    await mgr.save(tokens());
    advance(9 * HOUR);
    const pending = mgr.getToken();
    await Promise.resolve();
    await mgr.save(tokens({ accessToken: "relogin", accessExpiresAt: T0 + 20 * HOUR }));
    fail(new GitHubError("reauth_required", "bad_refresh_token"));
    expect(await pending).toBe("relogin");
    expect(storage.value).not.toBeNull();
  });

  it("古い資格を読んだ後に別の呼び出しがリフレッシュを終えても、GitHub へのリフレッシュ要求は 1 回だけ", async () => {
    const { mgr, storage, refreshToken, advance } = setup();
    await mgr.save(tokens());
    advance(9 * HOUR); // 期限切れ
    // 1 回目の get（呼び出し A の読み取り）だけ、古い値を返したあと解放を待つ
    const realGet = storage.get.bind(storage);
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    let n = 0;
    storage.get = async () => {
      const snapshot = await realGet();
      if (++n === 1) await gate;
      return snapshot;
    };
    const a = mgr.getToken(); // 古い資格を読んで保留
    const b = await mgr.getToken(); // 別の呼び出しがリフレッシュを完了する
    expect(refreshToken).toHaveBeenCalledTimes(1);
    release();
    expect(await a).toBe(b);
    expect(refreshToken).toHaveBeenCalledTimes(1);
  });
});

describe("withToken", () => {
  it("成功すればそのまま返す", async () => {
    const { mgr, refreshToken } = setup();
    await mgr.save(tokens());
    const fn = vi.fn(async (t: string) => `ok:${t}`);
    expect(await mgr.withToken(fn)).toBe("ok:acc-1");
    expect(fn).toHaveBeenCalledTimes(1);
    expect(refreshToken).not.toHaveBeenCalled();
  });

  it("401（reauth_required）なら 1 回だけ強制リフレッシュして再試行する", async () => {
    const { mgr, refreshToken } = setup();
    await mgr.save(tokens());
    const fn = vi.fn(async (t: string) => {
      if (t === "acc-1") throw new GitHubError("reauth_required", "401", 401);
      return `ok:${t}`;
    });
    expect(await mgr.withToken(fn)).toBe("ok:acc-after-ref-1");
    expect(fn).toHaveBeenCalledTimes(2);
    expect(refreshToken).toHaveBeenCalledTimes(1);
  });

  it("再試行でも 401 なら reauth_required。リフレッシュと再試行はそれ以上しない", async () => {
    const { mgr, refreshToken } = setup();
    await mgr.save(tokens());
    const fn = vi.fn(async () => {
      throw new GitHubError("reauth_required", "401", 401);
    });
    expect(await codeOf(mgr.withToken(fn))).toBe("reauth_required");
    expect(fn).toHaveBeenCalledTimes(2);
    expect(refreshToken).toHaveBeenCalledTimes(1);
  });

  it("401 以外のエラーは再試行せずそのまま投げる", async () => {
    const { mgr, refreshToken } = setup();
    await mgr.save(tokens());
    for (const code of ["forbidden", "upstream_unavailable"] as const) {
      const fn = vi.fn(async () => {
        throw new GitHubError(code, "x");
      });
      expect(await codeOf(mgr.withToken(fn))).toBe(code);
      expect(fn).toHaveBeenCalledTimes(1);
    }
    expect(refreshToken).not.toHaveBeenCalled();
  });

  it("401 後の強制リフレッシュが失効なら資格を消して reauth_required", async () => {
    const { mgr, storage } = setup({
      refresh: async () => {
        throw new GitHubError("reauth_required", "bad_refresh_token");
      },
    });
    await mgr.save(tokens());
    const fn = vi.fn(async () => {
      throw new GitHubError("reauth_required", "401", 401);
    });
    expect(await codeOf(mgr.withToken(fn))).toBe("reauth_required");
    expect(fn).toHaveBeenCalledTimes(1);
    expect(storage.value).toBeNull();
  });

  it("401 後の強制リフレッシュが 5xx なら資格を残して upstream_unavailable", async () => {
    const { mgr, storage } = setup({
      refresh: async () => {
        throw new GitHubError("upstream_unavailable", "503", 503);
      },
    });
    await mgr.save(tokens());
    const fn = vi.fn(async () => {
      throw new GitHubError("reauth_required", "401", 401);
    });
    expect(await codeOf(mgr.withToken(fn))).toBe("upstream_unavailable");
    expect(storage.value).not.toBeNull();
  });

  it("同時に 401 を受けた複数の呼び出しでもリフレッシュは 1 回（失敗トークンが既に入れ替わっていれば再利用）", async () => {
    const { mgr, refreshToken } = setup();
    await mgr.save(tokens());
    const fn = async (t: string) => {
      if (t === "acc-1") throw new GitHubError("reauth_required", "401", 401);
      return t;
    };
    const results = await Promise.all([mgr.withToken(fn), mgr.withToken(fn), mgr.withToken(fn)]);
    expect(results).toEqual(Array(3).fill("acc-after-ref-1"));
    expect(refreshToken).toHaveBeenCalledTimes(1);
  });
});

describe("世代の CAS（再ログイン・clear との競合）", () => {
  function deferred<T>() {
    let resolve: (v: T) => void = () => {};
    const promise = new Promise<T>((r) => {
      resolve = r;
    });
    return { promise, resolve };
  }
  const tick = () => new Promise((r) => setTimeout(r, 5));

  it("refresh 中に clear され、その後 refresh が成功しても資格は空のまま（reauth_required）", async () => {
    const gate = deferred<TokenSet>();
    const { mgr, storage, advance } = setup({ refresh: () => gate.promise });
    await mgr.save(tokens());
    advance(9 * HOUR);
    const pending = codeOf(mgr.getToken());
    await tick();
    await mgr.clear();
    gate.resolve(tokens({ accessToken: "stale-refresh-result" }));
    expect(await pending).toBe("reauth_required");
    expect(storage.value).toBeNull();
  });

  it("clear -> 再ログイン -> 古い refresh 成功の順でも、再ログインの資格が残る（ABA にならない）", async () => {
    const gate = deferred<TokenSet>();
    const { mgr, storage, advance } = setup({ refresh: () => gate.promise });
    await mgr.save(tokens());
    advance(9 * HOUR);
    const pending = mgr.getToken();
    await tick();
    await mgr.clear();
    await mgr.save(tokens({ accessToken: "relogin", accessExpiresAt: T0 + 20 * HOUR }));
    gate.resolve(tokens({ accessToken: "stale-refresh-result" }));
    expect(await pending).toBe("relogin");
    expect(await mgr.getToken()).toBe("relogin");
    expect(storage.value).not.toBeNull();
  });

  it("世代は単調増加で、削除でも進む", async () => {
    const { mgr, storage } = setup();
    await mgr.save(tokens());
    const g1 = storage.generation;
    await mgr.clear();
    expect(storage.generation).toBeGreaterThan(g1);
    await mgr.save(tokens());
    expect(storage.generation).toBeGreaterThan(g1 + 1);
  });

  it("refresh の結果の暗号化を待っている間に再ログインが完了しても、再ログインの資格が残る", async () => {
    const { mgr, storage, advance } = setup();
    await mgr.save(tokens());
    advance(9 * HOUR);
    // refresh 結果の暗号化（access の AES-GCM）を保留して、その間に再ログインを完了させる
    const hold = deferred<void>();
    let armed = false;
    const real = crypto.subtle.encrypt.bind(crypto.subtle);
    const spy = vi.spyOn(crypto.subtle, "encrypt").mockImplementation(async (...args) => {
      if (armed) {
        armed = false;
        await hold.promise;
      }
      return real(...(args as Parameters<typeof real>));
    });
    try {
      armed = true;
      const pending = mgr.getToken();
      await tick();
      expect(armed).toBe(false); // refresh が暗号化に入って保留されている
      spy.mockRestore();
      await mgr.save(tokens({ accessToken: "relogin", accessExpiresAt: T0 + 20 * HOUR }));
      hold.resolve();
      expect(await pending).toBe("relogin");
      expect(await mgr.getToken()).toBe("relogin");
      expect(storage.value).not.toBeNull();
    } finally {
      spy.mockRestore();
    }
  });
});

// ダッシュボードのログイン（saveCredential）と MCP の withToken（リフレッシュ）は、同じ資格を共用する（D4 の案 A）。
// 世代の CAS の勝ち負けで片方の結果が捨てられても、負けた側が勝った側の資格を使い、壊れた資格は残らないことを固定する。
describe("ダッシュボードのログインと MCP の withToken の競合（D4）", () => {
  function deferred<T>() {
    let resolve: (v: T) => void = () => {};
    let reject: (e: unknown) => void = () => {};
    const promise = new Promise<T>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    return { promise, resolve, reject };
  }
  const tick = () => new Promise((r) => setTimeout(r, 5));
  const dashLogin = (name: string) =>
    tokens({ accessToken: name, refreshToken: `${name}-ref`, accessExpiresAt: T0 + 30 * HOUR });

  it("MCP のリフレッシュ中にダッシュボードのログインが保存されたら、リフレッシュの結果は捨て、ログインの資格を使う", async () => {
    const gate = deferred<TokenSet>();
    const { mgr, storage, advance, refreshToken } = setup({ refresh: () => gate.promise });
    await mgr.save(tokens());
    advance(9 * HOUR);
    const used: string[] = [];
    const mcp = mgr.withToken(async (t) => {
      used.push(t);
      return t;
    });
    await tick();
    expect(refreshToken).toHaveBeenCalledTimes(1);
    const generationBefore = storage.generation;
    // ダッシュボードのログイン（サーバー側は同じ saveCredential）
    await mgr.save(dashLogin("dash-login"));
    gate.resolve(tokens({ accessToken: "stale-refresh-result", refreshToken: "stale-ref" }));
    expect(await mcp).toBe("dash-login");
    expect(used).toEqual(["dash-login"]);
    // 保存されているのはダッシュボードのログインの資格。リフレッシュの結果（使用済みの refresh token から得たもの）は残らない
    expect(await mgr.getToken()).toBe("dash-login");
    expect(storage.generation).toBe(generationBefore + 1); // リフレッシュの書き込みは世代が合わず捨てられた
  });

  it("ダッシュボードのログインが先に完了していれば、MCP は期限切れの資格をリフレッシュせずに新しい資格を使う", async () => {
    const { mgr, advance, refreshToken } = setup();
    await mgr.save(tokens());
    advance(9 * HOUR);
    await mgr.save(dashLogin("dash-login"));
    expect(await mgr.withToken(async (t) => t)).toBe("dash-login");
    expect(refreshToken).not.toHaveBeenCalled();
  });

  it("MCP のリフレッシュが先に完了し、そのあとのダッシュボードのログインが勝つ（新しいものが勝つ）", async () => {
    const { mgr, advance } = setup();
    await mgr.save(tokens());
    advance(9 * HOUR);
    expect(await mgr.getToken()).toMatch(/^acc-after-/);
    await mgr.save(dashLogin("dash-login"));
    expect(await mgr.getToken()).toBe("dash-login");
  });

  it("同時に走るリフレッシュと保存を何度繰り返しても、復号できる有効な資格が 1 つだけ残る", async () => {
    for (let i = 0; i < 5; i++) {
      const { mgr, storage, advance } = setup();
      await mgr.save(tokens());
      advance(9 * HOUR);
      const results = await Promise.all([
        mgr.withToken(async (t) => t),
        mgr.save(dashLogin(`dash-${i}`)),
        mgr.withToken(async (t) => t),
      ]);
      // 残るのは、リフレッシュの結果かダッシュボードのログインのどちらか一方で、復号できる
      const stored = await mgr.getToken();
      expect(stored === `dash-${i}` || stored.startsWith("acc-after-")).toBe(true);
      expect(storage.value).not.toBeNull();
      // 呼び出し側が受け取った token は、その時点で有効だったもの（壊れた値・空ではない）
      for (const r of [results[0], results[2]]) {
        expect(r === `dash-${i}` || String(r).startsWith("acc-after-")).toBe(true);
      }
    }
  });

  it("D4 のリスク: 一方の側でリフレッシュが失効（reauth_required）すると、資格を共用する他方も再ログインが必要になる", async () => {
    const { mgr, storage, advance } = setup({
      refresh: async () => {
        throw new GitHubError("reauth_required", "refresh token revoked");
      },
    });
    await mgr.save(tokens()); // ダッシュボードのログインで保存された資格
    advance(9 * HOUR);
    // 閲覧中のリフレッシュが失効 → 資格を消す
    expect(await codeOf(mgr.withToken(async (t) => t))).toBe("reauth_required");
    expect(storage.value).toBeNull();
    // MCP 側の次の呼び出しも再ログインが必要
    expect(await codeOf(mgr.getToken())).toBe("reauth_required");
    // 再ログイン（MCP でもダッシュボードでも）で両方が回復する
    await mgr.save(dashLogin("relogin"));
    expect(await mgr.getToken()).toBe("relogin");
  });

  it("失効の最中にダッシュボードのログインが保存されたら、失効の削除は世代が合わず、ログインの資格が残る", async () => {
    const gate = deferred<TokenSet>();
    const { mgr, storage, advance } = setup({ refresh: () => gate.promise });
    await mgr.save(tokens());
    advance(9 * HOUR);
    const mcp = mgr.withToken(async (t) => t);
    await tick();
    await mgr.save(dashLogin("dash-login"));
    gate.reject(new GitHubError("reauth_required", "refresh token revoked"));
    // 失効を受けた側は、ログイン後の資格を見て、それを使う（消さない）
    expect(await mcp).toBe("dash-login");
    expect(storage.value).not.toBeNull();
    expect(await mgr.getToken()).toBe("dash-login");
  });
});
