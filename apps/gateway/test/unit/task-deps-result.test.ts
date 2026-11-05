import { describe, expect, it } from "vitest";
import { fakeAgent, newTaskId, sampleInput, taskStub } from "./helpers";

// D14: task_result の usage に deps_cache と cache_build_ms を出す（agent の usage.sandbox から）。

const OWNER = 703;

async function resultWith(sandbox: unknown) {
  const id = newTaskId();
  const stub = taskStub(id);
  const created = await stub.ensureCreated(sampleInput(id, OWNER));
  if (!created.ok) throw new Error("create");
  const agent = fakeAgent(id);
  await stub.advance();
  await agent.setProgram({
    result: {
      status: "completed",
      summary: "done",
      verification: { commands: [], results: [], verified: false, attempts: 0 },
      warnings: [],
      patchTooLarge: false,
      usage: {
        costUsd: 1,
        inputTokens: 1,
        outputTokens: 1,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        web: { search: 0, fetch: 0, browse: 0 },
        ...(sandbox !== undefined ? { sandbox: sandbox as never } : {}),
      },
    },
  });
  await agent.setPhase("completed");
  await stub.advance();
  const r = await stub.result(OWNER);
  if (!r.ok) throw new Error("result");
  return r.result.usage as Record<string, unknown>;
}

