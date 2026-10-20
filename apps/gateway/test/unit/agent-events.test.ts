import { describe, expect, it } from "vitest";
import { mapAgentEvent } from "../../src/agent/agent-events";

const payloadOf = (m: ReturnType<typeof mapAgentEvent>): Record<string, unknown> =>
  "payload" in m ? m.payload : {};
const ev = (type: string, data: unknown) => ({ seq: 1, ts: 1, type, data: JSON.stringify(data) });

describe("push のイベント", () => {
  it("pushed は sha と final を公開する", () => {
    expect(mapAgentEvent(ev("pushed", { sha: "a".repeat(40), final: true }))).toEqual({
      kind: "event",
      type: "pushed",
      payload: { sha: "a".repeat(40), final: true },
    });
    expect(mapAgentEvent(ev("pushed", { sha: "b".repeat(40) }))).toMatchObject({
      type: "pushed",
      payload: { sha: "b".repeat(40), final: false },
    });
  });

  it("push_failed は sha とメッセージ（切り詰め）を公開する", () => {
    const m = mapAgentEvent(ev("push_failed", { sha: "c".repeat(40), message: "x".repeat(900) }));
    expect(m).toMatchObject({ kind: "event", type: "push_failed" });
    const p = (m as { payload: Record<string, unknown> }).payload;
    expect(p.sha).toBe("c".repeat(40));
    expect(String(p.message).length).toBeLessThanOrEqual(501);
    expect(p.final).toBe(false);
  });

  it("壊れた data でも落ちない", () => {
    expect(mapAgentEvent({ seq: 1, ts: 1, type: "pushed", data: "not json" })).toMatchObject({
      type: "pushed",
      payload: { sha: null, final: false },
    });
  });
});

describe("Phase 4 の対話イベント", () => {
  it("phase input_required は INPUT_REQUIRED に写る", () => {
    expect(mapAgentEvent(ev("phase", { phase: "input_required" }))).toEqual({
      kind: "phase",
      status: "INPUT_REQUIRED",
    });
  });

  it("question は question_id・message・options（JSON 文字列のまま）を公開する", () => {
    const options = JSON.stringify(["a", "b"]);
    expect(mapAgentEvent(ev("question", { question_id: "q1", message: "hi", options }))).toEqual({
      kind: "question",
      payload: { question_id: "q1", message: "hi", options },
    });
  });

  it("question の本文は 4,000 文字まで。それより長い分は切り、10 個の options は欠けない", () => {
    const options = JSON.stringify(Array.from({ length: 10 }, (_, i) => `${i}${"x".repeat(499)}`));
    const m = mapAgentEvent(
      ev("question", { question_id: "q", message: "m".repeat(5_000), options }),
    );
    if (m.kind !== "question") throw new Error("not a question");
    expect(String(m.payload.message)).toHaveLength(4_000);
    expect(m.payload.options).toBe(options);
    const exact = mapAgentEvent(
      ev("question", { question_id: "q", message: "m".repeat(4_000), options }),
    );
    expect(payloadOf(exact).message).toHaveLength(4_000);
  });

  it("question の options が壊れている・配列でないときは空配列にする。question_id が無ければ空文字", () => {
    for (const options of ["not json", '{"a":1}', 5, null]) {
      const m = mapAgentEvent(ev("question", { question_id: "q", message: "m", options }));
      expect(payloadOf(m).options).toBe("[]");
    }
    const m = mapAgentEvent(ev("question", { message: "m" }));
    expect(payloadOf(m).question_id).toBe("");
  });

  it("answered / steer_accepted は ID だけを公開する", () => {
    expect(mapAgentEvent(ev("answered", { question_id: "q1", secret: "x" }))).toEqual({
      kind: "event",
      type: "answered",
      payload: { question_id: "q1" },
    });
    expect(mapAgentEvent(ev("steer_accepted", { steer_id: "s1", secret: "x" }))).toEqual({
      kind: "event",
      type: "steer_accepted",
      payload: { steer_id: "s1" },
    });
  });
});

describe("usage の web の回数（Phase 5）", () => {
  it("usage は web の回数を公開する（task_wait の usage イベント）", () => {
    const m = mapAgentEvent(
      ev("usage", {
        costUsd: 1.5,
        inputTokens: 10,
        outputTokens: 5,
        cacheReadTokens: 1,
        cacheWriteTokens: 2,
        web: { search: 3, fetch: 4, browse: 1 },
      }),
    );
    expect(m).toEqual({
      kind: "usage",
      costMicroUsd: 1_500_000,
      payload: {
        cost_usd: 1.5,
        input_tokens: 10,
        output_tokens: 5,
        cache_read_tokens: 1,
        cache_write_tokens: 2,
        web_search: 3,
        web_fetch: 4,
        web_browse: 1,
      },
    });
  });

  it("web が無い・壊れている usage は 0 回として扱う", () => {
    for (const data of [
      { costUsd: 1 },
      { costUsd: 1, web: "x" },
      { costUsd: 1, web: { search: -1, fetch: "a" } },
    ]) {
      expect(payloadOf(mapAgentEvent(ev("usage", data)))).toMatchObject({
        web_search: 0,
        web_fetch: 0,
        web_browse: 0,
      });
    }
  });
});

