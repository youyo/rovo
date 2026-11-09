import { describe, expect, it } from "vitest";
import {
  allowedRef,
  buildTestUpstreamUrl,
  buildUpstreamHeaders,
  classifyDestination,
  limitBody,
} from "../../src/outbound-gateway";

describe("buildUpstreamHeaders", () => {
  it("許可リストのヘッダだけを渡し、Authorization / Cookie / Host などは落とす", () => {
    const out = buildUpstreamHeaders(
      new Headers({
        authorization: "Bearer secret",
        cookie: "sid=1",
        host: "evil.example",
        "x-forwarded-for": "1.2.3.4",
        "x-custom": "leak",
        accept: "application/json",
        "user-agent": "git/2.x",
        "git-protocol": "version=2",
        "content-type": "application/x-git-upload-pack-request",
        "content-encoding": "gzip",
      }),
    );
    expect(Object.fromEntries(out.entries())).toEqual({
      accept: "application/json",
      "user-agent": "git/2.x",
      "git-protocol": "version=2",
      "content-type": "application/x-git-upload-pack-request",
      "content-encoding": "gzip",
    });
  });
});

describe("buildTestUpstreamUrl（テスト用転送先の組み立て）", () => {
  it("通常のパスは転送先の origin に付く", () => {
    expect(
      buildTestUpstreamUrl("http://127.0.0.1:9000", new URL("https://github.com/a/b?x=1")).href,
    ).toBe("http://127.0.0.1:9000/a/b?x=1");
  });
  it("//host で始まる pathname でも転送先の origin を置き換えられない", () => {
    const u = buildTestUpstreamUrl(
      "http://127.0.0.1:9000",
      new URL("https://registry.npmjs.org//example.com/x"),
    );
    expect(u.origin).toBe("http://127.0.0.1:9000");
    expect(u.pathname).toBe("//example.com/x");
  });
});

describe("classifyDestination", () => {
  it("github / registry / other に分類し、ホスト名そのものは返さない", () => {
    expect(classifyDestination("github.com")).toBe("github");
    expect(classifyDestination("registry.npmjs.org")).toBe("registry");
    expect(classifyDestination("pypi.org")).toBe("registry");
    expect(classifyDestination("proxy.golang.org")).toBe("registry");
    expect(classifyDestination("sum.golang.org")).toBe("registry");
    expect(classifyDestination("evil.example")).toBe("other");
    // storage.googleapis.com は、Go のモジュール zip のバケットのパスだけが registry
    expect(classifyDestination("storage.googleapis.com", "/proxy-golang-org-prod/a.zip")).toBe(
      "registry",
    );
    expect(classifyDestination("storage.googleapis.com", "/other-bucket/a.zip")).toBe("other");
    expect(classifyDestination("storage.googleapis.com")).toBe("other");
    expect(classifyDestination("169.254.169.254")).toBe("other");
  });

  it("mise 用の配布元（パス限定）と Takumi Guard は registry。github.com の releases の配布物・api.github.com の releases・Terraform の配布元も registry", () => {
    expect(classifyDestination("npm.flatt.tech")).toBe("registry");
    expect(classifyDestination("nodejs.org", "/dist/index.json")).toBe("registry");
    expect(classifyDestination("nodejs.org", "/en/")).toBe("other");
    expect(
      classifyDestination(
        "mise-versions.jdx.dev",
        "/data/python-precompiled-x86_64-unknown-linux-gnu.gz",
      ),
    ).toBe("registry");
    expect(classifyDestination("mise-versions.jdx.dev", "/data/node.toml")).toBe("other");
    expect(
      classifyDestination(
        "github.com",
        "/astral-sh/python-build-standalone/releases/download/1/x.tar.gz",
      ),
    ).toBe("registry");
    expect(classifyDestination("github.com", "/any/repo/releases/download/1/x")).toBe("registry");
    expect(classifyDestination("github.com", "/any/repo.git/info/refs")).toBe("github");
    expect(classifyDestination("github.com", "/any/repo/releases/latest")).toBe("github");
    expect(
      classifyDestination(
        "release-assets.githubusercontent.com",
        "/github-production-release-asset/162334160/x",
      ),
    ).toBe("registry");
    expect(
      classifyDestination(
        "release-assets.githubusercontent.com",
        "/github-production-release-asset/1/x",
      ),
    ).toBe("registry");
    expect(classifyDestination("release-assets.githubusercontent.com", "/other/1/x")).toBe("other");
    expect(
      classifyDestination("api.github.com", "/repos/terraform-linters/tflint/releases/latest"),
    ).toBe("registry");
    expect(classifyDestination("api.github.com", "/user")).toBe("other");
    expect(
      classifyDestination("registry.terraform.io", "/v1/providers/hashicorp/aws/versions"),
    ).toBe("registry");
    expect(classifyDestination("registry.terraform.io", "/v1/modules/a/b/c/versions")).toBe(
      "other",
    );
    expect(classifyDestination("releases.hashicorp.com", "/terraform/1.15.8/x.zip")).toBe(
      "registry",
    );
  });
});

describe("limitBody", () => {
  const stream = (chunks: string[]) =>
    new ReadableStream<Uint8Array>({
      start(c) {
        for (const s of chunks) c.enqueue(new TextEncoder().encode(s));
        c.close();
      },
    });
  it("上限以内ならそのまま通す", async () => {
    const out = await new Response(limitBody(stream(["abc", "def"]), 10)).text();
    expect(out).toBe("abcdef");
  });
  it("上限を超えたら読み取りがエラーになる", async () => {
    await expect(new Response(limitBody(stream(["abcdef", "ghijkl"]), 8)).text()).rejects.toThrow(
      /too large/,
    );
  });
});

describe("allowedRef（push を許す唯一の ref）", () => {
  const repo = { owner: "acme", name: "hello" };
  it("branchTaskId（積み足しの根。gateway 由来）があればそれ、無ければ taskId から作る。refs/heads/ を含む", () => {
    expect(allowedRef({ repo, taskId: "t1" })).toBe("refs/heads/agent/task-t1");
    expect(allowedRef({ repo, taskId: "c1", branchTaskId: "r1" })).toBe("refs/heads/agent/task-r1");
  });

  it("props.task（作業ブランチ名。依存のキャッシュ側では弱い検査の値が入る）は見ない", () => {
    expect(allowedRef({ repo, task: "agent/task-evil", taskId: "t1" })).toBe(
      "refs/heads/agent/task-t1",
    );
    expect(allowedRef({ repo, task: "main", taskId: "c1", branchTaskId: "r1" })).toBe(
      "refs/heads/agent/task-r1",
    );
  });

  it("^[A-Za-z0-9_-]+$ 以外は undefined（fail-closed）。branchTaskId が不正でも taskId に戻らない", () => {
    for (const bad of ["", "a/b", "a.b", "../main", "a b", "x\n", "r1:refs/heads/main"]) {
      expect(allowedRef({ repo, taskId: bad }), JSON.stringify(bad)).toBeUndefined();
      expect(allowedRef({ repo, taskId: "t1", branchTaskId: bad }), JSON.stringify(bad)).toBe(
        undefined,
      );
    }
  });

  it("返す ref は必ず ^refs/heads/agent/task-[A-Za-z0-9_-]+$ に一致する", () => {
    for (const id of ["t1", "01HZX", "a_b-c", "R"]) {
      for (const props of [
        { repo, taskId: id },
        { repo, taskId: "t1", branchTaskId: id },
      ]) {
        expect(allowedRef(props)).toMatch(/^refs\/heads\/agent\/task-[A-Za-z0-9_-]+$/);
      }
    }
  });
});
