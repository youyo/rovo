import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// docker を使う E2E（Sandbox 内では流せない。手元の docker で: IMAGE=<ビルドした workspace イメージ> vitest run）。
// 起動時の導入と同じ argv を、実イメージの /opt/venv に対して実行し、python3 から見えることを確かめる。
// 外向き通信（pypi.org）が要るので、ネットワークの無い環境では skip する。

const IMAGE = process.env.ROVO_WORKSPACE_IMAGE;
const run = IMAGE ? describe : describe.skip;

run("sandbox deps (python): uv sync --active --frozen installs into /opt/venv", () => {
  it("python3 imports the locked package; no .venv is created", () => {
    const dir = mkdtempSync(join(tmpdir(), "rovo-deps-lang-"));
    writeFileSync(
      join(dir, "pyproject.toml"),
      '[project]\nname = "demo"\nversion = "0.0.0"\nrequires-python = ">=3.13"\ndependencies = ["six"]\n',
    );
    const sh = (cmd: string) =>
      execFileSync(
        "docker",
        [
          "run",
          "--rm",
          "-v",
          `${dir}:/workspace`,
          "-w",
          "/workspace",
          IMAGE as string,
          "bash",
          "-c",
          cmd,
        ],
        { encoding: "utf8", timeout: 300_000 },
      );
    sh("uv lock");
    sh("uv sync --active --frozen");
    expect(
      sh("python3 -c 'import six; print(six.__name__)'; test ! -d .venv && echo no-venv"),
    ).toContain("no-venv");
  });
});
