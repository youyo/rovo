import { describe, expect, it } from "vitest";
import {
  goVersionMatches,
  isValidHostname,
  MISE_GO_VERSION_UNAVAILABLE,
  miseGoVersion,
  NPMRC_REGISTRY_NOT_ALLOWED,
  npmrcDiagnostics,
  repoDiagnostics,
} from "../../src/repo-diag";
import { GO_VERSION } from "../../src/sandbox-env";

// 作業ツリーのルートの .npmrc と mise.toml の診断（起動時。ワーカーと task_result の両方に伝える）。
// リポジトリ由来の値は、検証したホスト名と固定コードのほかには外へ出さない。

describe("isValidHostname", () => {
  it("小文字のホスト名だけを通す", () => {
    expect(isValidHostname("registry.example.com")).toBe(true);
    expect(isValidHostname("npm.pkg.github.com")).toBe(true);
    expect(isValidHostname("a")).toBe(true);
    for (const bad of [
      "",
      "Registry.Example.com",
      "evil.example/x",
      "evil example",
      "-bad.example",
      "bad-.example",
      "a..b",
      "x".repeat(64),
      `${"a.".repeat(130)}com`,
      "tok=en@host",
      // biome-ignore lint/suspicious/noTemplateCurlyInString: .npmrc の環境変数の書き方をそのまま試す
      "${NPM_HOST}",
      3,
      undefined,
    ]) {
      expect(isValidHostname(bad), String(bad)).toBe(false);
    }
  });
});

describe("npmrcDiagnostics", () => {
  it("registry= と @scope:registry= の許可されていないホストを拾う", () => {
    const r = npmrcDiagnostics(
      [
        "registry=https://registry.example.com/",
        "@acme:registry = https://npm.pkg.github.com",
        "  @other:registry=https://REGISTRY.EXAMPLE.com/npm/",
        "save-exact=true",
      ].join("\n"),
    );
    expect(r).toEqual({
      blocked: true,
      hosts: ["registry.example.com", "npm.pkg.github.com"],
    });
  });

  it("registry.npmjs.org と npm.flatt.tech（Takumi Guard）は警告しない", () => {
    expect(
      npmrcDiagnostics(
        [
          "registry=https://registry.npmjs.org/",
          "@acme:registry=https://npm.flatt.tech/",
          "registry=https://npm.flatt.tech",
        ].join("\n"),
      ),
    ).toEqual({ blocked: false, hosts: [] });
  });

  it("コメント・_authToken の行・ほかの設定は見ない", () => {
    expect(
      npmrcDiagnostics(
        [
          "# registry=https://commented.example.com/",
          "; registry=https://commented2.example.com/",
          "//registry.example.com/:_authToken=npm_SECRETSECRETSECRET",
          "//registry.example.com/:always-auth=true",
          "strict-ssl=false",
        ].join("\n"),
      ),
    ).toEqual({ blocked: false, hosts: [] });
  });

  it("http（https でない）のレジストリは、npmjs でも許可されないので警告する", () => {
    expect(npmrcDiagnostics("registry=http://registry.npmjs.org/")).toEqual({
      blocked: true,
      hosts: ["registry.npmjs.org"],
    });
  });

  it("ホスト名として検証できない値（環境変数・壊れた URL）は警告するが、hosts には入れない", () => {
    const r = npmrcDiagnostics(
      // biome-ignore lint/suspicious/noTemplateCurlyInString: .npmrc の環境変数の書き方をそのまま試す
      ["registry=${NPM_REGISTRY_URL}", "@x:registry=not a url ghp_SECRET"].join("\n"),
    );
    expect(r.blocked).toBe(true);
    expect(r.hosts).toEqual([]);
  });

  it("hosts は重複を除いて最大 5 件", () => {
    const lines = Array.from({ length: 8 }, (_, i) => `@s${i}:registry=https://r${i}.example.com/`);
    lines.push("registry=https://r0.example.com/");
    const r = npmrcDiagnostics(lines.join("\n"));
    expect(r.hosts).toEqual([
      "r0.example.com",
      "r1.example.com",
      "r2.example.com",
      "r3.example.com",
      "r4.example.com",
    ]);
  });

  it("引用符で囲んだ値・CRLF も読める", () => {
    expect(npmrcDiagnostics('registry="https://q.example.com/"\r\n').hosts).toEqual([
      "q.example.com",
    ]);
  });
});

