import { describe, expect, it } from "vitest";
import { AUDIT_EVENTS, audit } from "../src/index";

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

describe("audit(): トークン形式の検出は接頭辞が先頭でなくても効く（M1 レビュー low）", () => {
  const host = (h: unknown) =>
    (run("outbound_denied", { host: h }).record as { host?: string }).host;
  const requestId = (v: unknown) =>
    (run("auth_failed", { requestId: v }).record as { requestId?: string }).requestId;

  const tokens = [
    "ghs_abcdefghij",
    "ghu_abcdefghij",
    "gho_abcdefghij",
    "ghp_abcdefghij",
    "ghr_abcdefghij",
    "github_pat_11AAAAAAA0",
    "sk-abcdefghij",
    "xoxb-1234567890",
    "xoxp-1234567890",
    "eyJhbGciOiJIUzI1NiJ9",
  ];

  it("host: 接頭辞がラベルの途中にあってもマスクする（短い値でも）", () => {
    for (const t of tokens) {
      for (const label of [t, `x${t}`, `a-${t}`, `${t}zz`]) {
        const out = host(`${label}.example.com`) ?? "";
        expect(out, label).toBe("masked.example.com");
      }
    }
  });

  it("host: 大文字小文字を区別せずマスクする", () => {
    expect(host("XGHS_abc.example.com")).toBe("masked.example.com");
    expect(host("EYJabc.example.com")).toBe("masked.example.com");
  });

  it("host: トークンを含まない普通のラベルはそのまま通す", () => {
    expect(host("api.github.com")).toBe("api.github.com");
    expect(host("registry.npmjs.org")).toBe("registry.npmjs.org");
    expect(host("files.pythonhosted.org")).toBe("files.pythonhosted.org");
  });

  it("requestId: 接頭辞が途中にある値は出さない", () => {
    for (const t of tokens) {
      expect(requestId(`x${t}`), t).toBeUndefined();
      expect(requestId(`a-${t}`), t).toBeUndefined();
    }
    expect(requestId("8a1b2c3d4e5f-NRT")).toBe("8a1b2c3d4e5f-NRT");
  });
});

describe("audit(): レコードの枠（audit / event / ts）は fields で上書きできない", () => {
  it("fields に audit / event / ts / __proto__ があっても無視する", () => {
    const fields = JSON.parse(
      '{"audit":false,"event":"forged","ts":1,"__proto__":{"userId":9},"reason":"ok"}',
    ) as Record<string, unknown>;
    const { record, lines } = run("auth_failed", fields, 1_700_000_000_000);
    expect(record).toEqual({
      audit: true,
      event: "auth_failed",
      ts: 1_700_000_000_000,
      reason: "ok",
    });
    expect(JSON.parse(lines[0] as string)).toEqual(record);
  });

  it("継承されたプロパティ（プロトタイプ上の値）は読まない", () => {
    const inherited = Object.create({ userId: 5, reason: "inherited" }) as Record<string, unknown>;
    inherited.taskId = "t1";
    expect(run("task_cancelled", inherited).record).toEqual({
      audit: true,
      event: "task_cancelled",
      ts: 1_700_000_000_000,
      taskId: "t1",
    });
  });
});

describe("audit(): allowlist は呼び出し側から変えられない", () => {
  it("第 3 引数に allowlist らしきものを渡しても、効かない", () => {
    const lines: string[] = [];
    const r = audit("auth_failed", { reason: "x", op: "terminate", token: "ghs_abc" }, {
      now: 1,
      log: (l: string) => lines.push(l),
      allow: ["op", "token"],
      allowlist: ["token"],
    } as never);
    expect(r).toEqual({ audit: true, event: "auth_failed", ts: 1, reason: "x" });
    expect(lines.join("")).not.toContain("ghs_");
  });
});

describe("audit(): イベント別の allowlist（共通 + イベント固有）", () => {
  it("op は sandbox_privileged_op だけで、固定の値（terminate / destroy / set_deadline / extend_deadline）だけ", () => {
    for (const op of ["terminate", "destroy", "set_deadline", "extend_deadline"]) {
      expect(run("sandbox_privileged_op", { op }).record).toHaveProperty("op", op);
    }
    for (const bad of ["Terminate", "rm -rf", "", 1, "ghs_x"]) {
      expect(run("sandbox_privileged_op", { op: bad }).record).not.toHaveProperty("op");
    }
    // 他のイベントでは op を出さない
    expect(run("outbound_denied", { op: "terminate" }).record).not.toHaveProperty("op");
    expect(run("auth_failed", { op: "terminate" }).record).not.toHaveProperty("op");
  });

  it("dest は outbound_denied だけで、github / registry / other だけ", () => {
    for (const dest of ["github", "registry", "other"]) {
      expect(run("outbound_denied", { dest }).record).toHaveProperty("dest", dest);
    }
    for (const bad of ["evil.example", "GitHub", "", 1]) {
      expect(run("outbound_denied", { dest: bad }).record).not.toHaveProperty("dest");
    }
    expect(run("boot_superseded", { dest: "github" }).record).not.toHaveProperty("dest");
  });

  it("agent のイベント（M2）を閉じた一覧に含む", () => {
    for (const e of [
      "sandbox_privileged_op",
      "outbound_denied",
      "agent_cancelled",
      "boot_superseded",
      "start_cancelled_by_tombstone",
      "start_conflict",
    ]) {
      expect(AUDIT_EVENTS).toContain(e);
    }
  });

  it("キーの順序は固定（audit, event, ts, 共通, 固有）", () => {
    const { lines } = run("outbound_denied", {
      dest: "other",
      host: "evil.example",
      reason: "host_not_allowed",
      taskId: "t1",
    });
    expect(Object.keys(JSON.parse(lines[0] as string))).toEqual([
      "audit",
      "event",
      "ts",
      "taskId",
      "reason",
      "host",
      "dest",
    ]);
  });
});

describe("audit(): 既定の出力先は console.log（globalThis 経由。Node / Cloudflare の型に依存しない）", () => {
  it("log を渡さないと console.log に 1 行出す", () => {
    const orig = globalThis.console.log;
    const seen: unknown[] = [];
    globalThis.console.log = (...a: unknown[]) => void seen.push(...a);
    try {
      audit("auth_failed", { reason: "x" }, { now: 5 });
    } finally {
      globalThis.console.log = orig;
    }
    expect(seen).toEqual(['{"audit":true,"event":"auth_failed","ts":5,"reason":"x"}']);
  });
});
