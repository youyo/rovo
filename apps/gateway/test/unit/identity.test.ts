import { env as workerEnv } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { readWorkerAudit } from "../../src/audit-sink";
import { loadConfig, verifyIdentity } from "../../src/auth/identity";
import { json, routerFetch, tokenResponse } from "./github/helpers";
import { clearWorkerAudit, newUserId } from "./helpers";

// MCP（caller: parent）とダッシュボード（caller: dashboard）が同じ身元確認の関数を通ることを固定する（D2）。
// 許可ルールの判定が 2 か所でずれないこと、監査の差は caller だけであること。

const env = { ...workerEnv, ENVIRONMENT: "test" } as unknown as Env;

type Scenario = {
  name: string;
  team: "active" | "none";
  tokenError?: string;
  tokenStatus?: number;
};

const SCENARIOS: Scenario[] = [
  { name: "許可される（team の active メンバー）", team: "active" },
  { name: "許可ルール外（team のメンバーではない）", team: "none" },
  { name: "GitHub が code を拒否する", team: "active", tokenError: "bad_verification_code" },
  { name: "GitHub の一時的な障害", team: "active", tokenStatus: 503 },
];

function githubFetch(s: Scenario, id: number, login: string) {
  return routerFetch({
    "POST /login/oauth/access_token": () =>
      s.tokenError
        ? json({ error: s.tokenError })
        : s.tokenStatus
          ? json({ message: "x" }, { status: s.tokenStatus })
          : tokenResponse(),
    "GET /user": () => json({ id, login }),
    [`GET /orgs/acme/teams/core/memberships/${login}`]: () =>
      s.team === "none"
        ? json({ message: "Not Found" }, { status: 404 })
        : json({ state: "active" }),
  });
}

async function run(s: Scenario, caller: "parent" | "dashboard") {
  await clearWorkerAudit();
  const id = newUserId();
  const login = `ident-${id}`;
  const config = loadConfig(env, { fetch: githubFetch(s, id, login).fetch });
  if (!config) throw new Error("config");
  const result = await verifyIdentity(env, config, "code", caller);
  const audit = (await readWorkerAudit(env)).map(({ ts: _ts, userId, ...rest }) => ({
    ...rest,
    userId: userId === undefined ? undefined : "user",
  }));
  // 成功時だけ ID と login が入る。ID は利用者ごとに違うので比較から外す
  const normalized = result.ok ? { ok: true as const, login: result.user.login === login } : result;
  return { result: normalized, audit };
}

beforeEach(async () => {
  await clearWorkerAudit();
});

describe("verifyIdentity（MCP とダッシュボードの共通の身元確認）", () => {
  for (const s of SCENARIOS) {
    it(`${s.name}: parent と dashboard で結果が同じで、監査の差は caller だけ`, async () => {
      const parent = await run(s, "parent");
      const dashboard = await run(s, "dashboard");
      expect(dashboard.result).toEqual(parent.result);
      expect(dashboard.audit.map((r) => ({ ...r, caller: "x" }))).toEqual(
        parent.audit.map((r) => ({ ...r, caller: "x" })),
      );
      for (const r of parent.audit) expect(r.caller).toBe("parent");
      for (const r of dashboard.audit) expect(r.caller).toBe("dashboard");
    });
  }

  it("結果の種類: 許可 / 拒否 / 拒否 / 一時障害", async () => {
    expect((await run(SCENARIOS[0] as Scenario, "dashboard")).result).toEqual({
      ok: true,
      login: true,
    });
    expect((await run(SCENARIOS[1] as Scenario, "dashboard")).result).toEqual({
      ok: false,
      kind: "denied",
    });
    expect((await run(SCENARIOS[2] as Scenario, "dashboard")).result).toEqual({
      ok: false,
      kind: "denied",
    });
    expect((await run(SCENARIOS[3] as Scenario, "dashboard")).result).toEqual({
      ok: false,
      kind: "unavailable",
    });
  });

  it("許可外・拒否・障害のいずれでも資格を保存しない（成功だけが保存する）", async () => {
    const { userStub } = await import("./helpers");
    for (const s of SCENARIOS) {
      const id = newUserId();
      const login = `ident-${id}`;
      const config = loadConfig(env, { fetch: githubFetch(s, id, login).fetch });
      if (!config) throw new Error("config");
      const result = await verifyIdentity(env, config, "code", "dashboard");
      const { runInDurableObject } = await import("cloudflare:test");
      const rows = await runInDurableObject(
        userStub(id),
        (_i, state) =>
          state.storage.sql
            .exec("SELECT generation FROM github_credential WHERE singleton = 1")
            .toArray() as { generation: number }[],
      );
      expect(rows[0]?.generation, s.name).toBe(result.ok ? 1 : 0);
    }
  });
});

describe("verifyIdentity: org だけの許可ルール", () => {
  const ORG_ONLY = { ...env, ALLOWED_ORG: "acme", ALLOWED_TEAM: "" } as unknown as Env;
  const TEAM_ONLY = { ...env, ALLOWED_ORG: "", ALLOWED_TEAM: "core" } as unknown as Env;

  function orgFetch(orgResponse: () => Response, id: number, login: string) {
    return routerFetch({
      "POST /login/oauth/access_token": () => tokenResponse(),
      "GET /user": () => json({ id, login }),
      "GET /user/memberships/orgs/acme": orgResponse,
      // team の確認に落ちたら、この応答で通ってしまうので検出できる
      [`GET /orgs/acme/teams/core/memberships/${login}`]: () => json({ state: "active" }),
    });
  }
  async function go(e: Env, orgResponse: () => Response) {
    await clearWorkerAudit();
    const id = newUserId();
    const login = `ident-${id}`;
    const config = loadConfig(e, { fetch: orgFetch(orgResponse, id, login).fetch });
    if (!config) throw new Error("config");
    const result = await verifyIdentity(e, config, "code", "dashboard");
    return { result, audit: await readWorkerAudit(e) };
  }

  it("org の active メンバーは許可", async () => {
    const r = await go(ORG_ONLY, () => json({ state: "active" }));
    expect(r.result.ok).toBe(true);
  });
  it.each(["pending"] as const)("org が %s なら拒否（not_team_member を監査）", async (state) => {
    const r = await go(ORG_ONLY, () => json({ state }));
    expect(r.result).toEqual({ ok: false, kind: "denied" });
    expect(r.audit.map((a) => a.reason)).toContain("not_team_member");
  });
  it("404（所属していない）は拒否", async () => {
    const r = await go(ORG_ONLY, () => json({ message: "Not Found" }, { status: 404 }));
    expect(r.result).toEqual({ ok: false, kind: "denied" });
    expect(r.audit.map((a) => a.reason)).toContain("not_team_member");
  });
  it("403 は所属なしと偽らず拒否（資格は保存しない）", async () => {
    const r = await go(ORG_ONLY, () => json({ message: "Forbidden" }, { status: 403 }));
    expect(r.result).toEqual({ ok: false, kind: "denied" });
  });
  it("5xx は unavailable", async () => {
    const r = await go(ORG_ONLY, () => json({ message: "x" }, { status: 503 }));
    expect(r.result).toEqual({ ok: false, kind: "unavailable" });
  });
  it("team だけの設定は設定の誤りで、loadConfig が null（org の確認に落ちない）", () => {
    expect(
      loadConfig(TEAM_ONLY, { fetch: (async () => json({})) as unknown as typeof fetch }),
    ).toBeNull();
  });
});
