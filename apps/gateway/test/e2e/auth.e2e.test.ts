import { beforeEach, describe, expect, it } from "vitest";
import { addMember, admin, baseUrl, bodyOf, login, newUser, ORG, TEAM } from "./helpers";
import {
  approveAtGitHub,
  beginLogin,
  callCallback,
  openConsent,
  submitConsent,
} from "./oauth-client";

beforeEach(async () => {
  await admin.reset();
});

describe("同意画面（confused deputy 対策）", () => {
  it("/authorize は同意画面を出し、承認するまで GitHub へ行かない（偽 GitHub に何も届かない）", async () => {
    const before = (await admin.requests()).length;
    const consent = await openConsent(baseUrl);
    expect(consent.response.headers.get("location")).toBeNull();
    expect(consent.response.headers.get("x-frame-options")).toBe("DENY");
    expect(consent.response.headers.get("content-security-policy")).toContain(
      "frame-ancestors 'none'",
    );
    expect(consent.html).toContain("rovo-e2e"); // DCR の client_name
    expect(consent.html).toContain("<strong>127.0.0.1</strong>"); // redirect_uri のホスト
    expect(consent.html).toContain("http://127.0.0.1:9/callback");
    expect((await admin.requests()).length).toBe(before);
  });

  it("拒否すると client の redirect_uri へ access_denied。ログインも GitHub への接続も起きない", async () => {
    const before = (await admin.requests()).length;
    const consent = await openConsent(baseUrl);
    const res = await submitConsent(
      baseUrl,
      { handle: consent.handle, decision: "deny" },
      consent.cookie,
    );
    expect(res.status).toBe(302);
    const back = new URL(res.headers.get("location") ?? "");
    expect(back.origin + back.pathname).toBe("http://127.0.0.1:9/callback");
    expect(back.searchParams.get("error")).toBe("access_denied");
    expect(back.searchParams.get("code")).toBeNull();
    expect((await admin.requests()).length).toBe(before);
    // 拒否で消費された handle では承認できない
    const again = await submitConsent(
      baseUrl,
      { handle: consent.handle, decision: "approve" },
      consent.cookie,
    );
    expect(again.status).toBe(400);
    expect(again.headers.get("location")).toBeNull();
  });

  it("CSRF: 開始したブラウザの Cookie が無い承認 POST は拒否される", async () => {
    const consent = await openConsent(baseUrl);
    const res = await submitConsent(baseUrl, { handle: consent.handle, decision: "approve" }, "");
    expect(res.status).toBe(400);
    expect(res.headers.get("location")).toBeNull();
  });

  it("CSRF: handle が一致しない・別の同意画面の Cookie の承認 POST は拒否される", async () => {
    const a = await openConsent(baseUrl);
    const b = await openConsent(baseUrl);
    for (const [handle, cookie] of [
      ["forged-handle", a.cookie],
      [a.handle, b.cookie],
    ] as const) {
      const res = await submitConsent(baseUrl, { handle, decision: "approve" }, cookie);
      expect(res.status).toBe(400);
      expect(res.headers.get("location")).toBeNull();
    }
  });

  it("CSRF: 承認済みの handle は再使用できない", async () => {
    const consent = await openConsent(baseUrl);
    const first = await submitConsent(
      baseUrl,
      { handle: consent.handle, decision: "approve" },
      consent.cookie,
    );
    expect(first.status).toBe(302);
    const replay = await submitConsent(
      baseUrl,
      { handle: consent.handle, decision: "approve" },
      consent.cookie,
    );
    expect(replay.status).toBe(400);
    expect(replay.headers.get("location")).toBeNull();
  });
});

describe("ログイン（本物のフロー: DCR -> /authorize -> 偽 GitHub -> /callback -> token(PKCE)）", () => {
  it("team の active メンバーはログインでき、7 つのツールが使える", async () => {
    const user = newUser();
    await addMember(user);
    const client = await login(user);
    try {
      const { tools } = await client.listTools();
      expect(tools.map((t) => t.name).sort()).toEqual([
        "task_answer",
        "task_cancel",
        "task_result",
        "task_start",
        "task_status",
        "task_steer",
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
