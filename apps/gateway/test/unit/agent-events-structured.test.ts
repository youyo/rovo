import { STRUCTURED_LIMITS } from "@rovo/audit";
import { LIMITS, STRUCTURED_EVENT_TYPES } from "@rovo/dashboard-contract";
import { describe, expect, it } from "vitest";
import { mapAgentEvent } from "../../src/agent/agent-events";

// 構造化イベント（D14）の取り込み。agent が（バグで）マスクし忘れても、gateway で再マスクと上限をかける
const GHP = `ghp_${"a1B2".repeat(9)}`;
const GHS = `ghs_${"c3D4".repeat(9)}`;
const PAT = `github_pat_${"E5f6".repeat(8)}`;
const SHA = "0123456789abcdef0123456789abcdef01234567";

const ev = (type: string, data: unknown) => ({ seq: 1, ts: 1, type, data: JSON.stringify(data) });
const payloadOf = (m: ReturnType<typeof mapAgentEvent>): Record<string, unknown> =>
  "payload" in m ? m.payload : {};

describe("契約の上限と agent 側の上限が一致している", () => {
  it("STRUCTURED_LIMITS は dashboard-contract の LIMITS と同じ", () => {
    expect(STRUCTURED_LIMITS.command).toBe(LIMITS.command);
    expect(STRUCTURED_LIMITS.outputTail).toBe(LIMITS.outputTail);
    expect(STRUCTURED_LIMITS.path).toBe(LIMITS.path);
    expect(STRUCTURED_LIMITS.commitMessage).toBe(LIMITS.commitMessage);
    expect(STRUCTURED_LIMITS.host).toBe(LIMITS.host);
  });
});

describe("mapAgentEvent: command / edit / commit / web", () => {
  it("command は項目を選んで snake_case の公開用に写す。余計な項目は落ちる", () => {
    const m = mapAgentEvent(
      ev("command", {
        command: "pnpm test",
        cwd: "apps/gateway",
        exitCode: 1,
        durationMs: 250,
        outputTail: "FAIL\n",
        argv: ["落とす"],
        env: { A: "b" },
      }),
    );
    expect(m).toEqual({
      kind: "event",
      type: "command",
      payload: {
        command: "pnpm test",
        cwd: "apps/gateway",
        exit_code: 1,
        duration_ms: 250,
        output_tail: "FAIL\n",
      },
    });
  });

  it("command の exit_code が壊れていれば null、任意の項目は付けない", () => {
    expect(payloadOf(mapAgentEvent(ev("command", { command: "x", exitCode: "1" })))).toEqual({
      command: "x",
      exit_code: null,
    });
  });

  it("agent がマスクし忘れた秘密も、取り込み時に伏せる（先頭でない位置・URL 内の資格・env を含む）", () => {
    const m = mapAgentEvent(
      ev("command", {
        command: `echo hi && wget --header "Authorization: Bearer ${"abcdef0123456789xyz"}" https://user:s3cretPass@h.example/ && GITHUB_TOKEN=plain123 ${GHP}`,
        outputTail: `line\nx ${GHS}\n${PAT}\nAPI_KEY=plainvalue789`,
      }),
    );
    const whole = JSON.stringify(m);
    for (const s of [
      GHP,
      GHS,
      PAT,
      "abcdef0123456789xyz",
      "s3cretPass",
      "plain123",
      "plainvalue789",
    ]) {
      expect(whole, s).not.toContain(s);
    }
    expect(String(payloadOf(m).command)).toContain("[REDACTED]");
  });

  it("上限を超える値は切る（マルチバイトの境界でも UTF-16 の上限を守る）", () => {
    const p = payloadOf(
      mapAgentEvent(
        ev("command", { command: "😀".repeat(5_000), outputTail: "あ".repeat(10_000) }),
      ),
    );
    expect(String(p.command).length).toBeLessThanOrEqual(LIMITS.command);
    expect(String(p.output_tail).length).toBeLessThanOrEqual(LIMITS.outputTail);
    expect(String(p.command)).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
  });

  it("edit: path・op・行数。差分の本文や不正なパスは通さない", () => {
    expect(
      mapAgentEvent(
        ev("edit", { path: "src/a.ts", op: "create", added: 3, removed: 0, diff: "+x" }),
      ),
    ).toEqual({
      kind: "event",
      type: "edit",
      payload: { path: "src/a.ts", op: "create", added: 3, removed: 0 },
    });
    for (const path of ["../x", "/etc/passwd", "a\u0000b", "a\nb"]) {
      // 不正なパスのイベントは、中身を出さず既存の縮退（agent_event）に落ちる
      expect(mapAgentEvent(ev("edit", { path, op: "modify", added: 1, removed: 1 })), path).toEqual(
        {
          kind: "event",
          type: "agent_event",
          payload: { agent_type: "edit" },
        },
      );
    }
  });

  it("commit: 1 行目だけ（マスク済み）・sha・files。sha が不正なら縮退", () => {
    expect(
      mapAgentEvent(ev("commit", { message: `fix: a ${GHP}\n\nbody ${GHS}`, sha: SHA, files: 4 })),
    ).toEqual({
      kind: "event",
      type: "commit",
      payload: { message: "fix: a [REDACTED]", sha: SHA, files: 4 },
    });
    expect(mapAgentEvent(ev("commit", { message: "m", sha: "zzz", files: 1 }))).toMatchObject({
      type: "agent_event",
    });
  });

  it("web: kind と host だけ。URL のパス・クエリ・資格・ポートは落ちる", () => {
    expect(
      mapAgentEvent(ev("web", { kind: "fetch", host: "docs.example.com", url: "https://x/y?q=1" })),
    ).toEqual({
      kind: "event",
      type: "web",
      payload: { kind: "fetch", host: "docs.example.com" },
    });
    expect(payloadOf(mapAgentEvent(ev("web", { kind: "fetch", host: "a.com/p?q=1" })))).toEqual({
      kind: "fetch",
    });
    expect(mapAgentEvent(ev("web", { kind: "crawl" }))).toMatchObject({ type: "agent_event" });
  });

  it("壊れた data でも落ちず、縮退する", () => {
    expect(mapAgentEvent({ seq: 1, ts: 1, type: "command", data: "not json" })).toEqual({
      kind: "event",
      type: "agent_event",
      payload: { agent_type: "command" },
    });
  });

  it("契約の STRUCTURED_EVENT_TYPES と、取り込みで扱う型が一致している", () => {
    expect([...STRUCTURED_EVENT_TYPES]).toEqual(["command", "edit", "commit", "web"]);
  });
});

describe("既存の型は変わらない", () => {
  it("tool_start / tool_end は従来どおり", () => {
    expect(mapAgentEvent(ev("tool_start", { callId: "c1", name: "bash", summary: "ls" }))).toEqual({
      kind: "event",
      type: "tool_start",
      payload: { call_id: "c1", name: "bash", summary: "ls" },
    });
  });
});
