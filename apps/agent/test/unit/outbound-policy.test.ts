import { describe, expect, it } from "vitest";
import { decideOutbound, gitRoute } from "../../src/outbound-policy";

const repo = { owner: "octocat", name: "Hello-World" };
const get = (url: string, opts = {}) => decideOutbound({ method: "GET", url }, opts);

describe("decideOutbound: GitHub", () => {
  it("info/refs?service=git-upload-pack の GET を許可する", () => {
    expect(
      get("https://github.com/octocat/Hello-World.git/info/refs?service=git-upload-pack", { repo }),
    ).toEqual({ allow: true });
  });

  it(".git なしの URL も許可する", () => {
    expect(
      get("https://github.com/octocat/Hello-World/info/refs?service=git-upload-pack", { repo })
        .allow,
    ).toBe(true);
  });

  it("git-upload-pack の POST を許可する", () => {
    expect(
      decideOutbound(
        { method: "POST", url: "https://github.com/octocat/Hello-World.git/git-upload-pack" },
        { repo },
      ).allow,
    ).toBe(true);
  });

  it("git-receive-pack（push）は拒否する", () => {
    const a = get("https://github.com/octocat/Hello-World.git/info/refs?service=git-receive-pack");
    const b = decideOutbound(
      { method: "POST", url: "https://github.com/octocat/Hello-World.git/git-receive-pack" },
      { repo },
    );
    expect(a.allow).toBe(false);
    expect(b.allow).toBe(false);
  });

  it("対象リポジトリ以外は拒否する（大文字小文字は区別しない）", () => {
    expect(
      get("https://github.com/other/thing.git/info/refs?service=git-upload-pack", { repo }).allow,
    ).toBe(false);
    expect(
      get("https://GitHub.com/OCTOCAT/hello-world.git/info/refs?service=git-upload-pack", { repo })
        .allow,
    ).toBe(true);
  });

  it("GitHub の API や任意のパスは拒否する", () => {
    expect(get("https://github.com/octocat/Hello-World/archive/main.zip").allow).toBe(false);
    expect(get("https://api.github.com/user").allow).toBe(false);
    expect(
      decideOutbound(
        {
          method: "POST",
          url: "https://github.com/octocat/Hello-World.git/info/refs?service=git-upload-pack",
        },
        {},
      ).allow,
    ).toBe(false);
  });

  it("パスの .. や追加セグメントで repo 制限を迂回できない", () => {
    expect(
      get(
        "https://github.com/octocat/Hello-World.git/../../evil/x.git/info/refs?service=git-upload-pack",
        {
          repo,
        },
      ).allow,
    ).toBe(false);
    expect(
      get("https://github.com/octocat/Hello-World.git/x/info/refs?service=git-upload-pack").allow,
    ).toBe(false);
  });
});

describe("decideOutbound: パッケージレジストリ", () => {
  it.each(["registry.npmjs.org", "pypi.org", "files.pythonhosted.org"])(
    "%s の GET/HEAD を許可する",
    (host) => {
      expect(get(`https://${host}/x`).allow).toBe(true);
      expect(decideOutbound({ method: "HEAD", url: `https://${host}/x` }, {}).allow).toBe(true);
    },
  );

  it("レジストリへの POST/PUT は拒否する（情報流出の抑止）", () => {
    for (const method of ["POST", "PUT", "DELETE", "PATCH"]) {
      expect(decideOutbound({ method, url: "https://registry.npmjs.org/x" }, {}).allow).toBe(false);
    }
  });

  it("レジストリの同名サブドメインや後置ドメインは拒否する", () => {
    expect(get("https://evil.registry.npmjs.org/x").allow).toBe(false);
    expect(get("https://registry.npmjs.org.evil.com/x").allow).toBe(false);
  });
});

describe("decideOutbound: 拒否", () => {
  it.each([
    "https://example.com/",
    "http://registry.npmjs.org/x", // 平文 HTTP は許可しない
    "http://169.254.169.254/latest/meta-data/",
    "https://169.254.169.254/",
    "http://10.0.0.1/",
    "http://127.0.0.1:8080/",
    "https://[::1]/",
    "https://registry.npmjs.org:8443/x",
    "https://user:pw@registry.npmjs.org/x",
    "https://registry.npmjs.org./x",
  ])("%s", (url) => {
    const d = get(url);
    expect(d.allow).toBe(false);
  });

  it("拒否には理由を付ける", () => {
    const d = get("https://example.com/");
    expect(d).toEqual({
      allow: false,
      reason: expect.stringContaining("example.com"),
      code: "host_not_allowed",
    });
  });

  it("コードは固定の識別子で、入力（ホストやパス）を含まない", () => {
    const urls = [
      "https://evil-%s.example/x",
      "http://registry.npmjs.org/%s",
      "https://github.com/%s/x/info/refs?service=git-upload-pack",
    ];
    for (const u of urls) {
      const d = get(u.replace("%s", "secretvalue"), { repo });
      if (d.allow) throw new Error("unexpected allow");
      expect(d.code).toMatch(/^[a-z_]+$/);
      expect(d.code).not.toContain("secretvalue");
    }
  });

  it("不正な URL は拒否する", () => {
    expect(get("not a url").allow).toBe(false);
  });
});

describe("decideOutbound: Upgrade / CONNECT", () => {
  it("許可ホストでも WebSocket などの Upgrade は拒否する", () => {
    expect(
      decideOutbound({ method: "GET", url: "https://registry.npmjs.org/x", upgrade: true }, {})
        .allow,
    ).toBe(false);
  });

  it("CONNECT は拒否する", () => {
    expect(
      decideOutbound({ method: "CONNECT", url: "https://registry.npmjs.org/" }, {}).allow,
    ).toBe(false);
  });
});

