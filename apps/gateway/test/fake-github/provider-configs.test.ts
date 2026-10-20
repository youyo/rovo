import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FAKE_CLOUDFLARE_TOKEN, type FakeGitHub, startFakeGitHub } from "./server";

// D10b: 偽の Cloudflare API（List provider keys）。gateway の E2E がキーの有無・失敗を切り替えるために使う。

let gh: FakeGitHub;
beforeEach(async () => {
  gh = await startFakeGitHub();
});
afterEach(async () => {
  await gh.stop();
});

const PATH = "/client/v4/accounts/acct/ai-gateway/gateways/gw/provider_configs";
const get = (query = "", token: string | null = FAKE_CLOUDFLARE_TOKEN) =>
  fetch(`${gh.url}${PATH}${query}`, {
    headers: token === null ? {} : { authorization: `Bearer ${token}` },
  });
async function admin(command: string, body: unknown = {}) {
  const res = await fetch(`${gh.url}/__admin/${command}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  expect(res.status).toBe(200);
}

describe("偽の Cloudflare API: provider_configs", () => {
  it("既定は anthropic と openai の default キー。応答の形は {success, result: [{provider_slug, alias, ...}]}", async () => {
    const res = await get("?page=1&per_page=100");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      success: boolean;
      result: { provider_slug: string; alias: string; default_config: boolean }[];
    };
    expect(body.success).toBe(true);
    expect(body.result.map((r) => [r.provider_slug, r.alias])).toEqual([
      ["anthropic", "default"],
      ["openai", "default"],
    ]);
  });

  it("トークンが違う・無いと 401（success: false）", async () => {
    expect((await get("", "wrong")).status).toBe(401);
    expect((await get("", null)).status).toBe(401);
  });

  it("admin で一覧を差し替えられ、reset で既定に戻る", async () => {
    await admin("provider-keys", { keys: [{ provider_slug: "anthropic", alias: "work" }] });
    const body = (await (await get()).json()) as { result: { alias: string }[] };
    expect(body.result.map((r) => r.alias)).toEqual(["work"]);
    await admin("reset");
    const again = (await (await get()).json()) as { result: unknown[] };
    expect(again.result).toHaveLength(2);
  });

  it("page / per_page でページングする", async () => {
    const keys = Array.from({ length: 3 }, (_, i) => ({
      provider_slug: `p${i}`,
      alias: "default",
    }));
    await admin("provider-keys", { keys });
    const p1 = (await (await get("?page=1&per_page=2")).json()) as {
      result: { provider_slug: string }[];
    };
    const p2 = (await (await get("?page=2&per_page=2")).json()) as {
      result: { provider_slug: string }[];
    };
    expect(p1.result.map((r) => r.provider_slug)).toEqual(["p0", "p1"]);
    expect(p2.result.map((r) => r.provider_slug)).toEqual(["p2"]);
  });

  it("fault（target: cloudflare）で失敗を返せる。呼び出しは記録される（token は記録しない）", async () => {
    await admin("fault", { target: "cloudflare", status: 500, count: 1 });
    expect((await get()).status).toBe(500);
    expect((await get()).status).toBe(200);
    const res = await fetch(`${gh.url}/__admin/requests`, { method: "POST" });
    const { requests } = (await res.json()) as { requests: { path: string }[] };
    expect(requests.filter((r) => r.path === PATH)).toHaveLength(2);
    expect(JSON.stringify(requests)).not.toContain(FAKE_CLOUDFLARE_TOKEN);
  });
});