describe("task_result の usage（依存関係のキャッシュ）", () => {
  it("built: deps_cache と cache_build_ms を返す", async () => {
    const usage = await resultWith({
      runtimeMs: 90_000,
      restarts: 0,
      bootRetries: 0,
      depsCache: "built",
      cacheBuildMs: 60_000,
    });
    expect(usage).toMatchObject({ deps_cache: "built", cache_build_ms: 60_000 });
  });

  it("hit / miss / disabled は deps_cache と cache_build_ms: 0（集計しやすいよう常に出す）", async () => {
    for (const depsCache of ["hit", "miss", "disabled"]) {
      const usage = await resultWith({ runtimeMs: 1, restarts: 0, bootRetries: 0, depsCache });
      expect(usage.deps_cache).toBe(depsCache);
      expect(usage.cache_build_ms).toBe(0);
    }
  });

  it("miss のときだけ、使えなかった理由を deps_cache_miss_reason に返す（ログにしか出ていなかった固定コード）", async () => {
    for (const reason of ["build_failed", "cooldown", "snapshot_unsupported", "ensure_timeout"]) {
      const usage = await resultWith({
        runtimeMs: 1,
        restarts: 0,
        bootRetries: 0,
        depsCache: "miss",
        depsMissReason: reason,
      });
      expect(usage.deps_cache).toBe("miss");
      expect(usage.deps_cache_miss_reason).toBe(reason);
    }
  });

  it("miss 以外・理由が無い・表に無い値には deps_cache_miss_reason を付けない", async () => {
    for (const [depsCache, depsMissReason] of [
      ["hit", "build_failed"],
      ["built", "cooldown"],
      ["disabled", "build_failed"],
      ["miss", undefined],
      ["miss", "install exit=1 ERR_ASSERTION at /workspace"],
      ["miss", 3],
    ] as const) {
      const usage = await resultWith({ runtimeMs: 1, depsCache, depsMissReason });
      expect(usage).not.toHaveProperty("deps_cache_miss_reason");
    }
  });

  it("sandbox_runtime_ms を返す（小数は切り捨て）。sandbox が無ければ付けない", async () => {
    const usage = await resultWith({ runtimeMs: 90_500.9, depsCache: "hit" });
    expect(usage.sandbox_runtime_ms).toBe(90_500);
    expect(await resultWith(undefined)).not.toHaveProperty("sandbox_runtime_ms");
  });

  it("agent がカウンタを読めなかった（sandbox が無い）ときは、どちらも付けない", async () => {
    const usage = await resultWith(undefined);
    expect(usage).not.toHaveProperty("deps_cache");
    expect(usage).not.toHaveProperty("cache_build_ms");
  });

  it("表に無い値は返さない", async () => {
    const usage = await resultWith({ runtimeMs: 1, depsCache: "weird", cacheBuildMs: "x" });
    expect(usage).not.toHaveProperty("deps_cache");
    expect(usage).not.toHaveProperty("cache_build_ms");
  });

  it("deps_lang: Python / Go の導入の結果を返す（固定の値だけ。壊れた要素は捨てる）", async () => {
    const usage = await resultWith({
      runtimeMs: 1,
      restarts: 0,
      bootRetries: 0,
      depsCache: "disabled",
      depsLang: [
        { kind: "python", command: "uv sync --active", status: "ok", duration_ms: 1234 },
        { kind: "go", command: "go mod download", status: "timeout", duration_ms: 300000 },
        { kind: "ruby", command: "bundle", status: "ok", duration_ms: 1 },
        { kind: "go", command: "x", status: "weird", duration_ms: 1 },
      ],
    });
    expect(usage.deps_lang).toEqual([
      { kind: "python", command: "uv sync --active", status: "ok", duration_ms: 1234 },
      { kind: "go", command: "go mod download", status: "timeout", duration_ms: 300000 },
    ]);
  });

  it("deps_lang は何も入れていなければ付かない", async () => {
    const usage = await resultWith({ runtimeMs: 1, restarts: 0, bootRetries: 0, depsCache: "hit" });
    expect(usage).not.toHaveProperty("deps_lang");
  });

  it("npmrc_registry_hosts: 検証したホスト名だけ（最大 5 件）。無ければ付かない", async () => {
    const usage = await resultWith({
      runtimeMs: 1,
      restarts: 0,
      bootRetries: 0,
      npmrcRegistryHosts: [
        "npm.internal.example.com",
        "Bad Host",
        "x/y",
        // biome-ignore lint/suspicious/noTemplateCurlyInString: .npmrc の環境変数の書き方をそのまま試す
        "${TOKEN}",
        3,
        "a.example",
        "b.example",
        "c.example",
        "d.example",
        "e.example",
      ],
    });
    expect(usage.npmrc_registry_hosts).toEqual([
      "npm.internal.example.com",
      "a.example",
      "b.example",
      "c.example",
      "d.example",
    ]);
    expect(await resultWith({ runtimeMs: 1, npmrcRegistryHosts: "x" })).not.toHaveProperty(
      "npmrc_registry_hosts",
    );
    expect(await resultWith({ runtimeMs: 1 })).not.toHaveProperty("npmrc_registry_hosts");
  });

  it("mise_unavailable_tools: 安全な形の名前だけ（最大 5 件）。無ければ付かない", async () => {
    const usage = await resultWith({
      runtimeMs: 1,
      restarts: 0,
      bootRetries: 0,
      miseUnavailableTools: [
        "terraform",
        "aqua:hashicorp/terraform",
        "Bad Tool",
        "<b>x</b>",
        3,
        "-lead",
        "terraform",
        "a",
        "b",
        "c",
        "d",
      ],
    });
    expect(usage.mise_unavailable_tools).toEqual([
      "terraform",
      "aqua:hashicorp/terraform",
      "a",
      "b",
      "c",
    ]);
    expect(await resultWith({ runtimeMs: 1, miseUnavailableTools: "x" })).not.toHaveProperty(
      "mise_unavailable_tools",
    );
    expect(await resultWith({ runtimeMs: 1 })).not.toHaveProperty("mise_unavailable_tools");
  });

  it("outbound_denied: {host, reason, count} の正しい形だけ（最大 20 件）と合計", async () => {
    const usage = await resultWith({
      runtimeMs: 1,
      restarts: 0,
      bootRetries: 0,
      outboundDenied: [
        { host: "evil.example", reason: "host_not_allowed", count: 3 },
        { host: "github.com", reason: "github_other_repo", count: 1 },
        { host: "bad host", reason: "host_not_allowed", count: 1 },
        { host: "x.example", reason: "Not A Code!", count: 1 },
        { host: "x.example", reason: "registry_method", count: 1.5 },
        { host: "x.example", reason: "registry_method", count: 0 },
        { host: "x.example", reason: "registry_method", count: "2" },
        "junk",
      ],
      outboundDeniedTotal: 9,
    });
    expect(usage.outbound_denied).toEqual([
      { host: "evil.example", reason: "host_not_allowed", count: 3 },
      { host: "github.com", reason: "github_other_repo", count: 1 },
    ]);
    expect(usage.outbound_denied_total).toBe(9);
    const many = await resultWith({
      runtimeMs: 1,
      outboundDenied: Array.from({ length: 30 }, (_, i) => ({
        host: `h${i}.example`,
        reason: "host_not_allowed",
        count: 1,
      })),
      outboundDeniedTotal: 30,
    });
    expect(many.outbound_denied).toHaveLength(20);
  });

  it("outbound_denied は拒否が無ければ付かない", async () => {
    const usage = await resultWith({ runtimeMs: 1, restarts: 0, bootRetries: 0 });
    expect(usage).not.toHaveProperty("outbound_denied");
    expect(usage).not.toHaveProperty("outbound_denied_total");
  });
});
