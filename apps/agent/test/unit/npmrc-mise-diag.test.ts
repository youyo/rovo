import { describe, expect, it } from "vitest";
import {
  goVersionMatches,
  isValidHostname,
  MISE_GO_VERSION_UNAVAILABLE,
  MISE_TOOL_UNAVAILABLE,
  miseGoVersion,
  miseUnavailableTools,
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

describe("miseUnavailableTools", () => {
  it("接頭辞の無い登録名（terraform・tflint・gitleaks・pnpm・uv など）は取れるとみなしてフラグしない", () => {
    const r = miseUnavailableTools(
      '[tools]\nterraform = "1.15.8"\ntflint = "0.64.0"\ngitleaks = "8"\npnpm = "10"\nuv = "latest"\n',
    );
    expect(r).toEqual({ tools: [], total: 0 });
  });

  it("node / go / python と aqua: / github: / ubi: / npm: / pipx: / go: / core: の backend はフラグしない", () => {
    const toml = [
      "[tools]",
      'node = "24"',
      'nodejs = "24"',
      'go = "1.99.0"',
      'golang = "1.26"',
      'python = { version = "3.13" }',
      '"aqua:hashicorp/terraform" = "1"',
      '"github:terraform-linters/tflint" = "0.64.0"',
      "'ubi:a/b' = \"1\"",
      '"npm:prettier" = "3"',
      '"pipx:ruff" = "latest"',
      "'go:github.com/x/y/cmd/z' = \"latest\"",
      '"core:node" = "24"',
    ].join("\n");
    expect(miseUnavailableTools(toml)).toEqual({ tools: [], total: 0 });
  });

  it("取れない backend（asdf: / vfox: / cargo: / gem: / spm: / dotnet: / conda: / http: など）をフラグする（宣言順・重複なし）", () => {
    const toml = [
      "[tools]",
      '"asdf:foo" = "1"',
      '"vfox:version-fox/vfox-bar" = "1"',
      '"cargo:ripgrep" = "14"',
      'terraform = "1.15.8"',
      '"asdf:foo" = "2"',
      '"gem:rubocop" = "1"',
      '"spm:a/b" = "1"',
    ].join("\n");
    expect(miseUnavailableTools(toml)).toEqual({
      tools: ["asdf:foo", "vfox:version-fox/vfox-bar", "cargo:ripgrep", "gem:rubocop", "spm:a/b"],
      total: 5,
    });
    expect(
      miseUnavailableTools(
        '[tools]\n"dotnet:x" = "1"\n"conda:y" = "1"\n"http:z" = { version = "1", url = "https://example.com/z" }\n',
      ).tools,
    ).toEqual(["dotnet:x", "conda:y", "http:z"]);
  });

  it("トップレベルの tools.key = ... と [tools.key] の節も読む", () => {
    expect(
      miseUnavailableTools('tools.terraform = "1"\ntools."asdf:x" = "1"\ntools.node = "24"\n')
        .tools,
    ).toEqual(["asdf:x"]);
    expect(
      miseUnavailableTools(
        '[tools.tflint]\nversion = "0.64.0"\n[tools."cargo:ripgrep"]\nversion = "14"\n',
      ).tools,
    ).toEqual(["cargo:ripgrep"]);
  });

  it("[tools] 以外の節・コメント・複数行の値の中身は見ない", () => {
    const toml = [
      "[env]",
      '"asdf:x" = "x"',
      "[tasks.build]",
      'run = "cargo:plan"',
      "[tools]",
      '# "asdf:y" = 1',
      'node = "24"',
      "[settings]",
      "experimental = true",
    ].join("\n");
    expect(miseUnavailableTools(toml)).toEqual({ tools: [], total: 0 });
  });

  it("安全な形でない名前は tools に入れず total だけ数える。最大 5 件", () => {
    const toml = [
      "[tools]",
      '"asdf:evil <b>x</b> ghp_AAAA" = "1"',
      ...["a", "b", "c", "d", "e", "f"].map((n) => `"asdf:${n}tool" = "1"`),
    ].join("\n");
    const r = miseUnavailableTools(toml);
    expect(r.tools).toEqual(["asdf:atool", "asdf:btool", "asdf:ctool", "asdf:dtool", "asdf:etool"]);
    expect(r.total).toBe(7);
  });

  it("miseGoVersion と同じファイルを読んでも go の版の読み取りは変わらない", () => {
    expect(miseGoVersion('[tools]\ngo = "1.22"\nterraform = "1"\n')).toBe("1.22");
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
    expect(repoDiagnostics({}, "1.26.5")).toEqual({
      warnings: [],
      npmrcRegistryHosts: [],
      miseUnavailableTools: [],
    });
    expect(
      repoDiagnostics(
        { npmrc: "registry=https://npm.flatt.tech/\n", miseToml: '[tools]\ngo = "1.26"\n' },
        "1.26.5",
      ),
    ).toEqual({ warnings: [], npmrcRegistryHosts: [], miseUnavailableTools: [] });
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

  it("terraform / tflint だけならフラグなし（mise が GitHub releases などから取れる）", () => {
    const r = repoDiagnostics(
      { miseToml: '[tools]\nterraform = "1.15.8"\ntflint = "0.64.0"\nnode = "24"\n' },
      "1.26.5",
    );
    expect(r).toEqual({ warnings: [], npmrcRegistryHosts: [], miseUnavailableTools: [] });
  });

  it("asdf: / cargo: など: mise_tool_unavailable と、未実行で報告する案内", () => {
    const r = repoDiagnostics(
      { miseToml: '[tools]\n"asdf:foo" = "1"\n"cargo:ripgrep" = "14"\nterraform = "1.15.8"\n' },
      "1.26.5",
    );
    expect(r.warnings).toEqual([MISE_TOOL_UNAVAILABLE]);
    expect(r.miseUnavailableTools).toEqual(["asdf:foo", "cargo:ripgrep"]);
    const note = r.note ?? "";
    // 名前を並べるのは取れない backend のものだけ（terraform は並べない）
    expect(note).toContain("cannot download in this sandbox: asdf:foo, cargo:ripgrep.");
    expect(note).toMatch(/backend/);
    expect(note).toMatch(/mise install/);
    expect(note).toMatch(/mise run/);
    expect(note).toMatch(/mise exec/);
    expect(note).toMatch(/command -v/);
    expect(note).toMatch(/not run/);
    expect(note).toMatch(/summary/);
  });

  it("node / go / python / npm: / pipx: / go: / aqua: だけならフラグなし", () => {
    const r = repoDiagnostics(
      {
        miseToml:
          '[tools]\nnode = "24"\ngo = "1.26"\npython = "3.13"\n"npm:x" = "1"\n"pipx:y" = "1"\n"go:z" = "1"\n"aqua:a/b" = "1"\n',
      },
      "1.26.5",
    );
    expect(r).toEqual({ warnings: [], npmrcRegistryHosts: [], miseUnavailableTools: [] });
  });

  it("go の版違いと asdf: が同時なら両方のコードが順に出る（npmrc → go → tool）", () => {
    const r = repoDiagnostics(
      {
        npmrc: "registry=https://a.example.com/",
        miseToml: '[tools]\ngo = "1.22.1"\n"asdf:foo" = "1"\n',
      },
      "1.26.5",
    );
    expect(r.warnings).toEqual([
      NPMRC_REGISTRY_NOT_ALLOWED,
      MISE_GO_VERSION_UNAVAILABLE,
      MISE_TOOL_UNAVAILABLE,
    ]);
    expect(r.note).toContain("asdf:foo");
    expect(r.note).toContain("1.22.1");
  });

  it("安全な形でない名前は文にも usage にも書かず、数だけ書く", () => {
    const r = repoDiagnostics(
      { miseToml: '[tools]\n"asdf:evil <b>x</b> ghp_AAAA" = "1"\n"cargo:a b" = "1"\n' },
      "1.26.5",
    );
    expect(r.warnings).toEqual([MISE_TOOL_UNAVAILABLE]);
    expect(r.miseUnavailableTools).toEqual([]);
    expect(r.note).not.toContain("ghp_");
    expect(r.note).not.toContain("<b>");
    expect(r.note).toMatch(/2 tools/);
  });

  it("6 件以上は 5 件まで名前を書き、残りは数だけ", () => {
    const toml = `[tools]\n${["a", "b", "c", "d", "e", "f", "g"].map((n) => `"asdf:${n}t" = "1"`).join("\n")}\n`;
    const r = repoDiagnostics({ miseToml: toml }, "1.26.5");
    expect(r.miseUnavailableTools).toEqual(["asdf:at", "asdf:bt", "asdf:ct", "asdf:dt", "asdf:et"]);
    expect(r.note).toContain("asdf:at, asdf:bt, asdf:ct, asdf:dt, asdf:et");
    expect(r.note).not.toContain("asdf:ft");
    expect(r.note).toMatch(/and 2 more/);
  });

  it("焼いた Go の版（GO_VERSION）は Dockerfile の ARG と同じ形", () => {
    expect(GO_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });
});
