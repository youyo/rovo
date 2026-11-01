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
  it.each([
    "registry.npmjs.org",
    "pypi.org",
    "files.pythonhosted.org",
    "proxy.golang.org",
    "sum.golang.org",
  ])("%s の GET/HEAD を許可する", (host) => {
    expect(get(`https://${host}/x`).allow).toBe(true);
    expect(decideOutbound({ method: "HEAD", url: `https://${host}/x` }, {}).allow).toBe(true);
  });

  it.each(["proxy.golang.org", "sum.golang.org"])(
    "%s への POST などは registry_method で拒否する",
    (host) => {
      for (const method of ["POST", "PUT", "DELETE", "PATCH"]) {
        const d = decideOutbound({ method, url: `https://${host}/x` }, {});
        expect(d.allow).toBe(false);
        if (!d.allow) expect(d.code).toBe("registry_method");
      }
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

describe("decideOutbound: Go のモジュール zip の配布元（storage.googleapis.com の限定パス）", () => {
  const signed =
    "https://storage.googleapis.com/proxy-golang-org-prod/abc123-golang.org:x:text-v0.14.0.zip?Expires=1&GoogleAccessId=x%40y.iam.gserviceaccount.com&Signature=AbC%2Bd%3D";
  const code = (d: ReturnType<typeof decideOutbound>) => (d.allow ? "allow" : d.code);

  it("署名付き query を含む実際の形の GET/HEAD を許可する", () => {
    expect(get(signed).allow).toBe(true);
    expect(decideOutbound({ method: "HEAD", url: signed }, {}).allow).toBe(true);
  });

  it("別のバケットは host_not_allowed", () => {
    expect(code(get("https://storage.googleapis.com/other-bucket/x.zip"))).toBe("host_not_allowed");
    expect(code(get("https://storage.googleapis.com/"))).toBe("host_not_allowed");
    expect(code(get("https://storage.googleapis.com/proxy-golang-org-prodx/x.zip"))).toBe(
      "host_not_allowed",
    );
    expect(code(get("https://storage.googleapis.com/other/proxy-golang-org-prod/x"))).toBe(
      "host_not_allowed",
    );
  });

  it("バケット名の指定を query に置いても許可しない", () => {
    expect(code(get("https://storage.googleapis.com/other-bucket/x?/proxy-golang-org-prod/"))).toBe(
      "host_not_allowed",
    );
  });

  it("パスの .. やエンコードされた区切りで別のバケットへ抜けられない", () => {
    for (const path of [
      "/proxy-golang-org-prod/../other/x",
      "/proxy-golang-org-prod/%2e%2e/other/x",
      "/proxy-golang-org-prod/%2E%2E/other/x",
      "/proxy-golang-org-prod/.%2e/other/x",
      "/proxy-golang-org-prod/..%2fother/x",
      "/proxy-golang-org-prod%2f../other/x",
      "/proxy-golang-org-prod/..\\other/x",
    ]) {
      expect(get(`https://storage.googleapis.com${path}`).allow, path).toBe(false);
    }
  });

  it("POST などは registry_method", () => {
    for (const method of ["POST", "PUT", "DELETE", "PATCH"]) {
      expect(code(decideOutbound({ method, url: signed }, {}))).toBe("registry_method");
    }
  });

  it("別ポート・http・別ホスト名は許可しない", () => {
    expect(get("http://storage.googleapis.com/proxy-golang-org-prod/x").allow).toBe(false);
    expect(get("https://storage.googleapis.com:8443/proxy-golang-org-prod/x").allow).toBe(false);
    expect(get("https://evil.storage.googleapis.com/proxy-golang-org-prod/x").allow).toBe(false);
  });
});

describe("decideOutbound: Takumi Guard（npm.flatt.tech）", () => {
  const code = (d: ReturnType<typeof decideOutbound>) => (d.allow ? "allow" : d.code);

  it("GET / HEAD を許可する（npm のレジストリと同じ扱い）", () => {
    expect(get("https://npm.flatt.tech/is-odd").allow).toBe(true);
    expect(decideOutbound({ method: "HEAD", url: "https://npm.flatt.tech/is-odd" }).allow).toBe(
      true,
    );
  });

  it("POST などは registry_method", () => {
    for (const method of ["POST", "PUT", "DELETE", "PATCH"]) {
      expect(
        code(decideOutbound({ method, url: "https://npm.flatt.tech/-/npm/v1/security" })),
      ).toBe("registry_method");
    }
  });

  it("同名のサブドメインや後置ドメインは許可しない", () => {
    expect(get("https://evil.npm.flatt.tech/x").allow).toBe(false);
    expect(get("https://npm.flatt.tech.evil.com/x").allow).toBe(false);
  });
});

describe("decideOutbound: mise が焼いていない node を取る配布元（nodejs.org の /dist/ だけ）", () => {
  const code = (d: ReturnType<typeof decideOutbound>) => (d.allow ? "allow" : d.code);
  const v = "24.21.0";

  it("版の一覧・本体・チェックサム・署名の GET / HEAD を許可する", () => {
    for (const path of [
      "/dist/index.json",
      `/dist/v${v}/node-v${v}-linux-x64.tar.gz`,
      `/dist/v${v}/node-v${v}-linux-arm64.tar.gz`,
      `/dist/v${v}/SHASUMS256.txt`,
      `/dist/v${v}/SHASUMS256.txt.sig`,
    ]) {
      expect(code(get(`https://nodejs.org${path}`)), path).toBe("allow");
      expect(code(decideOutbound({ method: "HEAD", url: `https://nodejs.org${path}` })), path).toBe(
        "allow",
      );
    }
  });

  it("/dist/ 以外は host_not_allowed", () => {
    for (const path of ["/", "/en/", "/dist", "/distx/index.json", "/api/dist/index.json"]) {
      expect(code(get(`https://nodejs.org${path}`)), path).toBe("host_not_allowed");
    }
  });

  it("POST などは registry_method", () => {
    for (const method of ["POST", "PUT", "DELETE", "PATCH"]) {
      expect(code(decideOutbound({ method, url: "https://nodejs.org/dist/index.json" }))).toBe(
        "registry_method",
      );
    }
  });

  it("パスの抜け（%2f・%2e・..）で /dist/ の外へ出られない", () => {
    for (const path of ["/dist/..%2fen/", "/dist/%2e%2e/en/", "/dist/../en/"]) {
      expect(get(`https://nodejs.org${path}`).allow, path).toBe(false);
    }
  });

  it("別のホスト名（www・unofficial-builds・後置ドメイン）は許可しない", () => {
    expect(get("https://www.nodejs.org/dist/index.json").allow).toBe(false);
    expect(get("https://unofficial-builds.nodejs.org/download/release/index.json").allow).toBe(
      false,
    );
    expect(get("https://nodejs.org.evil.com/dist/index.json").allow).toBe(false);
  });
});

describe("decideOutbound: mise が焼いていない python を取る配布元（python-build-standalone）", () => {
  const code = (d: ReturnType<typeof decideOutbound>) => (d.allow ? "allow" : d.code);
  const repo = { owner: "octocat", name: "Hello-World" };
  const asset =
    "https://github.com/astral-sh/python-build-standalone/releases/download/20251014/cpython-3.12.12+20251014-x86_64-unknown-linux-gnu-install_only_stripped.tar.gz";

  it("mise-versions.jdx.dev は python の precompiled の一覧（/data/python-precompiled-）だけ", () => {
    expect(
      code(
        get("https://mise-versions.jdx.dev/data/python-precompiled-x86_64-unknown-linux-gnu.gz"),
      ),
    ).toBe("allow");
    expect(
      code(
        get("https://mise-versions.jdx.dev/data/python-precompiled-aarch64-unknown-linux-gnu.gz"),
      ),
    ).toBe("allow");
    for (const path of ["/", "/data/node.toml", "/data/python.toml", "/t?tool=node", "/data/"]) {
      expect(code(get(`https://mise-versions.jdx.dev${path}`)), path).toBe("host_not_allowed");
    }
    expect(
      code(
        decideOutbound({
          method: "POST",
          url: "https://mise-versions.jdx.dev/data/python-precompiled-x86_64-unknown-linux-gnu.gz",
        }),
      ),
    ).toBe("registry_method");
  });

  it("github.com の astral-sh/python-build-standalone の /releases/download/ の GET / HEAD を許可する（repo の設定に関係なく）", () => {
    expect(code(get(asset))).toBe("allow");
    expect(code(get(asset, { repo }))).toBe("allow");
    expect(code(decideOutbound({ method: "HEAD", url: asset }))).toBe("allow");
    expect(
      code(
        get(
          "https://github.com/astral-sh/python-build-standalone/releases/download/20251014/SHA256SUMS",
        ),
      ),
    ).toBe("allow");
  });

  it("POST などは registry_method", () => {
    for (const method of ["POST", "PUT", "DELETE", "PATCH"]) {
      expect(code(decideOutbound({ method, url: asset }, { repo }))).toBe("registry_method");
    }
  });

  it("ほかのリポジトリ（タスクのリポジトリを含む）の releases は拒否する", () => {
    for (const url of [
      "https://github.com/evil/python-build-standalone/releases/download/1/x.tar.gz",
      "https://github.com/astral-sh/uv/releases/download/0.8.22/uv.tar.gz",
      "https://github.com/astral-sh/python-build-standalone-x/releases/download/1/x.tar.gz",
      "https://github.com/octocat/Hello-World/releases/download/v1/x.tar.gz",
      "https://github.com/jdx/mise/releases/download/v2026.10.25/mise.tar.gz",
    ]) {
      expect(code(get(url, { repo })), url).toBe("github_path");
    }
  });

  it("同じリポジトリでも /releases/download/ 以外（latest・tag・archive・API）は拒否する", () => {
    for (const path of [
      "/astral-sh/python-build-standalone/releases",
      "/astral-sh/python-build-standalone/releases/latest",
      "/astral-sh/python-build-standalone/releases/tag/20251014",
      "/astral-sh/python-build-standalone/archive/refs/heads/main.zip",
      "/astral-sh/python-build-standalone/releases/downloadx/1/x",
    ]) {
      expect(get(`https://github.com${path}`, { repo }).allow, path).toBe(false);
    }
    expect(
      get("https://api.github.com/repos/astral-sh/python-build-standalone/releases").allow,
    ).toBe(false);
  });

  it("パスの抜け（..・%2f・%2e・%5c）でほかのリポジトリへ出られない", () => {
    for (const path of [
      "/astral-sh/python-build-standalone/releases/download/../../../../evil/x/releases/download/1/x",
      "/astral-sh/python-build-standalone/releases/download/..%2f..%2f..%2f..%2fevil/x",
      "/astral-sh/python-build-standalone/releases/download/%2e%2e/%2e%2e/%2e%2e/%2e%2e/evil/x",
      "/astral-sh/python-build-standalone/releases/download/..%5c..%5cevil/x",
      "/astral-sh%2fpython-build-standalone/releases/download/1/x",
    ]) {
      expect(get(`https://github.com${path}`, { repo }).allow, path).toBe(false);
    }
  });

  it("releases の配布物のリダイレクト先（release-assets.githubusercontent.com）は、このリポジトリの ID のパスだけ", () => {
    const signed =
      "https://release-assets.githubusercontent.com/github-production-release-asset/162334160/a5728c4e-7f3d-4eb4-a394-ec620039da16?sp=r&sv=2018-11-09&sr=b&spr=https&se=2026-01-01T00%3A00%3A00Z&rscd=attachment%3B+filename%3Dcpython.tar.gz&sig=AbC%2Bd%3D";
    expect(code(get(signed))).toBe("allow");
    expect(code(decideOutbound({ method: "HEAD", url: signed }))).toBe("allow");
    for (const path of [
      "/",
      "/github-production-release-asset/1/a5728c4e",
      "/github-production-release-asset/1623341600/a5728c4e",
      "/github-production-release-asset/16233416/a5728c4e",
      "/other/162334160/a5728c4e",
      "/github-production-release-asset/162334160/../1/a5728c4e",
      "/github-production-release-asset/162334160/..%2f1/a5728c4e",
    ]) {
      expect(get(`https://release-assets.githubusercontent.com${path}`).allow, path).toBe(false);
    }
    expect(
      code(
        get(
          "https://release-assets.githubusercontent.com/x?/github-production-release-asset/162334160/",
        ),
      ),
    ).toBe("host_not_allowed");
    for (const method of ["POST", "PUT", "DELETE", "PATCH"]) {
      expect(code(decideOutbound({ method, url: signed }))).toBe("registry_method");
    }
  });

  it("旧来のリダイレクト先（objects.githubusercontent.com）も、このリポジトリの ID のパスだけ", () => {
    const signed =
      "https://objects.githubusercontent.com/github-production-release-asset-2e65be/162334160/a5728c4e-7f3d-4eb4-a394-ec620039da16?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Signature=abc";
    expect(code(get(signed))).toBe("allow");
    for (const path of [
      "/",
      "/github-production-release-asset-2e65be/1/a5728c4e",
      "/github-production-release-asset-2e65be/1623341600/a5728c4e",
      "/github-production-repository-file-5c1aeb/162334160/x",
    ]) {
      expect(get(`https://objects.githubusercontent.com${path}`).allow, path).toBe(false);
    }
    expect(code(decideOutbound({ method: "POST", url: signed }))).toBe("registry_method");
  });

  it("GitHub のほかのコンテンツのホストは許可しない", () => {
    for (const url of [
      "https://raw.githubusercontent.com/astral-sh/python-build-standalone/main/README.md",
      "https://codeload.github.com/astral-sh/python-build-standalone/tar.gz/main",
      "https://evil.release-assets.githubusercontent.com/github-production-release-asset/162334160/x",
    ]) {
      expect(get(url).allow, url).toBe(false);
    }
  });
});
