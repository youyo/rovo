import { describe, expect, it } from "vitest";
import { decideOutbound } from "../../src/outbound-policy";

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
      get("https://github.com/octocat/Hello-World/info/refs?service=git-upload-pack").allow,
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
    expect(d).toEqual({ allow: false, reason: expect.stringContaining("example.com") });
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
