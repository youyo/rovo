import { beforeEach, describe, expect, it } from "vitest";
import { addMember, admin, baseUrl, bodyOf, login, newUser, ORG, TEAM } from "./helpers";
import { approveAtGitHub, beginLogin, callCallback } from "./oauth-client";

beforeEach(async () => {
  await admin.reset();
});

describe("ログイン（本物のフロー: DCR -> /authorize -> 偽 GitHub -> /callback -> token(PKCE)）", () => {
  it("team の active メンバーはログインでき、4 つのツールが使える", async () => {
    const user = newUser();
    await addMember(user);
    const client = await login(user);
    try {
      const { tools } = await client.listTools();
      expect(tools.map((t) => t.name).sort()).toEqual([
        "task_cancel",
        "task_start",
        "task_status",
        "task_wait",
      ]);
    } finally {
      await client.close();
    }
    // 偽 GitHub 側の記録: code 交換と team 確認が行われた
    const reqs = await admin.requests();
    expect(reqs.some((r) => r.path === "/login/oauth/access_token")).toBe(true);
    expect(
      reqs.some((r) => r.path === `/orgs/${ORG}/teams/${TEAM}/memberships/${user.login}`),
    ).toBe(true);
  });

  it.each(["none", "pending"] as const)(
    "team の状態が %s のユーザーはログインできない（MCP の code が発行されない）",
    async (state) => {
      const user = newUser("outsider");
      await admin.addUser(user);
      if (state === "pending") await admin.setTeam(ORG, TEAM, user.login, "pending");
      const flow = await beginLogin(baseUrl);
      const callbackUrl = await approveAtGitHub(flow.githubAuthorizeUrl);
      const res = await callCallback(callbackUrl, flow.cookie);
      expect(res.status).toBe(302);
      const back = new URL(res.headers.get("location") ?? "");
      expect(back.searchParams.get("error")).toBe("access_denied");
      expect(back.searchParams.get("code")).toBeNull();
      // 資格は保存されていないので、ログインしていないユーザーは何もできない
      await expect(login(user)).rejects.toThrow(/access_denied/);
    },
  );

  it("state が一致しない /callback は拒否される", async () => {
    const user = newUser();
    await addMember(user);
    const flow = await beginLogin(baseUrl);
    const callbackUrl = new URL(await approveAtGitHub(flow.githubAuthorizeUrl));
    callbackUrl.searchParams.set("state", "forged-state");
    const res = await callCallback(callbackUrl.toString(), flow.cookie);
    expect(res.status).toBe(400);
    expect(res.headers.get("location")).toBeNull();
  });

  it("開始したブラウザの Cookie が無い /callback は拒否される", async () => {
    const user = newUser();
    await addMember(user);
    const flow = await beginLogin(baseUrl);
    const callbackUrl = await approveAtGitHub(flow.githubAuthorizeUrl);
    const res = await callCallback(callbackUrl, "");
    expect(res.status).toBe(400);
    expect(res.headers.get("location")).toBeNull();
  });

  it("別のログイン試行の Cookie では state を使えない", async () => {
    const user = newUser();
    await addMember(user);
    const a = await beginLogin(baseUrl);
    const b = await beginLogin(baseUrl);
    const callbackUrl = await approveAtGitHub(a.githubAuthorizeUrl);
    const res = await callCallback(callbackUrl, b.cookie);
    expect(res.status).toBe(400);
  });

  it("使用済みの state は再使用できない", async () => {
    const user = newUser();
    await addMember(user);
    const flow = await beginLogin(baseUrl);
    const callbackUrl = await approveAtGitHub(flow.githubAuthorizeUrl);
    const first = await callCallback(callbackUrl, flow.cookie);
    expect(first.status).toBe(302);
    expect(new URL(first.headers.get("location") ?? "").searchParams.get("code")).toBeTruthy();
    const replay = await callCallback(callbackUrl, flow.cookie);
    expect(replay.status).toBe(400);
    expect(replay.headers.get("location")).toBeNull();
  });

  it("ログインに成功しても、App が未導入のリポジトリは使えない（ログインと Installation は別）", async () => {
    const user = newUser();
    await addMember(user);
    // installApp() しない
    const client = await login(user);
    try {
      const r = await client.callTool({
        name: "task_start",
        arguments: {
          repository: "acme/widgets",
          base_ref: "main",
          base_sha: "0123456789abcdef",
          title: "t",
          instructions: "i",
        },
      });
      expect(r.isError).toBe(true);
      expect(bodyOf(r).code).toBe("forbidden");
    } finally {
      await client.close();
    }
  });
});
