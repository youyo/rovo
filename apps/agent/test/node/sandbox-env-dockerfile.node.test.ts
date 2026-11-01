import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { BASE_ENV } from "../../src/sandbox-env";

// 本番（Cloudflare Containers）の container.exec はイメージの ENV を引き継がない。
// Dockerfile の最終ステージの ENV と BASE_ENV がずれると、本番だけ go / python3 が見つからなくなる。
const DEFAULT_PATH = "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin";

/** 最終ステージ（最後の FROM 以降）の ENV を、書かれた順に解いて返す。 */
function dockerfileEnv(): Record<string, string> {
  const text = readFileSync(join(__dirname, "../../Dockerfile"), "utf8");
  const lines = text.split("\n");
  const lastFrom = lines.map((l) => /^FROM\s/i.test(l)).lastIndexOf(true);
  const stage = lines.slice(lastFrom + 1);
  const env: Record<string, string> = { PATH: DEFAULT_PATH };
  for (let i = 0; i < stage.length; i++) {
    let logical = stage[i] ?? "";
    if (!/^ENV\s/.test(logical)) continue;
    while (logical.endsWith("\\") && i + 1 < stage.length) {
      logical = `${logical.slice(0, -1)} ${stage[++i] ?? ""}`;
    }
    for (const m of logical.replace(/^ENV\s+/, "").matchAll(/([A-Z_][A-Z0-9_]*)=(\S+)/g)) {
      const [, key = "", value = ""] = m;
      env[key] = value.replace(/\$\{?PATH\}?/g, env.PATH ?? "");
    }
  }
  return env;
}

describe("BASE_ENV と Dockerfile の ENV の一致", () => {
  const env = dockerfileEnv();

  it("Dockerfile から ENV を読めている（PATH の展開を含む）", () => {
    expect(env.PATH).toBe(`/opt/venv/bin:/usr/local/go/bin:${DEFAULT_PATH}`);
    expect(Object.keys(env).length).toBeGreaterThan(15);
  });

  it.each(Object.entries(env))("%s が BASE_ENV に同じ値で入っている", (key, value) => {
    expect(BASE_ENV[key]).toBe(value);
  });

  // bash ツールは bash -lc で、/etc/profile が PATH を上書きする。profile.d で足し直す先頭の要素が BASE_ENV の PATH と一致すること。
  it("profile.d に書く PATH の先頭が BASE_ENV の PATH の先頭と一致する", () => {
    const text = readFileSync(join(__dirname, "../../Dockerfile"), "utf8");
    const m = /rovo-path\.sh/.test(text) && /export PATH="([^"]+):\$PATH"/.exec(text);
    expect(m).toBeTruthy();
    const prefix = m ? (m[1] ?? "") : "";
    expect(prefix).toBe("/opt/venv/bin:/usr/local/go/bin");
    expect(BASE_ENV.PATH).toBe(`${prefix}:${DEFAULT_PATH}`);
  });
});
