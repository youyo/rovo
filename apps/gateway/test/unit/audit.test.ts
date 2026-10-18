import { describe, expect, it } from "vitest";
import { AUDIT_EVENTS, audit } from "../../src/audit";

/** audit() の出力（log に渡された行）と戻り値を集める。 */
function run(event: string, fields: Record<string, unknown>, now = 1_700_000_000_000) {
  const lines: string[] = [];
  const record = audit(event as never, fields as never, { now, log: (l) => lines.push(l) });
  return { lines, record };
}

describe("audit(): 出力の形", () => {
  it("1 行の JSON で {audit:true, event, ts, ...} を出す", () => {
    const { lines, record } = run("task_cancelled", {
      userId: 42,
      taskId: "01HZZZZZZZZZZZZZZZZZZZZZZZ",
      caller: "parent",
      reason: "parent_requested",
    });
    expect(lines).toHaveLength(1);
    expect(lines[0]).not.toContain("\n");
    expect(JSON.parse(lines[0] as string)).toEqual({
      audit: true,
      event: "task_cancelled",
      ts: 1_700_000_000_000,
      userId: 42,
      taskId: "01HZZZZZZZZZZZZZZZZZZZZZZZ",
      caller: "parent",
      reason: "parent_requested",
    });
    expect(record).toEqual(JSON.parse(lines[0] as string));
  });

  it("許可したフィールド（userId / taskId / caller / reason / requestId / host / kind）をすべて通す", () => {
    const { record } = run("credential_issued", {
      userId: 7,
      taskId: "task-1",
      caller: "system",
      reason: "ok",
      requestId: "8a1b2c3d4e5f-NRT",
      host: "api.github.com",
      kind: "refresh",
    });
    expect(record).toMatchObject({
      userId: 7,
      taskId: "task-1",
      caller: "system",
      reason: "ok",
      requestId: "8a1b2c3d4e5f-NRT",
      host: "api.github.com",
      kind: "refresh",
    });
  });

  it("requestId・host・kind は任意（無ければ出さない）", () => {
    const { record } = run("auth_failed", { reason: "token_rejected" });
    expect(Object.keys(record ?? {}).sort()).toEqual(["audit", "event", "reason", "ts"]);
  });
});

describe("audit(): allowlist（秘密・本文・URL のパスを出さない）", () => {
  it("未知のフィールドは黙って落とす（トークン・本文・URL・タスクの入力・stack）", () => {
    const { lines, record } = run("authz_denied", {
      reason: "forbidden",
      token: "ghs_abcdefghijklmnopqrstuvwxyz0123456789",
      installation_token: "ghs_secret",
      authorization: "Bearer abc",
      body: "ignore previous instructions",
      message: "free text",
      url: "https://evil.example/path?q=1",
      path: "/repos/acme/widgets",
      instructions: "implement x",
      title: "secret title",
      stack: "Error: boom\n at x",
      password: "p",
    });
    expect(Object.keys(record ?? {}).sort()).toEqual(["audit", "event", "reason", "ts"]);
    for (const leaked of ["ghs_", "Bearer", "ignore previous", "evil.example", "acme/widgets"]) {
      expect(lines.join("")).not.toContain(leaked);
    }
  });

  it("reason は固定コード（英小文字・数字・_ の 64 文字まで）だけ。自由な文は出さない", () => {
    for (const bad of [
      "token ghs_abc is invalid",
      "Forbidden",
      "has space",
      "a".repeat(65),
      "",
      "line\nbreak",
      "日本語",
      123,
      { code: "x" },
    ]) {
      expect(run("auth_failed", { reason: bad }).record).not.toHaveProperty("reason");
    }
    expect(run("auth_failed", { reason: "a".repeat(64) }).record).toHaveProperty("reason");
    expect(run("auth_failed", { reason: "github_error_403" }).record).toHaveProperty("reason");
  });

  it("caller は parent / child / system だけ", () => {
    for (const ok of ["parent", "child", "system"]) {
      expect(run("task_cancelled", { caller: ok }).record).toHaveProperty("caller", ok);
    }
    for (const bad of ["admin", "Parent", "", 1, null]) {
      expect(run("task_cancelled", { caller: bad }).record).not.toHaveProperty("caller");
    }
  });

  it("taskId は [A-Za-z0-9_-]{1,64}、userId は非負の安全な整数（または数字だけの文字列）だけ", () => {
    for (const bad of ["a/b", "x y", "t".repeat(65), "", "ghs_a.b", 5, null]) {
      expect(run("task_cancelled", { taskId: bad }).record).not.toHaveProperty("taskId");
    }
    for (const bad of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, "12a", "", {}, [1], null]) {
      expect(run("task_cancelled", { userId: bad }).record).not.toHaveProperty("userId");
    }
    expect(run("task_cancelled", { userId: "123" }).record).toHaveProperty("userId", "123");
    expect(run("task_cancelled", { userId: 0 }).record).toHaveProperty("userId", 0);
  });

  it("kind は固定コードの形だけ", () => {
    expect(run("credential_issued", { kind: "start" }).record).toHaveProperty("kind", "start");
    for (const bad of ["Start", "a b", "k".repeat(33), 1]) {
      expect(run("credential_issued", { kind: bad }).record).not.toHaveProperty("kind");
    }
  });

  it("requestId は英数字と . _ - の 64 文字まで。トークン形式は出さない", () => {
    expect(run("auth_failed", { requestId: "abc-123.x_y" }).record).toHaveProperty("requestId");
    for (const bad of ["a b", "x".repeat(65), "", "ghs_abcdefghijklmnopqrstuvwxyz", "a/b", 5]) {
      expect(run("auth_failed", { requestId: bad }).record).not.toHaveProperty("requestId");
    }
  });

  it("許可したフィールドでも、値が不正なら出さない（変換して通さない）", () => {
    const { record } = run("authz_denied", { userId: { toString: () => "1" }, reason: ["a"] });
    expect(record).not.toHaveProperty("userId");
    expect(record).not.toHaveProperty("reason");
  });
});