describe("usage の sandbox（Phase 6 M3）", () => {
  const base = { costUsd: 1 };

  it("sandbox:{runtimeMs, restarts, bootRetries} を公開用の sandbox_* に写す", () => {
    const p = payloadOf(
      mapAgentEvent(
        ev("usage", { ...base, sandbox: { runtimeMs: 90_500, restarts: 2, bootRetries: 1 } }),
      ),
    );
    expect(p).toMatchObject({
      sandbox_runtime_ms: 90_500,
      sandbox_restarts: 2,
      sandbox_boot_retries: 1,
    });
  });

  it("sandbox の一部が欠けている・壊れている値は 0 にする", () => {
    for (const sandbox of [
      {},
      { runtimeMs: -5, restarts: "x", bootRetries: null },
      { runtimeMs: Number.NaN, restarts: 1.5 },
    ]) {
      expect(payloadOf(mapAgentEvent(ev("usage", { ...base, sandbox })))).toMatchObject({
        sandbox_runtime_ms: 0,
        sandbox_restarts: 0,
        sandbox_boot_retries: 0,
      });
    }
    expect(
      payloadOf(mapAgentEvent(ev("usage", { ...base, sandbox: { runtimeMs: 10.9 } }))),
    ).toMatchObject({ sandbox_runtime_ms: 10, sandbox_restarts: 0 });
  });

  it("sandbox 自体が無い（agent が読めなかった）usage には sandbox_* を付けない（0 回と区別する）", () => {
    for (const data of [base, { ...base, sandbox: "x" }, { ...base, sandbox: null }]) {
      const p = payloadOf(mapAgentEvent(ev("usage", data)));
      expect(Object.keys(p).some((k) => k.startsWith("sandbox_"))).toBe(false);
    }
  });
});

describe("audit イベント（Phase 6 M3）", () => {
  it("agent_cancelled は固定コードだけを audit として公開する", () => {
    expect(mapAgentEvent(ev("audit", { code: "agent_cancelled" }))).toEqual({
      kind: "event",
      type: "audit",
      payload: { code: "agent_cancelled" },
    });
  });

  it("sandbox_privileged_op は code と、固定の op だけを公開する", () => {
    for (const op of ["terminate", "set_deadline", "extend_deadline"]) {
      expect(
        mapAgentEvent(ev("audit", { code: "sandbox_privileged_op", op, message: "leak" })),
      ).toEqual({ kind: "event", type: "audit", payload: { code: "sandbox_privileged_op", op } });
    }
  });

  it("未知の code・op・形の合わない値は、中身を出さず agent_event に落とす", () => {
    for (const data of [
      { code: "something_else" },
      { code: "sandbox_privileged_op", op: "rm -rf" },
      { code: "sandbox_privileged_op" },
      { code: 5 },
      { code: "agent_cancelled\nsecret ghs_abc" },
      {},
    ]) {
      expect(mapAgentEvent(ev("audit", data))).toEqual({
        kind: "event",
        type: "agent_event",
        payload: { agent_type: "audit" },
      });
    }
  });
});

describe("usage の依存関係のキャッシュ（D14）", () => {
  const base = { costUsd: 1 };

  it("sandbox.depsCache と cacheBuildMs を deps_cache / cache_build_ms に写す", () => {
    const p = payloadOf(
      mapAgentEvent(
        ev("usage", {
          ...base,
          sandbox: {
            runtimeMs: 100,
            restarts: 0,
            bootRetries: 0,
            depsCache: "built",
            cacheBuildMs: 42_500.9,
          },
        }),
      ),
    );
    expect(p).toMatchObject({ deps_cache: "built", cache_build_ms: 42_500 });
  });

  it("hit / miss / disabled はそのまま。cacheBuildMs が無い・0 のときは cache_build_ms を付けない", () => {
    for (const depsCache of ["hit", "miss", "disabled"]) {
      const p = payloadOf(
        mapAgentEvent(ev("usage", { ...base, sandbox: { runtimeMs: 1, depsCache } })),
      );
      expect(p.deps_cache).toBe(depsCache);
      expect(p).not.toHaveProperty("cache_build_ms");
    }
  });

  it("表に無い値・壊れた値は公開しない（任意の文字列を流さない）", () => {
    for (const depsCache of ["BUILT", "x".repeat(500), 1, null, {}, ["hit"]]) {
      const p = payloadOf(
        mapAgentEvent(
          ev("usage", { ...base, sandbox: { runtimeMs: 1, depsCache, cacheBuildMs: -3 } }),
        ),
      );
      expect(p).not.toHaveProperty("deps_cache");
      expect(p).not.toHaveProperty("cache_build_ms");
    }
  });

  it("sandbox が無い usage には deps_cache を付けない", () => {
    expect(payloadOf(mapAgentEvent(ev("usage", base)))).not.toHaveProperty("deps_cache");
  });
});
