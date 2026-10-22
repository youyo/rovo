import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FAKE_CLOUDFLARE_TOKEN, type FakeGitHub, startFakeGitHub } from "./server";

// M9: 偽の Cloudflare API（GraphQL・クレジット残高）。gateway の E2E が権限なし・5xx を切り替えるために使う。

let gh: FakeGitHub;
beforeEach(async () => {
  gh = await startFakeGitHub();
});
afterEach(async () => {
  await gh.stop();
});

async function admin(command: string, body: unknown = {}) {
  const res = await fetch(`${gh.url}/__admin/${command}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  expect(res.status).toBe(200);
}
const auth = {
  authorization: `Bearer ${FAKE_CLOUDFLARE_TOKEN}`,
  "content-type": "application/json",
};
const gql = (query: string, accountTag = "e2e-account", headers: Record<string, string> = auth) =>
  fetch(`${gh.url}/client/v4/graphql`, {
    method: "POST",
    headers,
    body: JSON.stringify({ query, variables: { accountTag } }),
  });
const credit = (headers: Record<string, string> = auth) =>
  fetch(`${gh.url}/client/v4/accounts/e2e-account/ai-gateway/billing/credit-balance`, { headers });

const DATASETS: [string, string][] = [
  ["containersMetricsAdaptiveGroups", "containers"],
  ["workersInvocationsAdaptive", "workers"],
  ["aiGatewayRequestsAdaptiveGroups", "aiGateway"],
  ["aiInferenceAdaptiveGroups", "workersAi"],
];

describe("偽の Cloudflare API: 分析（M9）", () => {
  it("データセットごとに alias 付きの行を返す", async () => {
    for (const [dataset, alias] of DATASETS) {
      const res = await gql(
        `query { viewer { accounts { ${alias}: ${dataset}(limit: 1) { count } } } }`,
      );
      expect(res.status, dataset).toBe(200);
      const body = (await res.json()) as {
        data: { viewer: { accounts: Record<string, unknown[]>[] } };
        errors: unknown;
      };
      expect(Array.isArray(body.data.viewer.accounts[0]?.[alias]), dataset).toBe(true);
    }
  });

  it("トークンが違うと 401。アカウントが違う・forbidden に入れた項目は 200 + authz のエラー", async () => {
    expect((await gql("query { x: aiInferenceAdaptiveGroups }", "e2e-account", {})).status).toBe(
      401,
    );
    const wrongAccount = (await (
      await gql("query { x: aiInferenceAdaptiveGroups }", "other")
    ).json()) as {
      errors: { extensions: { code: string } }[];
    };
    expect(wrongAccount.errors[0]?.extensions.code).toBe("authz");
    await admin("cloudflare-forbidden", { items: ["workers"] });
    const denied = (await (
      await gql("query { workers: workersInvocationsAdaptive { sum { requests } } }")
    ).json()) as { errors: { extensions: { code: string } }[] };
    expect(denied.errors[0]?.extensions.code).toBe("authz");
    const other = await gql("query { containers: containersMetricsAdaptiveGroups { count } }");
    expect(((await other.json()) as { errors: unknown }).errors).toBeNull();
  });

  it("残高 API: 200 / 401 / forbidden は 403。fault（5xx）は GraphQL と共通", async () => {
    expect((await credit()).status).toBe(200);
    expect((await credit({})).status).toBe(401);
    await admin("cloudflare-forbidden", { items: ["credit"] });
    expect((await credit()).status).toBe(403);
    await admin("cloudflare-forbidden", { items: [] });
    await admin("fault", { target: "cloudflare", status: 503, count: 2 });
    expect((await credit()).status).toBe(503);
    expect((await gql("query { x: aiInferenceAdaptiveGroups }")).status).toBe(503);
    expect((await credit()).status).toBe(200);
  });
});