describe("decideOutbound: リポジトリ未設定は fail-closed", () => {
  const urls = [
    "https://github.com/octocat/Hello-World.git/info/refs?service=git-upload-pack",
    "https://github.com/anything/else/info/refs?service=git-upload-pack",
  ];
  it.each(urls)("repo が無ければ github.com は何も許可しない: %s", (url) => {
    expect(decideOutbound({ method: "GET", url }, {}).allow).toBe(false);
    expect(decideOutbound({ method: "GET", url }).allow).toBe(false);
    expect(decideOutbound({ method: "GET", url }, { repo: undefined }).allow).toBe(false);
  });
  it("repo が無ければ git-upload-pack の POST も拒否する", () => {
    expect(
      decideOutbound(
        { method: "POST", url: "https://github.com/octocat/Hello-World.git/git-upload-pack" },
        {},
      ).allow,
    ).toBe(false);
  });
  it("別リポジトリの info/refs と git-upload-pack は、repo が設定されていても拒否する", () => {
    expect(
      get("https://github.com/evil/repo/info/refs?service=git-upload-pack", { repo }).allow,
    ).toBe(false);
    expect(
      decideOutbound(
        { method: "POST", url: "https://github.com/evil/repo.git/git-upload-pack" },
        { repo },
      ).allow,
    ).toBe(false);
  });
  it("レジストリは repo が無くても許可する", () => {
    expect(get("https://registry.npmjs.org/x").allow).toBe(true);
  });
});

describe("decideOutbound: GitHub の push（git-receive-pack）", () => {
  const branch = "agent/task-t1";
  const withBranch = { repo, branch };
  const post = (url: string, opts: { repo: typeof repo; branch?: string } = withBranch) =>
    decideOutbound({ method: "POST", url }, opts);
  const base = "https://github.com/octocat/Hello-World.git";

  it("作業ブランチがあるとき、info/refs?service=git-receive-pack の GET と git-receive-pack の POST を許可する", () => {
    expect(get(`${base}/info/refs?service=git-receive-pack`, withBranch)).toEqual({ allow: true });
    expect(post(`${base}/git-receive-pack`)).toEqual({ allow: true });
    expect(post("https://github.com/octocat/Hello-World/git-receive-pack").allow).toBe(true);
  });

  it("作業ブランチが無い・形が違うなら、push は何も許可しない（fail-closed）", () => {
    for (const opts of [
      { repo },
      { repo, branch: "main" },
      { repo, branch: "agent/task-" },
      { repo, branch: "x/agent/task-1" },
    ]) {
      expect(get(`${base}/info/refs?service=git-receive-pack`, opts)).toMatchObject({
        allow: false,
        code: "github_push_not_allowed",
      });
      expect(post(`${base}/git-receive-pack`, opts)).toMatchObject({ allow: false });
    }
    // upload-pack は作業ブランチの有無に関係なく通る
    expect(get(`${base}/info/refs?service=git-upload-pack`, { repo }).allow).toBe(true);
  });

  it("別のリポジトリへの push は拒否する", () => {
    expect(
      get("https://github.com/octocat/Other/info/refs?service=git-receive-pack", withBranch),
    ).toMatchObject({
      allow: false,
      code: "github_other_repo",
    });
    expect(post("https://github.com/evil/Hello-World/git-receive-pack")).toMatchObject({
      allow: false,
      code: "github_other_repo",
    });
  });

  it("query は service だけ。余計な query・別の service・GET の receive-pack・POST の info/refs は拒否する", () => {
    expect(get(`${base}/info/refs?service=git-receive-pack&x=1`, withBranch).allow).toBe(false);
    expect(get(`${base}/info/refs?x=1&service=git-receive-pack`, withBranch).allow).toBe(false);
    expect(
      get(`${base}/info/refs?service=git-receive-pack&service=git-upload-pack`, withBranch).allow,
    ).toBe(false);
    expect(get(`${base}/info/refs?service=git-foo`, withBranch).allow).toBe(false);
    expect(get(`${base}/git-receive-pack`, withBranch).allow).toBe(false);
    expect(post(`${base}/git-receive-pack?x=1`).allow).toBe(false);
    expect(post(`${base}/info/refs?service=git-receive-pack`).allow).toBe(false);
  });

  it("dumb HTTP・LFS・余計なセグメントは拒否する", () => {
    expect(get(`${base}/HEAD`, withBranch).allow).toBe(false);
    expect(post(`${base}/info/lfs/objects/batch`).allow).toBe(false);
    expect(post(`${base}/x/git-receive-pack`).allow).toBe(false);
  });
});

describe("gitRoute", () => {
  const u = (s: string) => new URL(s);
  const base = "https://github.com/octocat/Hello-World.git";
  it("許可の判定ではなく、git の段階を分類する", () => {
    expect(gitRoute("GET", u(`${base}/info/refs?service=git-upload-pack`))).toBe(
      "upload-pack-advert",
    );
    expect(gitRoute("GET", u(`${base}/info/refs?service=git-receive-pack`))).toBe(
      "receive-pack-advert",
    );
    expect(gitRoute("POST", u(`${base}/git-upload-pack`))).toBe("upload-pack");
    expect(gitRoute("POST", u(`${base}/git-receive-pack`))).toBe("receive-pack");
  });
  it("github.com 以外・形が違うものは undefined", () => {
    expect(gitRoute("POST", u("https://registry.npmjs.org/git-receive-pack"))).toBeUndefined();
    expect(gitRoute("GET", u(`${base}/git-receive-pack`))).toBeUndefined();
    expect(gitRoute("GET", u(`${base}/info/refs`))).toBeUndefined();
    expect(gitRoute("POST", u(`${base}/info/refs?service=git-receive-pack`))).toBeUndefined();
  });
});
