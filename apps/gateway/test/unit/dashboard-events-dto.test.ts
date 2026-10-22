import { LIMITS, TaskEventDtoSchema } from "@rovo/dashboard-contract";
import { describe, expect, it } from "vitest";
import { DASHBOARD_EVENT_TYPES, toEventDto } from "../../src/dashboard/events";

// 保存された events の行を、契約の TaskEventDto にする純関数。API の応答の最後の層で、もう一度マスクと上限をかける
const GHP = `ghp_${"a1B2".repeat(9)}`;
const GHS = `ghs_${"c3D4".repeat(9)}`;
const PAT = `github_pat_${"E5f6".repeat(8)}`;
const SHA = "0123456789abcdef0123456789abcdef01234567";
const AT = Date.UTC(2026, 9, 22, 1, 2, 3);
const ISO = "2026-10-22T01:02:03.000Z";

const row = (seq: number, type: string, payload: Record<string, unknown>) => ({
  seq,
  type,
  payload,
  created_at: AT,
});
const dto = (type: string, payload: Record<string, unknown>) => {
  const e = toEventDto(row(7, type, payload));
  if (e) TaskEventDtoSchema.parse(e);
  return e;
};

describe("toEventDto: 対応する型", () => {
  it("DASHBOARD_EVENT_TYPES は API が返す型の一覧（保存された他の型は返さない）", () => {
    expect([...DASHBOARD_EVENT_TYPES].sort()).toEqual(
      [
        "agent_event",
        "cancelled",
        "command",
        "commit",
        "draft_pr_created",
        "edit",
        "status_changed",
        "tool_end",
        "tool_start",
        "usage",
        "web",
      ].sort(),
    );
  });

  it("command / edit / commit / web", () => {
    expect(
      dto("command", {
        command: "pnpm test",
        cwd: "apps/gateway",
        exit_code: 1,
        duration_ms: 9,
        output_tail: "FAIL",
      }),
    ).toEqual({
      seq: 7,
      at: ISO,
      type: "command",
      command: "pnpm test",
      cwd: "apps/gateway",
      exit_code: 1,
      duration_ms: 9,
      output_tail: "FAIL",
    });
    expect(dto("command", { command: "x", exit_code: null })).toEqual({
      seq: 7,
      at: ISO,
      type: "command",
      command: "x",
      exit_code: null,
    });
    expect(dto("edit", { path: "a/b.ts", op: "modify", added: 2, removed: 1 })).toEqual({
      seq: 7,
      at: ISO,
      type: "edit",
      path: "a/b.ts",
      op: "modify",
      added: 2,
      removed: 1,
    });
    expect(dto("commit", { message: "fix", sha: SHA, files: 3 })).toEqual({
      seq: 7,
      at: ISO,
      type: "commit",
      message: "fix",
      sha: SHA,
      files: 3,
    });
    expect(dto("web", { kind: "fetch", host: "docs.example.com" })).toEqual({
      seq: 7,
      at: ISO,
      type: "web",
      kind: "fetch",
      host: "docs.example.com",
    });
  });

  it("tool_start / tool_end（古い agent の履歴の縮退表示に使う）", () => {
    expect(dto("tool_start", { call_id: "c1", name: "bash", summary: "ls" })).toEqual({
      seq: 7,
      at: ISO,
      type: "tool_start",
      call_id: "c1",
      name: "bash",
      summary: "ls",
    });
    expect(
      dto("tool_end", { call_id: "c1", name: "bash", is_error: true, summary: "boom" }),
    ).toEqual({
      seq: 7,
      at: ISO,
      type: "tool_end",
      call_id: "c1",
      is_error: true,
      summary: "boom",
    });
    // 欠けた値でも契約に合う形にする
    expect(dto("tool_start", { call_id: null, name: null, summary: null })).toMatchObject({
      type: "tool_start",
      call_id: "",
      name: "",
      summary: "",
    });
  });

  it("status_changed / draft_pr_created / usage / agent_event", () => {
    expect(dto("status_changed", { status: "RUNNING", from: "CREATING" })).toEqual({
      seq: 7,
      at: ISO,
      type: "status_changed",
      from: "CREATING",
      to: "RUNNING",
    });
    expect(
      dto("status_changed", { status: "FAILED", from: "RUNNING", reason: "base_sha_not_found" }),
    ).toMatchObject({ reason: "base_sha_not_found" });
    // 理由コードの形でない自由文は出さない。未知の状態は返さない
    expect(
      dto("status_changed", { status: "FAILED", reason: "Some free text ghp" }),
    ).not.toHaveProperty("reason");
    expect(toEventDto(row(1, "status_changed", { status: "WEIRD" }))).toBeNull();
    expect(
      dto("draft_pr_created", {
        number: 5,
        url: "https://github.com/acme/widgets/pull/5",
        draft: true,
        branch: "agent/task-x",
        initial_sha: SHA,
      }),
    ).toEqual({
      seq: 7,
      at: ISO,
      type: "draft_pr_created",
      pr_number: 5,
      pr_url: "https://github.com/acme/widgets/pull/5",
    });
    expect(
      toEventDto(row(1, "draft_pr_created", { number: 5, url: "https://evil.example/x" })),
    ).toBeNull();
    expect(
      dto("usage", {
        cost_usd: 0.5,
        input_tokens: 10,
        output_tokens: 20,
        cache_read_tokens: 3,
        cache_write_tokens: 4,
        sandbox_runtime_ms: 99,
      }),
    ).toEqual({
      seq: 7,
      at: ISO,
      type: "usage",
      cost_usd: 0.5,
      input_tokens: 10,
      output_tokens: 20,
      cache_read_tokens: 3,
      cache_write_tokens: 4,
    });
    expect(dto("agent_event", { agent_type: "mystery" })).toEqual({
      seq: 7,
      at: ISO,
      type: "agent_event",
      agent_type: "mystery",
    });
  });

  it("利用者の cancel（TaskDO.cancel が cancelled を直接積む）も CANCELLED への状態の変化として返す", () => {
    expect(dto("cancelled", { status: "CANCELLED", from: "RUNNING" })).toEqual({
      seq: 7,
      at: ISO,
      type: "status_changed",
      from: "RUNNING",
      to: "CANCELLED",
    });
    expect(dto("cancelled", { status: "CANCELLED" })).toMatchObject({ to: "CANCELLED" });
  });

  it("web ツールの tool_start は、引数の要約（URL のパス・クエリを含みうる）を出さない", () => {
    for (const name of ["web_fetch", "web_browse", "web_search"]) {
      const e = dto("tool_start", {
        call_id: "c1",
        name,
        summary: '{"url":"https://docs.example.com/secret/path?token=zzz"}',
      });
      expect(e, name).toMatchObject({ type: "tool_start", summary: "web request (omitted)" });
      expect(JSON.stringify(e)).not.toContain("secret/path");
    }
    // web 以外は従来どおり
    expect(dto("tool_start", { call_id: "c1", name: "bash", summary: "ls" })).toMatchObject({
      summary: "ls",
    });
  });

  it("対象外の型（question・answered・completion_report・audit・created など）は返さない", () => {
    for (const type of [
      "question",
      "answered",
      "completion_report",
      "audit",
      "created",
      "warning",
      "pushed",
      "steer_received",
      "agent_error",
    ]) {
      expect(toEventDto(row(1, type, { message: "x" })), type).toBeNull();
    }
  });
});