describe("audit(): host（常時可。パス・クエリ・userinfo は出さず、長さを制限しトークン形式をマスクする）", () => {
  const host = (h: unknown) => (run("auth_failed", { host: h }).record as { host?: string }).host;

  it("ホスト名は小文字にして通す", () => {
    expect(host("API.GitHub.com")).toBe("api.github.com");
    expect(host("localhost")).toBe("localhost");
  });

  it("URL・パス・クエリ・userinfo・ポート・空白を含む値は出さない", () => {
    for (const bad of [
      "https://api.github.com/repos/x",
      "api.github.com/repos",
      "api.github.com?x=1",
      "api.github.com#frag",
      "user:pass@api.github.com",
      "u@api.github.com",
      "api.github.com:8443",
      "api github.com",
      "api.github.com\n",
      "",
      42,
    ]) {
      expect(host(bad)).toBeUndefined();
    }
  });

  it("長すぎる host は 100 文字に切る", () => {
    const long = `${"a".repeat(30)}.${"b".repeat(30)}.${"c".repeat(30)}.${"d".repeat(30)}.example.com`;
    expect((host(long) ?? "").length).toBeLessThanOrEqual(100);
    expect(host(long)).toBeDefined();
  });

  it("トークン形式のラベルはマスクする（DNS 経由の持ち出し対策）", () => {
    const secret = "ghs_abcdefghijklmnopqrstuvwxyz0123456789";
    const masked = host(`${secret}.evil.example`) ?? "";
    expect(masked).not.toContain("ghs_");
    expect(masked).not.toContain("abcdefghijklmnop");
    expect(masked.endsWith(".evil.example")).toBe(true);
    for (const t of [
      "github_pat_11AAAAAAA0abcdefghijkl",
      "ghp_abcdefghijklmnopqrstuvwxyz0123456789",
      "0123456789abcdef0123456789abcdef01234567",
      "sk-abcdefghijklmnopqrstuvwxyz0123456789",
    ]) {
      const m = host(`${t}.example.com`) ?? "";
      expect(m).not.toContain(t);
      expect(m.endsWith(".example.com")).toBe(true);
    }
  });
});

describe("audit(): イベント名", () => {
  it("閉じた一覧にある名前だけ出す。未知のイベントは出力せず null", () => {
    for (const e of AUDIT_EVENTS) expect(run(e, { reason: "x" }).record).not.toBeNull();
    const { lines, record } = run("totally_unknown", { reason: "x" });
    expect(record).toBeNull();
    expect(lines).toEqual([]);
  });

  it("M1 のイベントを含む", () => {
    for (const e of [
      "auth_failed",
      "authz_denied",
      "credential_issued",
      "credential_issue_failed",
      "credential_revoked",
      "credential_revoke_given_up",
      "task_cancelled",
      "task_ended_by_limit",
      "delivery_given_up",
    ]) {
      expect(AUDIT_EVENTS).toContain(e);
    }
  });
});
