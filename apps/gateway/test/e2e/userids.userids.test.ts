import { beforeEach, describe, expect, it } from "vitest";
import {
  admin,
  auditRecords,
  baseUrl,
  bodyOf,
  installApp,
  login,
  ORG,
  startArgs,
  TEAM,
  waitForAudit,
} from "./helpers";
import { approveAtGitHub, beginLogin, callCallback } from "./oauth-client";
import { ALLOWED_ID, ALLOWED_ID_2, OUTSIDER_ID } from "./userids-constants";

// ALLOWED_USER_IDS だけの構成（vitest.e2e-userids.config.ts）。ALLOWED_ORG / ALLOWED_TEAM は空。

const allowed = { id: ALLOWED_ID, login: "id-allowed" };
const allowed2 = { id: ALLOWED_ID_2, login: "id-allowed-2" };
const outsider = { id: OUTSIDER_ID, login: "id-outsider" };

beforeEach(async () => {
  await admin.reset();
});

describe("ALLOWED_USER_IDS だけの構成", () => {
  it("リストにある ID のユーザーはログインでき、ツールが呼べる。team の確認は行われない", async () => {
    await admin.addUser(allowed);
    await installApp();
    const client = await login(allowed);
    try {
      const { tools } = await client.listTools();
      expect(tools.map((t) => t.name)).toContain("task_start");
      const started = bodyOf(
        await client.callTool({ name: "task_start", arguments: startArgs("BYID") }),
      ) as { task_id: string };
      expect(started.task_id).toBeTruthy();
      expect(
        bodyOf(
          await client.callTool({ name: "task_cancel", arguments: { task_id: started.task_id } }),
        ),
      ).toMatchObject({ status: "CANCELLED" });
    } finally {
      await client.close();
    }
    const reqs = await admin.requests();
    expect(reqs.some((r) => r.path === "/user")).toBe(true);
    expect(reqs.some((r) => r.path.includes("/memberships/"))).toBe(false);
  });

  it("2 つ目の ID のユーザーもログインできる（リストはカンマ区切り・空白つき）", async () => {
    await admin.addUser(allowed2);
    const client = await login(allowed2);
    try {
      expect((await client.listTools()).tools.length).toBeGreaterThan(0);
    } finally {
      await client.close();
    }
  });

  it("リストに無い ID のユーザーは、たとえ team の active メンバーでもログインできない。監査は not_team_member", async () => {
    await admin.addUser(outsider);
    await admin.setTeam(ORG, TEAM, outsider.login, "active");
    const flow = await beginLogin(baseUrl);
    const callbackUrl = await approveAtGitHub(flow.githubAuthorizeUrl);
    const res = await callCallback(callbackUrl, flow.cookie);
    expect(res.status).toBe(302);
    const back = new URL(res.headers.get("location") ?? "");
    expect(back.searchParams.get("error")).toBe("access_denied");
    expect(back.searchParams.get("code")).toBeNull();
    // 資格は保存されていないので、ツールは呼べない
    await expect(login(outsider)).rejects.toThrow(/access_denied/);

    const denied = await waitForAudit(
      (r) => r.event === "authz_denied" && r.userId === OUTSIDER_ID,
    );
    expect(denied).toMatchObject({ reason: "not_team_member", caller: "parent" });
    const reqs = await admin.requests();
    expect(reqs.some((r) => r.path.includes("/memberships/"))).toBe(false);
    expect(JSON.stringify(await auditRecords())).not.toContain(outsider.login);
  });
});