describe("miseGoVersion", () => {
  it("[tools] の go を読む（引用符・コメント・インラインテーブル・配列）", () => {
    expect(miseGoVersion('[tools]\ngo = "1.22.3"\n')).toBe("1.22.3");
    expect(miseGoVersion("[tools]\nnode = '24'\ngo = '1.26' # pinned\n")).toBe("1.26");
    expect(miseGoVersion('[tools]\n"go" = "1.21"\n')).toBe("1.21");
    expect(miseGoVersion('[tools]\ngo = { version = "1.20" }\n')).toBe("1.20");
    expect(miseGoVersion('[tools]\ngo = ["1.19", "1.26"]\n')).toBe("1.19");
    expect(miseGoVersion('tools.go = "1.18"\n')).toBe("1.18");
  });

  it("[tools] 以外の go・go が無いものは undefined", () => {
    expect(miseGoVersion('[env]\ngo = "1.22"\n')).toBeUndefined();
    expect(miseGoVersion('[tools]\nnode = "24"\n[tasks.go]\nrun = "go test"\n')).toBeUndefined();
    expect(miseGoVersion("")).toBeUndefined();
    expect(miseGoVersion("[tools]\ngolang = '1.22'\n")).toBeUndefined();
  });
});

describe("goVersionMatches", () => {
  it("焼いた版と同じ・前方一致（区切りは .）は一致", () => {
    expect(goVersionMatches("1.26.5", "1.26.5")).toBe(true);
    expect(goVersionMatches("1.26", "1.26.5")).toBe(true);
    expect(goVersionMatches("1", "1.26.5")).toBe(true);
    expect(goVersionMatches("prefix:1.26", "1.26.5")).toBe(true);
    expect(goVersionMatches("system", "1.26.5")).toBe(true);
  });

  it("違う版・途中までの数字・latest は一致しない", () => {
    expect(goVersionMatches("1.22", "1.26.5")).toBe(false);
    expect(goVersionMatches("1.2", "1.26.5")).toBe(false);
    expect(goVersionMatches("1.26.4", "1.26.5")).toBe(false);
    expect(goVersionMatches("latest", "1.26.5")).toBe(false);
  });
});

describe("repoDiagnostics", () => {
  it("何も無ければ警告も文も無い", () => {
    expect(repoDiagnostics({}, "1.26.5")).toEqual({ warnings: [], npmrcRegistryHosts: [] });
    expect(
      repoDiagnostics(
        { npmrc: "registry=https://npm.flatt.tech/\n", miseToml: '[tools]\ngo = "1.26"\n' },
        "1.26.5",
      ),
    ).toEqual({ warnings: [], npmrcRegistryHosts: [] });
  });

  it(".npmrc: 固定の警告コードを 1 回、ホスト名、ワーカーへの英語の 2 行以内", () => {
    const r = repoDiagnostics(
      {
        npmrc:
          "registry=https://a.example.com/\n@x:registry=https://b.example.com/\n//a.example.com/:_authToken=npm_TOPSECRET\n",
      },
      "1.26.5",
    );
    expect(r.warnings).toEqual([NPMRC_REGISTRY_NOT_ALLOWED]);
    expect(r.npmrcRegistryHosts).toEqual(["a.example.com", "b.example.com"]);
    const note = r.note ?? "";
    expect(note.split("\n").length).toBeLessThanOrEqual(2);
    expect(note).toMatch(/\.npmrc/);
    expect(note).toMatch(/denied/);
    expect(note).toMatch(/default npm registry/);
    expect(note).toMatch(/summary/);
    expect(note).not.toContain("TOPSECRET");
  });

  it("mise.toml の go が焼いた版と違えば mise_go_version_unavailable と、go version / toolchain の案内", () => {
    const r = repoDiagnostics({ miseToml: '[tools]\ngo = "1.22.1"\n' }, "1.26.5");
    expect(r.warnings).toEqual([MISE_GO_VERSION_UNAVAILABLE]);
    const note = r.note ?? "";
    expect(note).toContain("1.26.5");
    expect(note).toMatch(/mise install/);
    expect(note).toMatch(/mise exec/);
    expect(note).toMatch(/go version/);
    expect(note).toMatch(/toolchain/);
    expect(note).toMatch(/proxy\.golang\.org/);
  });

  it("両方あれば両方の警告（.npmrc → mise の順）", () => {
    const r = repoDiagnostics(
      { npmrc: "registry=https://a.example.com/", miseToml: "[tools]\ngo = '1.21'" },
      "1.26.5",
    );
    expect(r.warnings).toEqual([NPMRC_REGISTRY_NOT_ALLOWED, MISE_GO_VERSION_UNAVAILABLE]);
  });

  it("焼いた Go の版（GO_VERSION）は Dockerfile の ARG と同じ形", () => {
    expect(GO_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });
});
