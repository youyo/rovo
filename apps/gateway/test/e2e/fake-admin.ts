import type {
  FakeRepository,
  FaultTarget,
  RecordedRequest,
  TeamState,
} from "../fake-github/server";

/** 偽 GitHub の管理 API（POST {url}/__admin/<command>）の HTTP クライアント。 */
export function fakeGitHubAdmin(url: string) {
  async function post(command: string, body: Record<string, unknown> = {}) {
    const res = await fetch(`${url}/__admin/${command}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`fake github admin ${command}: ${res.status}`);
    return (await res.json()) as Record<string, unknown>;
  }
  return {
    reset: () => post("reset"),
    /** 追加したユーザーが「現在のユーザー」になる（/authorize でログインする人） */
    addUser: (user: { id: number; login: string }) => post("users", user),
    setCurrentUser: (login: string) => post("current-user", { login }),
    setTeam: (org: string, team: string, login: string, state: TeamState) =>
      post("teams", { org, team, login, state }),
    setInstallation: (id: number, repositories: FakeRepository[]) =>
      post("installations", { id, repositories }),
    expireAccessTokens: () => post("expire-access-tokens"),
    /** 偽の Cloudflare API（List provider keys）が返す、AI Gateway に BYOK 登録済みのキー（D10b。既定は anthropic と openai の default） */
    setProviderKeys: (keys: { provider_slug: string; alias: string }[]) =>
      post("provider-keys", { keys }),
    /** 偽の Cloudflare の分析 API（M9）で、権限が無い応答にする項目（containers / workers / aiGateway / workersAi / credit。空で解除） */
    setCloudflareForbidden: (items: string[]) => post("cloudflare-forbidden", { items }),
    revokeRefreshTokens: () => post("revoke-refresh-tokens"),
    setFault: (target: FaultTarget, status: number | null, count?: number) =>
      post("fault", { target, status, count }),
    /** 偽 GitHub の App API（FakeGitHubApp）のメソッドを呼ぶ */
    async app<T = unknown>(method: string, ...args: unknown[]): Promise<T> {
      return (await post("app", { method, args })).result as T;
    },
    async requests(): Promise<RecordedRequest[]> {
      return ((await post("requests")).requests ?? []) as RecordedRequest[];
    },
  };
}
export type FakeAdmin = ReturnType<typeof fakeGitHubAdmin>;