describe("toEventDto: 最後の層でも秘密を出さない", () => {
  it("保存された行が（過去のバグや改ざんで）マスク前でも、応答の DTO には秘密が平文で出ない", () => {
    const rows = [
      row(1, "command", {
        command: `echo a && wget --header "Authorization: Bearer ${"abcdef0123456789xyz"}" https://user:s3cretPass@h.example/ ${GHP}`,
        output_tail: `x\n${GHS}\nGITHUB_TOKEN=plain123\n${PAT}`,
        exit_code: 0,
      }),
      row(2, "commit", { message: `feat ${GHP}`, sha: SHA, files: 1 }),
      row(3, "tool_start", { call_id: "c", name: "bash", summary: `{"x":"${GHS}"}` }),
      row(4, "tool_end", { call_id: "c", name: "bash", is_error: false, summary: `out ${PAT}` }),
      row(5, "edit", { path: `notes/${GHP}.md`, op: "create", added: 1, removed: 0 }),
    ];
    const whole = JSON.stringify(rows.map((r) => toEventDto(r)));
    for (const s of [GHP, GHS, PAT, "abcdef0123456789xyz", "s3cretPass", "plain123"]) {
      expect(whole, s).not.toContain(s);
    }
    expect(whole).toContain("[REDACTED]");
  });

  it("上限を超える値は切る（契約のスキーマに必ず合う）", () => {
    const e = dto("tool_start", {
      call_id: "x".repeat(500),
      name: "n".repeat(500),
      summary: "あ".repeat(5_000),
    });
    expect(e).not.toBeNull();
    expect((e as { summary: string }).summary.length).toBeLessThanOrEqual(LIMITS.summary);
    expect(
      dto("command", {
        command: "😀".repeat(5_000),
        output_tail: "あ".repeat(9_000),
        exit_code: 0,
      }),
    ).not.toBeNull();
  });

  it("契約に合わない必須項目（不正なパス・sha）は、中身を出さず null", () => {
    expect(
      toEventDto(row(1, "edit", { path: "../x", op: "modify", added: 1, removed: 1 })),
    ).toBeNull();
    expect(toEventDto(row(1, "commit", { message: "m", sha: "zzz", files: 1 }))).toBeNull();
    expect(toEventDto(row(1, "web", { kind: "crawl" }))).toBeNull();
  });
});
