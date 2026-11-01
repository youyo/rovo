import { describe, expect, it } from "vitest";
import {
  type DepsLangResult,
  depsLangNote,
  depsLangWarnings,
  planPython,
  pyprojectExtras,
} from "../../src/deps-lang";

const r = (status: DepsLangResult["status"], kind: DepsLangResult["kind"] = "python") => ({
  kind,
  command: "uv sync --active",
  status,
  duration_ms: 5,
});

describe("deps-lang", () => {
  it("warnings: failed / timeout だけ固定コードで出す", () => {
    expect(depsLangWarnings([r("ok"), r("skipped"), r("failed"), r("timeout", "go")])).toEqual([
      "deps_install_failed: python",
      "deps_install_timeout: go",
    ]);
  });

  it("note: 成功は 1 行、失敗は出力の末尾と ask_parent の案内。結果が無ければ無し", () => {
    expect(depsLangNote([], "")).toBeUndefined();
    expect(depsLangNote([r("ok")], "")).toContain("/opt/venv");
    const bad = depsLangNote([r("failed")], "boom") ?? "";
    expect(bad).toContain("boom");
    expect(bad).toContain("ask_parent");
    expect(bad.split("\n").length).toBeLessThanOrEqual(3);
  });

  it("pyproject の extras は dev / test だけ（表形式・ドット形式）", () => {
    expect(
      pyprojectExtras('[project.optional-dependencies]\ntest = ["a"]\ndev = ["b"]\nx = []'),
    ).toEqual(["dev", "test"]);
    expect(pyprojectExtras("[project.optional-dependencies.dev]\nfoo = 1")).toEqual(["dev"]);
    expect(pyprojectExtras("[tool.x]\ndev = 1")).toEqual([]);
  });

  it("uv.lock があれば pyproject は読まない", () => {
    const plan = planPython(["uv.lock", "pyproject.toml"], () => {
      throw new Error("read");
    });
    expect(plan).toMatchObject({ argv: ["uv", "sync", "--active", "--frozen"] });
  });
});
